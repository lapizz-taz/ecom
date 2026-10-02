import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

const KEY = 'fraud.courier_history'

/** Back-dates a fraud check (the table is append-only, so triggers are paused for the test). */
async function age(db: Db, id: string, minutes: number) {
  await asSystem(db)
  await db.query(`set local session_replication_role = replica`)
  await db.query(`update public.fraud_checks set created_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes])
  await db.query(`set local session_replication_role = origin`)
}

async function providers(db: Db): Promise<string[]> {
  await asSystem(db)
  return value<string[]>(db, `select value -> 'providers' from public.settings where key = 'fraud'`)
}

describe('courier-history API key', () => {
  it('is kept encrypted in Vault and readable only by the service role', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const secret = { api_key: 'llcg-secret-1234', base_url: 'https://fraud.example/api' }
      await asService(db)
      await db.query(`select public.integration_secret_store($1, $2, '••••1234', $3)`, [KEY, JSON.stringify(secret), owner])
      expect(await value(db, `select public.integration_secret_get($1)`, [KEY])).toEqual(secret)

      await asSystem(db)
      const row = await one<{ hint: string; secret_id: string }>(db, `select hint, secret_id from public.integration_credentials where key = $1`, [KEY])
      expect(row.hint).toBe('••••1234')
      expect(await value(db, `select count(*)::int from vault.secrets where name = $1`, [`integration:${KEY}`])).toBe(1)
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'integration.connected'`)).toBe(1)
      expect(JSON.stringify(await value(db, `select jsonb_agg(metadata) from public.audit_logs where action = 'integration.connected'`))).not.toContain('llcg-secret')

      // Staff see only whether it is connected — never the key.
      await asUser(db, owner)
      const status = await value<Record<string, { connected: boolean; hint: string }>>(db, `select public.admin_integration_status()`)
      expect(status[KEY]).toMatchObject({ connected: true, hint: '••••1234' })
      expect(JSON.stringify(status)).not.toContain('llcg-secret')
      await expectError(db, `select * from public.integration_credentials`, [], /permission denied/)
      await expectError(db, `select public.integration_secret_get($1)`, [KEY], /permission denied/)
      await expectError(db, `select public.integration_secret_store($1, '{}'::jsonb, null, $2)`, [KEY, owner], /permission denied/)

      // Reconnecting reuses the secret; disconnecting wipes it.
      await asService(db)
      await db.query(`select public.integration_secret_store($1, '{"api_key":"other-9999"}', '••••9999', $2)`, [KEY, owner])
      await asSystem(db)
      expect(await value(db, `select count(*)::int from vault.secrets where name = $1`, [`integration:${KEY}`])).toBe(1)
      await asService(db)
      await db.query(`select public.integration_secret_clear($1, $2)`, [KEY, owner])
      expect(await value(db, `select public.integration_secret_get($1)`, [KEY])).toBeNull()
      await asUser(db, owner)
      expect((await value<Record<string, { connected: boolean }>>(db, `select public.admin_integration_status()`))[KEY].connected).toBe(false)
    }))

  it('status needs settings access; anonymous visitors get nothing', () =>
    inTx(async (db) => {
      const production = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, production)
      await expectError(db, `select public.admin_integration_status()`, [], /permission|PERMISSION_DENIED/)
      await db.query(`set local role anon`)
      await expectError(db, `select public.admin_integration_status()`, [], /permission denied/)
    }))
})

describe('fraud provider switch', () => {
  it('adds and removes a provider without touching the others', () =>
    inTx(async (db) => {
      expect(await providers(db)).toEqual(['internal'])
      await asService(db)
      expect(await value(db, `select public.fraud_set_provider('courier_history', true)`)).toEqual(['courier_history', 'internal'])
      expect(await value(db, `select public.fraud_set_provider('courier_history', true)`)).toEqual(['courier_history', 'internal'])
      expect(await value(db, `select public.fraud_set_provider('courier_history', false)`)).toEqual(['internal'])
      await expectError(db, `select public.fraud_set_provider('bad name!', true)`, [], /unknown provider/)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.fraud_set_provider('courier_history', true)`, [], /permission denied/)
    }))
})

describe('checkout lookup cache', () => {
  it('reuses a failed lookup for two minutes and a good one for cache_minutes', () =>
    inTx(async (db) => {
      await asService(db)
      const failed = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01712000111', provider: 'courier_history', providers: ['internal', 'courier_history'], status: 'ERROR', error: 'timed out',
      })])
      expect((await one<{ id: string }>(db, `select id from public.recent_fraud_check('01712000111')`)).id).toBe(failed.id)

      await age(db, failed.id, 3)
      await asService(db)
      expect((await one<{ id: string | null }>(db, `select id from public.recent_fraud_check('01712000111')`)).id).toBeNull()

      const good = await one<{ id: string; receive: string }>(db, `select id, metrics ->> 'receive_rate_tier' as receive from public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01712000111', provider: 'courier_history', providers: ['internal', 'courier_history'], status: 'SUCCESS',
        provider_counts: { total: 10, delivered: 9, returned: 1 },
      })])
      expect(good.receive).toBe('GOOD')
      await age(db, good.id, 20)
      await asService(db)
      expect((await one<{ id: string }>(db, `select id from public.recent_fraud_check('01712000111')`)).id).toBe(good.id)
    }))

  it('courier history decides the tier: 9 of 10 received is good, 4 of 10 is low', () =>
    inTx(async (db) => {
      await asService(db)
      const tier = async (phone: string, delivered: number, returned: number) => value<string>(db,
        `select metrics ->> 'receive_rate_tier' from public.record_fraud_check($1)`, [JSON.stringify({
          phone, provider: 'courier_history', providers: ['courier_history'], status: 'SUCCESS',
          provider_counts: { total: delivered + returned, delivered, returned },
        })])
      expect(await tier('01712000201', 9, 1)).toBe('GOOD')
      expect(await tier('01712000202', 6, 4)).toBe('MID')
      expect(await tier('01712000203', 4, 6)).toBe('LOW')
      expect(await tier('01712000204', 0, 0)).toBe('NEW')
    }))
})

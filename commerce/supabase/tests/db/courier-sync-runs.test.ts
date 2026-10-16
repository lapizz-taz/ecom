import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function courier(db: Db) {
  await asSystem(db)
  return value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost)
    values ('Steadfast ' || substr(md5(random()::text), 1, 6), 'steadfast', true, 70) returning id`)
}
async function booked(db: Db, courierId: string, phone: string, consignment: string) {
  const p = await createProduct(db, { price: 600, stock: 5 })
  const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  return value<string>(db, `select id from public.assign_courier($1, $2, $3, 70, null, $3)`, [order.id, courierId, consignment])
}
type Run = { id: string; total: number; checked: number; changed: number; failed: number; finished_at: string | null; errors: unknown[] }

describe('courier automation', () => {
  it('logs a forced check batch by batch and closes it at the end', () =>
    inTx(async (db) => {
      const c = await courier(db)
      await booked(db, c, '01766100001', 'SF-1')
      const shipped = await booked(db, c, '01766100002', 'SF-2')
      await asSystem(db)
      await db.query(`update public.shipments set status = 'IN_TRANSIT' where id = $1`, [shipped])

      const manager = await createStaff(db, 'ADMIN')
      await asUser(db, manager)
      const all = await value<Run>(db, `select public.courier_sync_run_start('MANUAL', 'all', null)`)
      expect(all.total).toBe(2)
      const onlyShipped = await value<Run>(db, `select public.courier_sync_run_start('MANUAL', 'shipped', $1)`, [c])
      expect(onlyShipped.total).toBe(1)

      await value(db, `select public.courier_sync_run_progress($1, 1, 1, '[]'::jsonb, false)`, [all.id])
      const done = await value<Run>(db, `select public.courier_sync_run_progress($1, 0, 0, $2::jsonb, true)`,
        [all.id, JSON.stringify([{ order_number: 'X-1', courier: 'Steadfast', error: 'Consignment not found' }])])
      expect(done).toMatchObject({ checked: 1, changed: 1, failed: 1 })
      expect(done.finished_at).not.toBeNull()
      await expectError(db, `select public.courier_sync_run_progress($1, 1, 0, '[]'::jsonb, true)`, [all.id], /already finished/)

      const overview = await value<{ runs: Run[]; couriers: Array<{ id: string; active_parcels: number; shipped_parcels: number }> }>(db, `select public.courier_automation_overview()`)
      expect(overview.runs.map((r) => r.id)).toContain(all.id)
      expect(overview.couriers.find((x) => x.id === c)).toMatchObject({ active_parcels: 2, shipped_parcels: 1 })
    }))

  it('runs the scheduled check only when the store turned it on, and not more often than chosen', () =>
    inTx(async (db) => {
      await courier(db)
      const owner = await createStaff(db, 'ADMIN')
      await asService(db)
      expect(await value(db, `select public.courier_sync_due()`)).toBe(false)
      await asUser(db, owner)
      await expectError(db, `select public.courier_sync_save(true, 7)`, [], /VALIDATION/)
      await value(db, `select public.courier_sync_save(true, 60)`)
      await asService(db)
      expect(await value(db, `select public.courier_sync_due()`)).toBe(true)
      await value(db, `select public.courier_sync_run_start('SCHEDULED', 'all', null)`)
      expect(await value(db, `select public.courier_sync_due()`)).toBe(false)
    }))

  it('keeps staff without courier access out, and only the scheduler can log a scheduled run', () =>
    inTx(async (db) => {
      const caller = await createStaff(db, 'CALL')
      await asUser(db, caller)
      await expectError(db, `select public.courier_sync_run_start('MANUAL', 'all', null)`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.retry_failed_courier_webhooks()`, [], /shipments\.manage|PERMISSION/)
      await expectError(db, `select public.courier_sync_save(true, 60)`, [], /settings\.manage|PERMISSION/)
      const manager = await createStaff(db, 'ADMIN')
      await asUser(db, manager)
      await expectError(db, `select public.courier_sync_run_start('SCHEDULED', 'all', null)`, [], /PERMISSION_DENIED/)
      expect(await value(db, `select public.retry_failed_courier_webhooks()`)).toEqual({})
    }))
})

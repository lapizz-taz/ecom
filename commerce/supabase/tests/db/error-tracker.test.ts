import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

type Row = { id: number; ids: number[]; status: string; occurrences: number; businesses: number; regressed_at: string | null; trend: number[] }
type List = { total: number; rows: Row[]; stats: Record<string, number>; can: { manage: boolean } }
type Detail = {
  error: Record<string, any>; siblings: Array<{ id: number }>; samples: Array<{ log_id: number; message: string; context: Record<string, any>; old_version: boolean }>
  daily: Array<{ day: string; n: number }>; linked: Array<{ id: number; source: string }>; nearby: Array<{ id: number; seconds_apart: number }>
  history: Array<{ action: string; after: Record<string, any> }>
}

const tag = () => randomUUID().slice(0, 8)

/** A server function reporting an error for a business (as the edge functions do). */
async function serverError(db: Db, message: string, context: Record<string, unknown> = {}, merchant: string | null = MERCHANT_1, source = 'orders') {
  await asService(db, merchant)
  return Number(await value(db, `select public.log_system_event('ERROR', 'FUNCTION', $1, $2, $3)`, [source, message, JSON.stringify(context)]))
}

async function row(db: Db, id: number) {
  await asSystem(db, null)
  return (await db.query(`select * from public.system_logs where id = $1`, [id])).rows[0]
}

async function list(db: Db, staff: string, p: Record<string, unknown> = {}) {
  await asUser(db, staff, 'staff@platform.example', null)
  return value<List>(db, `select public.platform_errors($1)`, [JSON.stringify(p)])
}

async function update(db: Db, staff: string, ids: number[], p: Record<string, unknown>) {
  await asUser(db, staff, 'staff@platform.example', null)
  return value<number>(db, `select public.platform_error_update($1, $2)`, [ids, JSON.stringify(p)])
}

describe('Super Admin error tracker', () => {
  it('counts repeats on one error (ids and numbers aside), keeps their details and a count per day', () =>
    inTx(async (db) => {
      const t = tag()
      const a = await serverError(db, `insert failed for order 1016 (${t}) id 3f2c1d4e-1111-4222-8333-444455556666`, { request_id: 'r1' })
      const b = await serverError(db, `insert failed for order 1017 (${t}) id 9a8b7c6d-1111-4222-8333-444455556666`, { request_id: 'r2' })
      expect(b).toBe(a)
      const r = await row(db, a)
      expect(r).toMatchObject({ status: 'NEW', occurrences: 2, resolved_at: null })
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      await asUser(db, tech, 'staff@platform.example', null)
      const d = await value<Detail>(db, `select public.platform_error_get($1)`, [a])
      expect(d.samples.map((s) => s.context.request_id)).toEqual(['r2', 'r1'])
      expect(d.samples[1].message).toContain('1016')
      expect(d.daily).toHaveLength(30)
      expect(d.daily.at(-1)?.n).toBe(2)
      const l = await list(db, tech, { q: t })
      expect(l.rows).toHaveLength(1)
      expect(l.rows[0]).toMatchObject({ id: a, occurrences: 2, status: 'NEW' })
      expect(l.rows[0].trend).toHaveLength(14)
      expect(l.rows[0].trend.at(-1)).toBe(2)
      expect(l.can.manage).toBe(true)
    }))

  it('a fixed error that happens again comes back as New; an old tab from before the fix does not reopen it', () =>
    inTx(async (db) => {
      const t = tag()
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const id = await serverError(db, `courier rejected ${t}`)
      expect(await update(db, tech, [id], { status: 'FIXED', fixed_in: 'commit abc1234', note: 'Pathao wanted the area id', release: '2026-11-10T10:00Z+abc1234' })).toBe(1)
      expect(await row(db, id)).toMatchObject({ status: 'FIXED', fixed_in: 'commit abc1234', fixed_release: '2026-11-10T10:00Z+abc1234' })
      expect((await row(db, id)).resolved_at).not.toBeNull()

      // A browser still on the version before the fix.
      expect(await serverError(db, `courier rejected ${t}`, { release: '2026-11-09T08:00Z+0ld0000' })).toBe(id)
      expect(await row(db, id)).toMatchObject({ status: 'FIXED', old_version_hits: 1, regressions: 0 })

      // The new version (or a server function): it came back.
      expect(await serverError(db, `courier rejected ${t}`, { release: '2026-11-10T11:00Z+def5678' })).toBe(id)
      const back = await row(db, id)
      expect(back).toMatchObject({ status: 'NEW', regressions: 1, resolved_at: null, resolved_by: null, status_by: null, last_release: '2026-11-10T11:00Z+def5678' })
      expect(back.regressed_at).not.toBeNull()
      const l = await list(db, tech, { status: 'came_back', q: t })
      expect(l.rows.map((r) => r.id)).toEqual([id])
      expect(l.stats.came_back).toBeGreaterThanOrEqual(1)

      // Who changed what is kept.
      await asUser(db, tech, 'staff@platform.example', null)
      const d = await value<Detail>(db, `select public.platform_error_get($1)`, [id])
      expect(d.history[0]).toMatchObject({ action: 'health.error_updated', after: { status: 'FIXED', fixed_in: 'commit abc1234' } })
      expect(d.samples.find((s) => s.old_version)).toBeTruthy()
    }))

  it('an ignored error keeps counting quietly; the old Resolve button means Fixed', () =>
    inTx(async (db) => {
      const t = tag()
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const id = await serverError(db, `ResizeObserver loop ${t}`)
      await update(db, tech, [id], { status: 'IGNORED' })
      expect(await serverError(db, `ResizeObserver loop ${t}`)).toBe(id)
      const r = await row(db, id)
      expect(r).toMatchObject({ status: 'IGNORED', occurrences: 2 })
      expect(r.resolved_at).not.toBeNull()
      expect((await list(db, tech, { q: t })).rows).toHaveLength(0)
      expect((await list(db, tech, { q: t, status: 'ignored' })).rows).toHaveLength(1)

      const other = await serverError(db, `webhook timeout ${t}`)
      await asUser(db, tech, 'staff@platform.example', null)
      await db.query(`select public.platform_system_logs_resolve($1)`, [[other]])
      expect(await row(db, other)).toMatchObject({ status: 'FIXED' })

      // Back to New from the tracker; not while the same error is open again on another entry.
      await update(db, tech, [other], { status: 'NEW' })
      expect(await row(db, other)).toMatchObject({ status: 'NEW', resolved_at: null })
      await update(db, tech, [other], { status: 'FIXED' })
      await asSystem(db, MERCHANT_1)
      const second = Number(await value(db, `insert into public.system_logs (level, category, source, message, fingerprint)
        select level, category, source, message, fingerprint from public.system_logs where id = $1 returning id`, [other]))
      await asUser(db, tech, 'staff@platform.example', null)
      await expectError(db, `select public.platform_error_update($1, '{"status":"INVESTIGATING"}')`, [[other]], new RegExp(`already open again as #${second}`))
    }))

  it('keeps only the last 20 occurrences in full', () =>
    inTx(async (db) => {
      const t = tag()
      let id = 0
      for (let i = 0; i < 25; i++) id = await serverError(db, `sms gateway down ${t} try ${i}`, { i })
      await asSystem(db, null)
      expect(await value<number>(db, `select occurrences from public.system_logs where id = $1`, [id])).toBe(25)
      expect(await value<number>(db, `select count(*)::int from public.system_log_samples where log_id = $1`, [id])).toBe(20)
      expect(await value<number>(db, `select min((context ->> 'i')::int) from public.system_log_samples where log_id = $1`, [id])).toBe(5)
      expect(await value<number>(db, `select n from public.system_log_daily where log_id = $1`, [id])).toBe(25)
    }))

  it('shows the same error in two businesses as one, links a browser error to its server side, and finds what the person hit just before', () =>
    inTx(async (db) => {
      const t = tag()
      const m2 = await createMerchant(db)
      const a = await serverError(db, `null value in column "phone" ${t}`, { request_id: `req-${t}` })
      const b = await serverError(db, `null value in column "phone" ${t}`, {}, m2)
      expect(b).not.toBe(a)
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const l = await list(db, tech, { q: t })
      expect(l.rows).toHaveLength(1)
      expect(l.rows[0].businesses).toBe(2)
      expect([...l.rows[0].ids].sort()).toEqual([a, b].sort())

      // The person's browser saw "Something went wrong" for that request, after another error.
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      await db.query(`select public.log_client_error($1, $2)`, [`Cannot read properties of undefined ${t}`, JSON.stringify({ release: '2026-11-10T10:00Z' })])
      await db.query(`select public.log_client_error($1, $2)`, [`INTERNAL from orders/save: Something went wrong ${t}`,
        JSON.stringify({ request_id: `req-${t}`, trail: [{ t: 'nav', to: '/admin/orders/new' }] })])
      await asSystem(db, null)
      const client = Number(await value(db, `select id from public.system_logs where message like 'INTERNAL from orders/save%' and message like $1`, [`%${t}`]))
      expect(await value<string>(db, `select source from public.system_logs where id = $1`, [client])).toBe('admin-app')
      await asUser(db, tech, 'staff@platform.example', null)
      const d = await value<Detail>(db, `select public.platform_error_get($1)`, [client])
      expect(d.linked.map((x) => x.id)).toEqual([a])
      expect(d.nearby.map((x) => x.id)).toHaveLength(1)
      expect(d.samples[0].context.trail).toEqual([{ t: 'nav', to: '/admin/orders/new' }])
      const server = await value<Detail>(db, `select public.platform_error_get($1)`, [a])
      expect(server.siblings).toHaveLength(2)
      expect(server.linked.map((x) => x.id)).toEqual([client])

      // Marking the entry fixed changes it in both businesses.
      expect(await update(db, tech, l.rows[0].ids, { status: 'FIXED' })).toBe(2)
    }))

  it('Super Admin panel errors are written too, without a business', () =>
    inTx(async (db) => {
      const t = tag()
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      await asUser(db, tech, 'staff@platform.example', null)
      await db.query(`select public.log_client_error($1, '{"app":"super-admin"}')`, [`chart failed ${t}`])
      await asSystem(db, null)
      expect(await value(db, `select row_to_json(l) from (select source, merchant_id from public.system_logs where message = $1) l`, [`chart failed ${t}`]))
        .toEqual({ source: 'super-admin', merchant_id: null })
    }))

  it('only Super Admin staff with System health see it; changing needs manage; assigned staff see their businesses only', () =>
    inTx(async (db) => {
      const t = tag()
      const m2 = await createMerchant(db)
      const mine = await serverError(db, `stock sync failed ${t}`)
      await serverError(db, `stock sync failed ${t}`, {}, m2)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.platform_errors('{}')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_error_get($1)`, [mine], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select count(*) from public.system_log_samples`, [], /permission denied/)

      const viewer = await createPlatformStaff(db, 'VIEWER')
      const seen = await list(db, viewer, { q: t })
      expect(seen.can.manage).toBe(false)
      await asUser(db, viewer, 'staff@platform.example', null)
      await expectError(db, `select public.platform_error_update($1, '{"status":"FIXED"}')`, [[mine]], /PERMISSION_DENIED/)

      const assigned = await createPlatformStaff(db, 'TECHNICAL_SUPPORT', { scope: 'ASSIGNED', merchants: [m2] })
      const only = await list(db, assigned, { q: t })
      expect(only.rows).toHaveLength(1)
      expect(only.rows[0].businesses).toBe(1)
      await asUser(db, assigned, 'staff@platform.example', null)
      await expectError(db, `select public.platform_error_get($1)`, [mine], /NOT_FOUND/)
      expect(await update(db, assigned, [mine], { status: 'FIXED' })).toBe(0)
    }))
})

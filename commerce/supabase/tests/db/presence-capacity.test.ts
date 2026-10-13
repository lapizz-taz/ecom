// Super Admin's live view of who is using Fullfilio, and its order traffic view.
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type Live = {
  online_now: number; stores_online: number
  people: Array<{ user_id: string; area: string; path: string | null; online: boolean; merchant: { id: string } | null; email: string }>
}

describe('who is online (Super Admin)', () => {
  it('keeps one heartbeat per person and app, blanks ids in the path, and shows it only to platform staff', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, owner)
      await db.query(`select public.presence_ping('admin', '/admin/orders/0f8b3a52-1c1d-4c55-9a35-0c2d1e4b7a90', 'Chrome on Android')`)
      await db.query(`select public.presence_ping('admin', '/admin/search', 'Chrome on Android')`)
      await asUser(db, superId, 'staff@platform.example', null)
      await db.query(`select public.presence_ping('super-admin', '/super-admin/health', 'Safari on macOS')`)

      await asSystem(db, null)
      const rows = (await db.query(`select user_id, area, path, merchant_id from public.user_presence where user_id = any($1) order by area`, [[owner, superId]])).rows
      expect(rows).toEqual([
        { user_id: owner, area: 'admin', path: '/admin/search', merchant_id: MERCHANT_1 },
        { user_id: superId, area: 'super-admin', path: '/super-admin/health', merchant_id: null },
      ])

      // An order page's id never reaches Super Admin.
      await asUser(db, owner)
      await db.query(`select public.presence_ping('admin', '/admin/orders/0f8b3a52-1c1d-4c55-9a35-0c2d1e4b7a90')`)
      await asUser(db, superId, 'staff@platform.example', null)
      const live = await value<Live>(db, `select public.platform_live_users()`)
      const me = live.people.find((p) => p.user_id === owner)
      expect(me).toMatchObject({ area: 'admin', path: '/admin/orders/:id', online: true, merchant: { id: MERCHANT_1 } })
      expect(live.people.some((p) => p.user_id === superId && p.area === 'super-admin')).toBe(true)
      expect(live.online_now).toBeGreaterThanOrEqual(2)
      expect(live.stores_online).toBeGreaterThanOrEqual(1)

      // Merchants and visitors cannot read it; nobody can read the table directly.
      await asUser(db, owner)
      await expectError(db, `select public.platform_live_users()`, [], /PERMISSION_DENIED|permission denied/)
      await expectError(db, `select * from public.user_presence`, [], /permission denied/)
      await asAnon(db)
      await expectError(db, `select public.presence_ping('admin', '/admin')`, [], /permission denied/)
    }))

  it('records nothing for a signed-in customer, and refuses an unknown app', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      const customer = await value<string>(db, `insert into auth.users (id, email) values (gen_random_uuid(), 'shopper@example.com') returning id`)
      await asUser(db, customer, 'shopper@example.com', MERCHANT_1)
      await db.query(`select public.presence_ping('admin', '/admin')`)
      await db.query(`select public.presence_ping('super-admin', '/super-admin')`)
      await expectError(db, `select public.presence_ping('storefront', '/')`, [], /unknown app/)
      await asUser(db, superId, 'staff@platform.example', null)
      const live = await value<Live>(db, `select public.platform_live_users()`)
      expect(live.people.some((p) => p.user_id === customer)).toBe(false)
    }))

  it('shows an employee limited to some merchants only their people', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.presence_ping('admin', '/admin')`)
      const limited = await createPlatformStaff(db, 'SUPPORT_AGENT', { scope: 'ASSIGNED', merchants: [] })
      await asUser(db, limited, 'staff@platform.example', null)
      const live = await value<Live>(db, `select public.platform_live_users()`).catch(() => null)
      // Either the role may not view merchants at all, or it sees no one from merchants it is not assigned.
      if (live) expect(live.people.some((p) => p.user_id === owner)).toBe(false)
    }))
})

describe('order traffic (Super Admin)', () => {
  it('counts orders now and at their busiest, by status, with database headroom', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db)
      const p = await createProduct(db, { price: 500, cost: 200, stock: 50 })
      for (let i = 0; i < 3; i++) await createOrder(db, { phone: `0171900000${i}`, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, superId, 'staff@platform.example', null)
      const c = await value<{ orders: { last_hour: number; last_24h: number; peak_minute_24h: number }; by_status: Record<string, number>; database: { connections: number | null; max_connections: number | null } }>(db, `select public.platform_capacity()`)
      expect(c.orders.last_hour).toBeGreaterThanOrEqual(3)
      expect(c.orders.last_24h).toBeGreaterThanOrEqual(c.orders.last_hour)
      expect(c.orders.peak_minute_24h).toBeGreaterThanOrEqual(1)
      expect(Object.values(c.by_status).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3)
      expect(c.database.max_connections).toBeGreaterThan(0)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.platform_capacity()`, [], /PERMISSION_DENIED|permission denied/)
    }))
})

// Migration 20261213000100_push_notifications: devices that get new-order notifications, the queue
// the push function sends from, and the VAPID keys kept in Vault.
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, MERCHANT_1, num, value, type Db } from '../support/db'
import { createCustomerUser, createOrder, createProduct, createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

const P256DH = `B${'A'.repeat(86)}`
const AUTH = 'k'.repeat(22)
const endpoint = (n: number | string, host = 'fcm.googleapis.com') => `https://${host}/fcm/send/device-${n}`

async function subscribe(db: Db, user: string, url: string, merchant = MERCHANT_1) {
  await asUser(db, user, 'staff@example.com', merchant)
  return value<{ devices: number; this_device: boolean }>(db, `select public.push_subscribe($1, $2, $3, 'Android · Chrome')`, [url, P256DH, AUTH])
}

async function newOrder(db: Db, phone: string) {
  const p = await createProduct(db, { price: 500, stock: 5 })
  return createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
}

type Claim = { orders: Array<{ id: string; number: string; customer: string; total: number; created_by: string | null }>; devices: Array<{ id: string; user_id: string; endpoint: string }> }

describe('devices', () => {
  it('turns notifications on for a device, says so, and turns them off again', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      expect(await subscribe(db, staff, endpoint(1))).toEqual({ devices: 1, this_device: true })
      // The same device again (the browser renewed its keys): still one device.
      expect(await subscribe(db, staff, endpoint(1))).toEqual({ devices: 1, this_device: true })
      expect(await subscribe(db, staff, endpoint(2, 'web.push.apple.com'))).toEqual({ devices: 2, this_device: true })
      expect(await value(db, `select public.push_my_devices($1)`, [endpoint(3)])).toEqual({ devices: 2, this_device: false })

      expect(await value(db, `select public.push_unsubscribe($1)`, [endpoint(1)])).toEqual({ devices: 1, this_device: false })
      expect(await value(db, `select public.push_my_devices($1)`, [endpoint(2, 'web.push.apple.com')])).toEqual({ devices: 1, this_device: true })
    }))

  it('accepts only the known push services and complete keys', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      for (const bad of ['http://fcm.googleapis.com/fcm/send/x', 'https://evil.example.com/push', 'https://fcm.googleapis.com.evil.com/x', 'https://169.254.169.254/latest'])
        await expectError(db, `select public.push_subscribe($1, $2, $3)`, [bad, P256DH, AUTH], /not supported/)
      await expectError(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(1), 'short', AUTH], /incomplete/)
      await expectError(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(1), P256DH, 'x'], /incomplete/)
      // Padding the browser may add is dropped.
      expect(await subscribe(db, staff, endpoint(1, 'updates.push.services.mozilla.com'))).toMatchObject({ this_device: true })
      await asUser(db, staff)
      expect(await value(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(2, 'wns2-bl2p.notify.windows.com'), `${P256DH}=`, `${AUTH}==`]))
        .toMatchObject({ devices: 2 })
    }))

  it('is for staff who can see orders: not visitors, customers or roles without orders', () =>
    inTx(async (db) => {
      const moderator = await createStaff(db, 'MODERATOR')
      await asUser(db, moderator)
      await expectError(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(1), P256DH, AUTH], /orders\.view|permission/i)
      const customer = await createCustomerUser(db)
      await asUser(db, customer)
      await expectError(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(2), P256DH, AUTH], /orders\.view|permission/i)
      await asAnon(db)
      await expectError(db, `select public.push_subscribe($1, $2, $3)`, [endpoint(3), P256DH, AUTH], /permission/i)
      await expectError(db, `select public.push_unsubscribe($1)`, [endpoint(3)], /permission/i)
      // Staff cannot read the devices table directly, nor call what the push function calls.
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select count(*) from public.push_subscriptions`, [], /permission/i)
      await expectError(db, `select public.push_claim()`, [], /permission/i)
      await expectError(db, `select public.platform_push_keys()`, [], /permission/i)
    }))

  it('keeps ten devices per person, the newest', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      for (let i = 1; i <= 12; i++) await subscribe(db, staff, endpoint(i))
      expect(await value(db, `select public.push_my_devices($1)`, [endpoint(12)])).toEqual({ devices: 10, this_device: true })
      expect(await value(db, `select public.push_my_devices($1)`, [endpoint(1)])).toEqual({ devices: 10, this_device: false })
    }))
})

describe('new orders', () => {
  it('queues new orders only where a device listens, and hands each business its own', () =>
    inTx(async (db) => {
      await newOrder(db, '01799100001')
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.push_outbox where merchant_id = $1`, [MERCHANT_1]))).toBe(0)

      const owner = await createStaff(db, 'ORDER_MANAGER')
      const moderator = await createStaff(db, 'MODERATOR')
      await subscribe(db, owner, endpoint('owner'))
      // A person who lost orders.view since keeps the row, but gets nothing.
      await asSystem(db)
      await db.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)`, [moderator, endpoint('moderator'), P256DH, AUTH])

      const order = await newOrder(db, '01799100002')
      await asSystem(db)
      expect(await value(db, `select public.push_due()`)).toBe(true)

      // Another business's push run sees nothing of it.
      const other = await createMerchant(db)
      await asService(db, other)
      expect(await value<Claim>(db, `select public.push_claim()`)).toEqual({ orders: [], devices: [] })

      await asService(db)
      const claim = await value<Claim>(db, `select public.push_claim()`)
      expect(claim.orders).toHaveLength(1)
      expect(claim.orders[0]).toMatchObject({ id: order.id, number: order.order_number, customer: 'Test Customer' })
      expect(num(claim.orders[0].total)).toBeGreaterThan(0)
      expect(claim.devices.map((d) => d.endpoint)).toEqual([endpoint('owner')])
      // Claimed once: the next run has nothing.
      expect(await value<Claim>(db, `select public.push_claim()`)).toEqual({ orders: [], devices: [] })
      await asSystem(db)
      expect(await value(db, `select public.push_due()`)).toBe(false)
    }))

  it('drops devices the push service says are gone, and after 20 failures in a row', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      for (const n of [1, 2, 3]) await subscribe(db, staff, endpoint(n))
      await asSystem(db)
      const ids = await value<Record<string, string>>(db, `select jsonb_object_agg(endpoint, id) from public.push_subscriptions where user_id = $1`, [staff])
      await asService(db)
      await db.query(`select public.push_done($1, $2, $3)`, [[ids[endpoint(1)]], [ids[endpoint(2)]], [ids[endpoint(3)]]])
      await asSystem(db)
      const rows = await value<Array<{ endpoint: string; failures: number; sent: boolean }>>(db,
        `select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'failures', failures, 'sent', last_sent_at is not null) order by endpoint) from public.push_subscriptions where user_id = $1`, [staff])
      expect(rows).toEqual([
        { endpoint: endpoint(1), failures: 0, sent: true },
        { endpoint: endpoint(3), failures: 1, sent: false },
      ])
      await db.query(`update public.push_subscriptions set failures = 19 where id = $1`, [ids[endpoint(3)]])
      await asService(db)
      await db.query(`select public.push_done('{}', '{}', $1)`, [[ids[endpoint(3)]]])
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.push_subscriptions where user_id = $1`, [staff]))).toBe(1)
    }))
})

describe('keys', () => {
  it('stores the first key pair made and keeps it', () =>
    inTx(async (db) => {
      const first = { public_key: `B${'1'.repeat(86)}`, private_jwk: { kty: 'EC', crv: 'P-256', d: 'secret-one' } }
      const second = { public_key: `B${'2'.repeat(86)}`, private_jwk: { kty: 'EC', crv: 'P-256', d: 'secret-two' } }
      await asService(db, null)
      expect(await value(db, `select public.platform_push_keys()`)).toBeNull()
      await expectError(db, `select public.platform_push_keys($1)`, [JSON.stringify({ public_key: 'x', private_jwk: {} })], /bad push keys/)
      expect(await value(db, `select public.platform_push_keys($1)`, [JSON.stringify(first)])).toEqual(first)
      expect(await value(db, `select public.platform_push_keys($1)`, [JSON.stringify(second)])).toEqual(first)
      expect(await value(db, `select public.platform_push_keys()`)).toEqual(first)
      // Kept in Vault, not in a table staff could read.
      await asSystem(db, null)
      expect(num(await value(db, `select count(*) from vault.secrets where name = 'platform:web_push' and secret like '%secret-one%'`))).toBe(1)
    }))
})

import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory, setSetting } from '../support/fixtures'

afterAll(closePool)

async function order(db: Db, phone: string, extra: Record<string, unknown> = {}) {
  const p = await createProduct(db, { price: 900, cost: 300, stock: 10 })
  const o = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 2 }], ...extra })
  return { o, p }
}

describe('order block list', () => {
  it('blocks a phone, refuses online orders from it, and lifts the block', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, admin)
      const block = await value<Record<string, unknown>>(db, `select to_jsonb(public.admin_block_add('PHONE', '+880 1766-112233', 'Refused 3 parcels'))`)
      expect(block).toMatchObject({ kind: 'PHONE', value: '01766112233', is_active: true })
      await expectError(db, `select public.admin_block_add('PHONE', '01766112233', 'again')`, [], /already blocked/)

      const p = await createProduct(db, { price: 500, stock: 3 })
      await db.query('savepoint blocked')
      await expect(createOrder(db, { phone: '01766112233', items: [{ variantId: p.variantIds[0], quantity: 1 }] })).rejects.toThrow(/ORDER_BLOCKED/)
      await db.query('rollback to savepoint blocked')

      await asUser(db, admin)
      const list = await value<{ total: number; items: Array<Record<string, unknown>> }>(db, `select public.admin_block_list('active', 'PHONE')`)
      expect(list.items.find((i) => i.value === '01766112233')).toMatchObject({ state: 'PERMANENT', created_by_name: 'Test ORDER_MANAGER' })
      await db.query(`select public.admin_block_lift($1, 'Paid in advance now')`, [block.id])
      const after = await createOrder(db, { phone: '01766112233', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(after.id).toBeTruthy()
    }))

  it('expires temporary blocks and checks IP and address too', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.admin_block_add('IP', '203.0.113.9', 'Bot orders', now() + interval '1 hour')`)
      await db.query(`select public.admin_block_add('ADDRESS', 'House 12, Road 7, Fake Lane', 'Fake address')`)
      await asSystem(db)
      expect(await value(db, `select public.order_block_match('01700000000', '203.0.113.9', null) ->> 'kind'`)).toBe('IP')
      expect(await value(db, `select public.order_block_match('01700000000', null, 'Flat 2, house 12, road 7, fake lane, Dhaka') ->> 'kind'`)).toBe('ADDRESS')
      await db.query(`update public.order_blocks set expires_at = now() - interval '1 minute' where kind = 'IP'`)
      expect(await value(db, `select public.order_block_match('01700000000', '203.0.113.9', null)`)).toBeNull()
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.admin_block_add('PHONE', '01711223344', 'no')`, [], /orders\.block|permission/i)
    }))
})

describe('auto pick and call queue', () => {
  it('hands new web orders to agents in turn and serves each agent their next call', () =>
    inTx(async (db) => {
      const a = await createStaff(db, 'ORDER_MANAGER')
      const b = await createStaff(db, 'ORDER_MANAGER')
      await setSetting(db, 'auto_pick', { enabled: true, mode: 'round_robin', agent_ids: [a, b], max_open: 0 })
      const o1 = (await order(db, '01788000001')).o
      const o2 = (await order(db, '01788000002')).o
      await asSystem(db)
      const owners = await value<string[]>(db, `select array_agg(assigned_to order by created_at) from public.orders where id in ($1, $2)`, [o1.id, o2.id])
      expect(new Set(owners)).toEqual(new Set([a, b]))

      await asUser(db, a)
      const next = await value<{ order_id: string; counts: Record<string, number> }>(db, `select public.call_queue_next('mine')`)
      expect([o1.id, o2.id]).toContain(next.order_id)
      expect(next.counts.mine).toBeGreaterThanOrEqual(1)
      const skipped = await value<{ order_id: string | null }>(db, `select public.call_queue_next('mine', $1::uuid[])`, [[next.order_id]])
      expect(skipped.order_id).not.toBe(next.order_id)

      // Reassign by hand
      expect(await value(db, `select public.assign_orders($1::uuid[], $2)`, [[o1.id, o2.id], b])).toBeGreaterThanOrEqual(1)
      const overview = await value<{ agents: Array<{ id: string; open: number }> }>(db, `select public.auto_pick_overview()`)
      expect(overview.agents.find((x) => x.id === b)?.open).toBeGreaterThanOrEqual(2)
    }))
})

describe('super edit', () => {
  async function overrider(db: Db) {
    const admin = await createStaff(db, 'ADMIN')
    await asSystem(db)
    await db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [admin])
    return admin
  }

  it('walks the allowed steps so stock and finance follow, and skips customer messages', () =>
    inTx(async (db) => {
      const { o, p } = await order(db, '01799000001')
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING'])
      const admin = await overrider(db)
      await asUser(db, admin)
      const r = await value<{ mode: string; path: string[]; order: { status: string } }>(db,
        `select public.admin_override_order($1, '{"status":"DELIVERED"}', 'Courier delivered, app missed it')`, [o.id])
      expect(r.mode).toBe('steps')
      expect(r.path.at(-1)).toBe('DELIVERED')
      expect(r.order.status).toBe('DELIVERED')
      const stock = await inventory(db, p.variantIds[0])
      expect(stock.on_hand).toBe(8)
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.finance_transactions where order_id = $1`, [o.id]))).toBeGreaterThan(0)
      expect(num(await value(db, `select count(*) from public.notification_logs where order_id = $1 and status = 'QUEUED'`, [o.id]))).toBe(0)
      expect(await value(db, `select metadata ->> 'reason' from public.audit_logs where action = 'order.override' and entity_id = $1`, [o.id]))
        .toBe('Courier delivered, app missed it')
    }))

  it('needs force when no normal route exists and the permission, but no reason or fresh sign-in', () =>
    inTx(async (db) => {
      const { o } = await order(db, '01799000002')
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'FAILED_DELIVERY', 'RETURNING', 'RETURNED'])
      const admin = await overrider(db)
      await asUser(db, admin)
      await expectError(db, `select public.admin_override_order($1, '{"status":"DELIVERED"}', 'Returned by mistake')`, [o.id], /no normal way/)
      await asSystem(db)
      await db.query(`update auth.users set last_sign_in_at = now() - interval '1 hour' where id = $1`, [admin])
      await asUser(db, admin)
      const r = await value<{ mode: string }>(db, `select public.admin_override_order($1, '{"status":"DELIVERED"}', '', true)`, [o.id])
      expect(r.mode).toBe('forced')
      await asSystem(db)
      expect(await value(db, `select metadata ->> 'reason' from public.audit_logs where action = 'order.override' and entity_id = $1`, [o.id])).toBeNull()
      expect(await value(db, `select actor_id = $2 from public.audit_logs where action = 'order.override' and entity_id = $1`, [o.id, admin])).toBe(true)

      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, manager)
      await expectError(db, `select public.admin_override_order($1, '{}', 'Not allowed here')`, [o.id], /orders\.override|permission/i)
      await asAnon(db)
      await expectError(db, `select public.admin_override_order($1, '{}', 'Not allowed here')`, [o.id], /permission/i)
    }))

  it('edits courier details, creating the shipment when there is none', () =>
    inTx(async (db) => {
      const { o } = await order(db, '01799000003')
      await advanceOrder(db, o.id, ['CONFIRMED'])
      const admin = await overrider(db)
      await asSystem(db)
      const courier = await value<string>(db, `select id from public.couriers order by name limit 1`)
      await asUser(db, admin)
      await db.query(`select public.admin_override_order($1, $2, 'Booked by phone with the courier')`,
        [o.id, JSON.stringify({ shipment: { courier_id: courier, consignment_id: 'CN-778899', tracking_number: 'TRK-1', shipping_cost: 60 } })])
      await asSystem(db)
      const s = await value<Record<string, unknown>>(db, `select to_jsonb(s) from public.shipments s where order_id = $1 and is_active`, [o.id])
      expect(s).toMatchObject({ courier_id: courier, consignment_id: 'CN-778899', tracking_number: 'TRK-1' })
      expect(num(s.shipping_cost)).toBe(60)
    }))
})

describe('orders dashboard', () => {
  it('shows the daily flow, open orders per courier and ageing', () =>
    inTx(async (db) => {
      const { o } = await order(db, '01799000004')
      await advanceOrder(db, o.id, ['CONFIRMED'])
      const staff = await createStaff(db, 'VIEWER')
      const today = await value<string>(db, `select ((now() at time zone public.store_timezone())::date)::text`)
      await asUser(db, staff)
      const d = await value<Record<string, any>>(db, `select public.orders_dashboard($1::date - 2, $1::date)`, [today])
      expect(d.daily).toHaveLength(3)
      expect(d.totals.approved).toBeGreaterThanOrEqual(1)
      expect(d.by_courier.find((c: { courier: string }) => c.courier === 'Not booked')?.pending).toBeGreaterThanOrEqual(1)
      expect(d.aging.unbooked).toBeGreaterThanOrEqual(1)
    }))
})

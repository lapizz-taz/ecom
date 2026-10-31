import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createCustomerUser, createOrder, createProduct, createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

interface Board {
  total: number
  value: number
  counts: Array<{ key: string; n: number; value: number }>
  items: Array<{
    id: string; status_key: string; status: string; courier_payment: string; taken_by: string | null; items: string
    courier: { name: string; number: string } | null; courier_paid: { amount: number; statement: string | null }
  }>
}

const board = (db: Db, filters: Record<string, unknown>, limit = 50, offset = 0) =>
  value<Board>(db, `select public.orders_board($1::jsonb, $2, $3)`, [JSON.stringify(filters), limit, offset])

/** Four orders of one product: a web order, a web order nobody answered, an approved one and a delivered one. */
async function shop(db: Db) {
  const tag = Math.random().toString(36).slice(2, 8)
  const lamp = await createProduct(db, { name: `Board Lamp ${tag}`, price: 500, stock: 20 })
  const line = [{ variantId: lamp.variantIds[0], quantity: 1 }]
  const web = await createOrder(db, { phone: '01711000901', items: line })
  const silent = await createOrder(db, { phone: '01711000902', items: line })
  const approved = await createOrder(db, { phone: '01711000903', items: line })
  const delivered = await createOrder(db, { phone: '01711000904', items: line, district: 'Chattogram' })
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost)
    values ('Board Courier ' || $1, 'pathao', true, 70) returning id`, [tag])
  await advanceOrder(db, approved.id, ['CONFIRMED'])
  await advanceOrder(db, delivered.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  await db.query(`select public.assign_courier($1, $2, $3, 70, null, $3)`, [delivered.id, courier, `DLB${tag}`])
  await advanceOrder(db, delivered.id, ['SHIPPED', 'DELIVERED'])
  const caller = await createStaff(db, 'ORDER_MANAGER')
  await asUser(db, caller)
  await db.query(`select public.set_web_order_status($1, 'NO_RESPONSE')`, [[silent.id]])
  return { product: `Board Lamp ${tag}`, tag, courier, caller, web, silent, approved, delivered }
}

const ids = (b: Board) => b.items.map((o) => o.id).sort()

describe('orders dashboard: every order with its status now', () => {
  it('lists web and approved orders with the status each has, and counts every status', () =>
    inTx(async (db) => {
      const s = await shop(db)
      const all = await board(db, { product: s.product })
      expect(all.total).toBe(4)
      expect(all.value).toBe(all.items.reduce((sum, o) => sum + Number((o as unknown as { total_amount: number }).total_amount), 0))
      const key = (id: string) => all.items.find((o) => o.id === id)?.status_key
      expect(key(s.web.id)).toBe('WEB:PROCESSING')
      expect(key(s.silent.id)).toBe('WEB:NO_RESPONSE')
      expect(key(s.approved.id)).toBe('PENDING')
      expect(key(s.delivered.id)).toBe('DELIVERED')
      expect(Object.fromEntries(all.counts.map((c) => [c.key, c.n]))).toEqual({ 'WEB:PROCESSING': 1, 'WEB:NO_RESPONSE': 1, PENDING: 1, DELIVERED: 1 })

      const row = all.items.find((o) => o.id === s.delivered.id)!
      expect(row.courier).toMatchObject({ number: `DLB${s.tag}` })
      expect(row.items).toContain(s.product)
      expect(all.items.find((o) => o.id === s.silent.id)?.taken_by).toBe('Test ORDER_MANAGER')

      // The status filter narrows the list; the counts still show every status.
      const done = await board(db, { product: s.product, statuses: ['DELIVERED'] })
      expect(ids(done)).toEqual([s.delivered.id])
      expect(done.counts).toHaveLength(4)
      expect(ids(await board(db, { product: s.product, statuses: ['WEB'] }))).toEqual([s.web.id, s.silent.id].sort())
      expect(ids(await board(db, { product: s.product, statuses: ['WEB:NO_RESPONSE', 'PENDING'] }))).toEqual([s.silent.id, s.approved.id].sort())

      // Pages.
      const first = await board(db, { product: s.product }, 3, 0)
      const rest = await board(db, { product: s.product }, 3, 3)
      expect(first.items).toHaveLength(3)
      expect(rest.items).toHaveLength(1)
      expect(new Set([...first.items, ...rest.items].map((o) => o.id)).size).toBe(4)
    }))

  it('filters by approval date and time, courier, invoice, district and who took the order', () =>
    inTx(async (db) => {
      const s = await shop(db)
      await asSystem(db)
      const today = await value<string>(db, `select (now() at time zone public.store_timezone())::date::text`)
      const minute = Number(await value(db, `select extract(hour from now() at time zone public.store_timezone()) * 60 + extract(minute from now() at time zone public.store_timezone())`))
      await asUser(db, s.caller)
      const f =(extra: Record<string, unknown>) => board(db, { product: s.product, ...extra })

      // A date range on the approval date leaves out orders that are not approved; no range keeps them.
      expect(ids(await f({ date_by: 'approved', date_from: today, date_to: today }))).toEqual([s.approved.id, s.delivered.id].sort())
      expect((await f({ date_by: 'approved' })).total).toBe(4)
      expect((await f({ date_by: 'order', date_from: today, date_to: today })).total).toBe(4)
      expect(ids(await f({ date_by: 'delivered', date_from: today, date_to: today }))).toEqual([s.delivered.id])
      expect((await f({ date_by: 'approved', date_from: '2001-01-01', date_to: '2001-01-02' })).total).toBe(0)
      // Approval time of day, also across midnight.
      expect((await f({ date_by: 'approved', time_from: minute, time_to: minute })).total).toBe(2)
      expect((await f({ date_by: 'approved', time_from: (minute + 1) % 1440, time_to: (minute + 2) % 1440 })).total).toBe(0)
      expect((await f({ date_by: 'approved', time_from: (minute + 1) % 1440, time_to: minute })).total).toBe(2)

      expect(ids(await f({ courier_id: s.courier }))).toEqual([s.delivered.id])
      expect((await f({ courier_id: 'none' })).total).toBe(3)
      expect(ids(await f({ invoice: `dlb${s.tag}` }))).toEqual([s.delivered.id])
      expect(ids(await f({ invoice: s.approved.order_number }))).toContain(s.approved.id)
      expect(ids(await f({ district: 'chattogram' }))).toEqual([s.delivered.id])
      expect(ids(await f({ taken_by: s.caller }))).toEqual([s.silent.id])
      expect((await f({ source: 'Unknown' })).total).toBe(4)
      expect((await f({ source: 'Facebook' })).total).toBe(0)
    }))

  it('shows whether the courier has paid out an order', () =>
    inTx(async (db) => {
      const s = await shop(db)
      const f = (pay: string) => board(db, { product: s.product, courier_payment: pay })
      expect(ids(await f('unpaid'))).toEqual([s.delivered.id])
      expect((await f('none')).total).toBe(3)
      expect((await f('paid')).total).toBe(0)

      // The courier's statement is marked paid: the order's cash came in.
      await asSystem(db)
      const statement = await value<string>(db, `insert into public.courier_invoices(courier_id, invoice_number, status, paid_at)
        values ($1, $2, 'PAID', now()) returning id`, [s.courier, `STMT-${s.tag}`])
      await db.query(`insert into public.courier_invoice_lines(invoice_id, line_no, consignment_id, order_id, cod_collected, match_status, settled_at)
        values ($1, 1, $2, $3, 500, 'MATCHED', now())`, [statement, `DLB${s.tag}`, s.delivered.id])
      await asUser(db, s.caller)
      const paid = await f('paid')
      expect(ids(paid)).toEqual([s.delivered.id])
      expect(paid.items[0]).toMatchObject({ courier_payment: 'paid', courier_paid: { amount: 500, statement: `STMT-${s.tag}` } })
      expect(ids(await board(db, { product: s.product, invoice: `stmt-${s.tag}` }))).toEqual([s.delivered.id])
    }))

  it('offers the filter choices and keeps every business to its own orders', () =>
    inTx(async (db) => {
      const s = await shop(db)
      const options = await value<{ couriers: Array<{ id: string }>; districts: string[]; call_statuses: Array<{ code: string }>; staff: Array<{ id: string }>; sources: string[] }>(
        db, `select public.orders_board_options()`)
      expect(options.couriers.map((c) => c.id)).toContain(s.courier)
      expect(options.districts).toEqual(expect.arrayContaining(['Chattogram', 'Dhaka']))
      expect(options.call_statuses.map((c) => c.code)).toEqual(expect.arrayContaining(['PROCESSING', 'NO_RESPONSE']))
      expect(options.staff.map((p) => p.id)).toContain(s.caller)
      expect(options.sources).toContain('Unknown')

      await expectError(db, `select public.orders_board('{"date_by":"tomorrow"}'::jsonb)`, [], /unknown date/)
      await expectError(db, `select public.orders_board('{"time_from":1440}'::jsonb)`, [], /minutes after midnight/)
      await expectError(db, `select public.orders_board('{"courier_payment":"maybe"}'::jsonb)`, [], /courier payment/)

      // Another business sees none of these orders; a customer may not look at all.
      const other = await createMerchant(db)
      await asUser(db, await createStaff(db, 'ORDER_MANAGER', undefined, other), 'm2@example.com', other)
      expect((await board(db, { product: s.product })).total).toBe(0)
      expect((await board(db, { invoice: `DLB${s.tag}` })).total).toBe(0)
      await asUser(db, await createCustomerUser(db))
      await expectError(db, `select public.orders_board('{}'::jsonb)`, [], /orders.view|permission/i)
    }))
})

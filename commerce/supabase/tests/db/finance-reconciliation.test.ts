// Money is recomputed by hand here, order by order, and the three places the business reads it
// (the profit & loss statement, the order financials page and the dashboard) must all agree with
// that hand count. Pending and cancelled orders earn nothing; a return after delivery keeps the
// sale, refunds the money and puts the goods' cost back; a partial delivery recognises the whole
// sale and books what came back as contra revenue; a lost parcel is a cost, never a sale.
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory, transition } from '../support/fixtures'

afterAll(closePool)

const TO_READY = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
type Json = Record<string, any>

const pnl = async (db: Db) => { await asSystem(db); return value<Json>(db, `select public.report_profit_loss(current_date - 1, current_date + 1)`) }
const fin = async (db: Db) => { await asSystem(db); return value<Json>(db, `select public.report_order_financials(current_date - 1, current_date + 1, 'delivered')`) }
const dash = async (db: Db) => { await asSystem(db); return value<Json>(db, `select public.dashboard_overview(current_date - 1, current_date + 1)`) }
const delta = (after: Json, before: Json, k: string) => num(after[k]) - num(before[k])

/** The ledger rows of one order that count for profit, as sorted "CODE amount" strings, so a whole order can be compared at once. */
async function ledger(db: Db, orderId: string): Promise<string[]> {
  await asSystem(db)
  return value<string[]>(db, `select coalesce(array_agg(c.code || ' ' || ft.amount::text order by (c.code || ' ' || ft.amount::text) collate "C"), '{}')::text[]
    from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
    where ft.order_id = $1 and c.pnl_group <> 'NONE'`, [orderId])
}
const rows = (...r: string[]) => [...r].sort()

async function items(db: Db, orderId: string): Promise<Array<{ id: string; quantity: number }>> {
  await asSystem(db)
  const r = await db.query(`select id, quantity from public.order_items where order_id = $1 order by created_at`, [orderId])
  return r.rows
}

/**
 * Seven orders, one of every money-relevant outcome. Zone charge 120, courier 80, return charge 60.
 *   X = 1,000 (cost 400)   Y = 500 (cost 200)
 *   A  1×X delivered
 *   B  1×X confirmed, waiting                     → nothing earned
 *   C  1×X cancelled before shipping              → nothing earned
 *   D  1×X delivered, then 1,000 refunded (delivered is final: the goods stay sold)
 *   E  2×Y partly delivered (one kept, one back to stock)
 *   F  1×X lost by the courier on its way back
 *   G  1×Y failed delivery, back to stock, never delivered
 */
async function knownOutcomes(db: Db) {
  await asSystem(db)
  const district = `rec${Math.floor(Math.random() * 1e6)}`
  await db.query(`insert into public.delivery_zones(name, districts, charge, return_charge, sort_order) values ('Reconciliation zone', $1, 120, 60, 0)`, [`{${district}}`])
  const courier = await value<string>(db, `insert into public.couriers(name, provider) values ('Reconciliation courier', 'manual') returning id`)
  const x = await createProduct(db, { price: 1000, cost: 400, stock: 20 })
  const y = await createProduct(db, { price: 500, cost: 200, stock: 20 })

  const place = async (variantId: string, quantity = 1) => createOrder(db, { district, items: [{ variantId, quantity }] })
  const ship = async (orderId: string) => {
    await advanceOrder(db, orderId, TO_READY)
    await asSystem(db)
    await db.query(`select public.assign_courier($1, $2, $3, 80)`, [orderId, courier, `REC-${orderId.slice(0, 8)}`])
    await transition(db, orderId, 'SHIPPED')
  }
  const restock = (list: Array<{ id: string; quantity: number }>) => JSON.stringify(list.map((i) => ({ order_item_id: i.id, quantity: i.quantity, condition: 'RESTOCK' })))

  const a = await place(x.variantIds[0]); await ship(a.id); await transition(db, a.id, 'DELIVERED')

  const b = await place(x.variantIds[0]); await advanceOrder(db, b.id, ['FRAUD_CHECK', 'CONFIRMED'])

  const c = await place(x.variantIds[0]); await advanceOrder(db, c.id, ['FRAUD_CHECK', 'CONFIRMED']); await transition(db, c.id, 'CANCELLED', 'Customer changed their mind')

  // Delivered is final: goods never come back into stock after delivery, money can.
  const d = await place(x.variantIds[0]); await ship(d.id); await transition(db, d.id, 'DELIVERED')
  await asSystem(db)
  await db.query(`select public.record_order_payment($1, 'COD', 'COURIER_COD', 1120)`, [d.id])
  await db.query(`select public.refund_order($1, 1000, 'BKASH', 'Wrong size, customer kept it as a gift')`, [d.id])

  const e = await place(y.variantIds[0], 2); await ship(e.id)
  await asSystem(db)
  const [eItem] = await items(db, e.id)
  await db.query(`select public.record_partial_delivery($1, $2, 'Kept one')`, [e.id, JSON.stringify([{ order_item_id: eItem.id, quantity: 1 }])])
  await db.query(`select public.process_order_return($1, $2, 'One came back')`, [e.id, restock([{ id: eItem.id, quantity: 1 }])])

  const f = await place(x.variantIds[0]); await ship(f.id); await advanceOrder(db, f.id, ['RETURN_REQUESTED', 'LOST'])

  const g = await place(y.variantIds[0]); await ship(g.id); await advanceOrder(db, g.id, ['FAILED_DELIVERY', 'RETURNING'])
  await asSystem(db)
  await db.query(`select public.process_order_return($1, $2, 'Could not deliver')`, [g.id, restock(await items(db, g.id))])

  return { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, f: f.id, g: g.id, x: x.variantIds[0], y: y.variantIds[0] }
}

describe('finance reconciliation: statement, order financials and dashboard agree with a hand count', () => {
  it('posts exactly the expected ledger rows for every outcome', () =>
    inTx(async (db) => {
      const o = await knownOutcomes(db)
      expect(await ledger(db, o.a)).toEqual(rows('PRODUCT_SALES 1000.00', 'DELIVERY_CHARGES 120.00', 'COGS 400.00', 'COURIER 80.00'))
      expect(await ledger(db, o.b)).toEqual([])
      expect(await ledger(db, o.c)).toEqual([])
      expect(await ledger(db, o.d)).toEqual(rows('PRODUCT_SALES 1000.00', 'DELIVERY_CHARGES 120.00', 'COGS 400.00', 'COURIER 80.00', 'REFUNDS 1000.00'))
      expect(await ledger(db, o.e)).toEqual(rows('PRODUCT_SALES 1000.00', 'DELIVERY_CHARGES 120.00', 'COGS 400.00', 'COURIER 80.00',
        'PARTIAL_RETURNS 500.00', 'COGS -200.00', 'RETURNS 60.00'))
      expect(await ledger(db, o.f)).toEqual(rows('LOST_PARCELS 400.00'))
      expect(await ledger(db, o.g)).toEqual(rows('COURIER 80.00', 'RETURNS 60.00'))
      // Stock agrees with the money: what came back is on the shelf again, what was sold or lost is not,
      // and the waiting order still holds its unit.
      expect(await inventory(db, o.x)).toMatchObject({ on_hand: 17, reserved: 1 }) // 20 − A − D − F; B still reserved; C released
      expect(await inventory(db, o.y)).toMatchObject({ on_hand: 19, reserved: 0 }) // 20 − the one E's customer kept
    }))

  it('the statement equals the hand count: 3,360 sold, 1,500 refunded, 1,400 cost, 440 delivery, 20 profit', () =>
    inTx(async (db) => {
      const before = await pnl(db)
      await knownOutcomes(db)
      const after = await pnl(db)
      const d = (k: string) => delta(after, before, k)
      expect(d('product_revenue')).toBe(3000)
      expect(d('delivery_income')).toBe(360)
      expect(d('revenue')).toBe(3360)
      expect(d('refunds')).toBe(1500) // D's refund + the half of E that came back
      expect(d('net_revenue')).toBe(1860)
      expect(d('cogs')).toBe(1400) // A 400, D 400 (kept), E 200 kept, F 400 lost
      expect(d('gross_profit')).toBe(460)
      expect(d('operating_expenses')).toBe(440) // courier 4 × 80, returns 2 × 60
      expect(d('other_income')).toBe(0)
      expect(d('net_profit')).toBe(20)
    }))

  it('the order financials page and the dashboard read the same numbers', () =>
    inTx(async (db) => {
      const pnlBefore = await pnl(db)
      const finBefore = await fin(db)
      const dashBefore = await dash(db)
      const o = await knownOutcomes(db)
      const pnlAfter = await pnl(db)
      const finAfter = await fin(db)
      const dashAfter = await dash(db)

      const t = (k: string) => num(finAfter.totals[k]) - num(finBefore.totals[k])
      expect(t('product_sales')).toBe(3000)
      expect(t('delivery_income')).toBe(360)
      expect(t('sales')).toBe(3360)
      expect(t('refunds')).toBe(1500)
      expect(t('product_cost')).toBe(1400)
      expect(t('delivery_cost')).toBe(440)
      expect(t('profit')).toBe(20)
      expect(t('orders')).toBe(3) // A, D and E recognised a sale; B, C, F, G did not
      expect(num(finAfter.totals.profit)).toBe(num(pnlAfter.net_profit))
      expect(num(finAfter.totals.sales)).toBe(num(pnlAfter.revenue))

      // The dashboard carries the statement unchanged, and counts outcomes from the orders themselves.
      for (const k of ['revenue', 'refunds', 'net_revenue', 'cogs', 'gross_profit', 'operating_expenses', 'net_profit']) {
        expect(num(dashAfter.finance[k])).toBe(num(pnlAfter[k]))
      }
      expect(delta(dashAfter, dashBefore, 'orders')).toBe(7)
      expect(delta(dashAfter, dashBefore, 'cancelled')).toBe(1)
      expect(delta(dashAfter, dashBefore, 'delivered')).toBe(3) // A, D (refunded, still delivered), E
      expect(delta(dashAfter, dashBefore, 'returned')).toBe(0) // a refund is not a return
      expect(delta(dashAfter, dashBefore, 'failed')).toBe(1) // G; the lost parcel is neither delivered nor failed
      expect(delta(dashAfter, dashBefore, 'shipped')).toBe(5)
      await asSystem(db)
      const grossSales = await value<number>(db, `select coalesce(sum(total_amount), 0) from public.orders where id = any($1::uuid[]) and status not in ('CANCELLED', 'REJECTED_FRAUD')`,
        [[o.a, o.b, o.c, o.d, o.e, o.f, o.g]])
      expect(delta(dashAfter, dashBefore, 'gross_sales')).toBe(num(grossSales))
      expect(delta(pnlAfter, pnlBefore, 'net_profit')).toBe(20)
    }))

  it('money reports need finance.view; an order manager is refused by the database', () =>
    inTx(async (db) => {
      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, manager)
      await expectError(db, `select public.report_profit_loss(current_date - 7, current_date)`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.report_order_financials(current_date - 7, current_date, 'delivered')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.report_cash_flow(current_date - 7, current_date, 'day')`, [], /PERMISSION_DENIED/)
      const overview = await value<Json>(db, `select public.dashboard_overview(current_date - 7, current_date)`)
      expect(overview.finance).toBeUndefined()
    }))
})

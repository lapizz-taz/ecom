import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, placeOrder, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

const TO_SHIPPED = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED']
const today = new Date().toISOString().slice(0, 10)

async function pnl(db: Db): Promise<Record<string, number>> {
  await asSystem(db)
  const r = await value<Record<string, unknown>>(db, `select public.report_profit_loss(current_date - 30, current_date + 1)`)
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' ? num(v) : NaN]))
}

async function cash(db: Db): Promise<{ cash_in: number; cash_out: number }> {
  await asSystem(db)
  const r = await value<Record<string, string>>(db, `select public.report_cash_flow(current_date - 30, current_date + 1)`)
  return { cash_in: num(r.cash_in), cash_out: num(r.cash_out) }
}

/** The worked example: sold for 1,000, cost 400, delivery charge 120, courier cost 80. */
async function deliveredExample(db: Db) {
  await asSystem(db)
  await db.query(`insert into public.delivery_zones(name, districts, charge, return_charge, sort_order) values ('Test zone', '{testdistrict}', 120, 60, 0)`)
  const courierId = await value<string>(db, `insert into public.couriers(name, provider) values ('Test courier', 'manual') returning id`)
  const p = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
  const order = await createOrder(db, { district: 'TestDistrict', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP'])
  await asSystem(db)
  await db.query(`select public.assign_courier($1, $2, 'TRK-1', 80)`, [order.id, courierId])
  await advanceOrder(db, order.id, ['SHIPPED', 'DELIVERED'])
  return { order, courierId, product: p }
}

describe('profit calculation', () => {
  it('matches the worked example: revenue 1120, COGS 400, gross 720, net 640', () =>
    inTx(async (db) => {
      await deliveredExample(db)
      const r = await pnl(db)
      expect(r.product_revenue).toBe(1000)
      expect(r.delivery_income).toBe(120)
      expect(r.revenue).toBe(1120)
      expect(r.cogs).toBe(400)
      expect(r.gross_profit).toBe(720)
      expect(r.operating_expenses).toBe(80)
      expect(r.net_profit).toBe(640)
    }))

  it('posts delivery revenue only once even if an order is delivered twice', () =>
    inTx(async (db) => {
      const { order } = await deliveredExample(db)
      await advanceOrder(db, order.id, ['RETURN_REQUESTED', 'DELIVERED'])
      expect((await pnl(db)).revenue).toBe(1120)
    }))

  it('does not count an advance payment twice', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
      const order = await placeOrder(db, { phone: '01611000001', items: [{ variantId: p.variantIds[0], quantity: 1 }] },
        { total: 8, delivered: 2, failed: 6 })
      expect(order.status).toBe('ADVANCE_REQUIRED')
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'ADVANCE', 'BKASH', 80, 'TRX1')`, [order.id])
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('CONFIRMED')
      expect((await pnl(db)).revenue).toBe(0) // cash received, not yet revenue
      expect((await cash(db)).cash_in).toBe(80)

      await advanceOrder(db, order.id, ['PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
      const r = await pnl(db)
      expect(r.revenue).toBe(1080) // product 1000 + delivery 80, advance not added again
      const o = await one<Record<string, string>>(db, `select amount_paid, cod_amount, payment_status from public.orders where id = $1`, [order.id])
      expect(num(o.amount_paid)).toBe(80)
      expect(num(o.cod_amount)).toBe(1000)
      expect(o.payment_status).toBe('PARTIALLY_PAID')
    }))

  it('records COD settlement as cash without changing revenue', () =>
    inTx(async (db) => {
      const { order } = await deliveredExample(db)
      await asSystem(db)
      const shipmentId = await value<string>(db, `select id from public.shipments where order_id = $1`, [order.id])
      const result = await value<Record<string, unknown>>(db, `select public.record_cod_settlement($1, 'Payout 42')`, [[shipmentId]])
      expect(result).toMatchObject({ settled: 1, amount: 1120 })
      // Second settlement of the same parcel is a no-op.
      expect(await value<Record<string, unknown>>(db, `select public.record_cod_settlement($1)`, [[shipmentId]])).toMatchObject({ settled: 0 })
      expect((await pnl(db)).revenue).toBe(1120)
      const c = await cash(db)
      expect(c.cash_in).toBe(1120)
      expect(c.cash_out).toBe(80)
      expect(await value(db, `select payment_status from public.orders where id = $1`, [order.id])).toBe('PAID')
    }))

  it('treats refunds after delivery as contra-revenue and reverses COGS for restocked returns', () =>
    inTx(async (db) => {
      const { order } = await deliveredExample(db)
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'COD', 'COURIER_COD', 1120)`, [order.id])
      await advanceOrder(db, order.id, ['RETURN_REQUESTED', 'RETURNED'])
      await db.query(`select public.refund_order($1, 1000, 'BKASH', 'Wrong size')`, [order.id])
      const r = await pnl(db)
      expect(r.refunds).toBe(1000)
      expect(r.net_revenue).toBe(120)
      expect(r.cogs).toBe(0) // item restocked
      expect(await value(db, `select payment_status from public.orders where id = $1`, [order.id])).toBe('PARTIALLY_REFUNDED')
      await expectError(db, `select public.refund_order($1, 500, 'BKASH', 'too much')`, [order.id], /exceeds/)
    }))

  it('refunds an advance on a cancelled order without touching the P&L', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'ADVANCE', 'BKASH', 100)`, [order.id])
      await transition(db, order.id, 'CANCELLED', 'Out of area')
      await db.query(`select public.refund_order($1, 100, 'BKASH', 'Order cancelled')`, [order.id])
      const r = await pnl(db)
      expect(r.revenue).toBe(0)
      expect(r.refunds).toBe(0)
      expect(r.net_profit).toBe(0)
      expect(await cash(db)).toEqual({ cash_in: 100, cash_out: 100 })
      expect(await value(db, `select advance_resolution from public.orders where id = $1`, [order.id])).toBe('REFUNDED')
    }))

  it('can retain an advance as other income after a failed delivery', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'ADVANCE', 'BKASH', 150)`, [order.id])
      await advanceOrder(db, order.id, [...TO_SHIPPED, 'FAILED_DELIVERY', 'RETURNED'])
      await db.query(`select public.retain_order_advance($1, 'Customer refused parcel')`, [order.id])
      const r = await pnl(db)
      expect(r.other_income).toBe(150)
      expect(r.revenue).toBe(0)
      await expectError(db, `select public.refund_order($1, 150, 'BKASH', 'x')`, [order.id], /retained/)
    }))
})

describe('finance ledger', () => {
  it('records manual expenses and rejects system-only categories', () =>
    inTx(async (db) => {
      const finance = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, finance)
      const rent = await value<string>(db, `select id from public.finance_categories where code = 'RENT'`)
      const cogs = await value<string>(db, `select id from public.finance_categories where code = 'COGS'`)
      const row = await one<{ txn_number: string; amount: string }>(db, `select txn_number, amount from public.create_finance_transaction($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: rent, amount: 15000, txn_date: today, payment_channel: 'BANK_TRANSFER' })])
      expect(row.txn_number).toMatch(/^FT-/)
      await expectError(db, `select public.create_finance_transaction($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: cogs, amount: 10 })], /created automatically/)
      await expectError(db, `select public.create_finance_transaction($1)`,
        [JSON.stringify({ type: 'INCOME', category_id: rent, amount: 10 })], /expense category/)
      expect((await pnl(db)).operating_expenses).toBe(15000)
    }))

  it('corrects entries with reversals instead of edits', () =>
    inTx(async (db) => {
      await asSystem(db)
      const rent = await value<string>(db, `select id from public.finance_categories where code = 'RENT'`)
      const id = await value<string>(db, `select id from public.create_finance_transaction($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: rent, amount: 500 })])
      await expectError(db, `update public.finance_transactions set amount = 1 where id = $1`, [id], /IMMUTABLE_RECORD/)
      await db.query(`select public.reverse_finance_transaction($1, 'Entered twice')`, [id])
      expect((await pnl(db)).operating_expenses).toBe(0)
      await expectError(db, `select public.reverse_finance_transaction($1, 'again')`, [id], /already been reversed/)
    }))

  it('posts ad spend and corrections to advertising automatically', () =>
    inTx(async (db) => {
      await asSystem(db)
      const campaign = await value<string>(db, `insert into public.marketing_campaigns(platform, name) values ('META', 'Eid') returning id`)
      const spend = await value<string>(db, `insert into public.marketing_spend(campaign_id, spend_date, spend, orders, revenue)
                                             values ($1, current_date, 2000, 10, 15000) returning id`, [campaign])
      await db.query(`update public.marketing_spend set spend = 2500 where id = $1`, [spend])
      expect((await pnl(db)).operating_expenses).toBe(2500)
      const perf = await one<Record<string, string>>(db, `select roas, cpa from public.marketing_campaign_performance where campaign_id = $1`, [campaign])
      expect(num(perf.roas)).toBe(6)
      expect(num(perf.cpa)).toBe(250)
    }))

  it('keeps supplier payments out of the P&L (cost arrives as COGS on delivery)', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, cost: 400, stock: 0 })
      await asSystem(db)
      const supplierId = await value<string>(db, `insert into public.suppliers(name) values ('Maker') returning id`)
      const po = await value<{ id: string }>(db, `select to_jsonb(po) from public.admin_save_purchase_order($1) po`, [JSON.stringify({
        supplier_id: supplierId, status: 'ORDERED', items: [{ variant_id: p.variantIds[0], quantity: 5, unit_cost: 400 }],
      })])
      await db.query(`select public.record_purchase_payment($1, 2000, 'BANK_TRANSFER')`, [po.id])
      expect((await pnl(db)).net_profit).toBe(0)
      expect((await cash(db)).cash_out).toBe(2000)
      expect(await value(db, `select payment_status from public.purchase_orders where id = $1`, [po.id])).toBe('PAID')
    }))
})

describe('payment idempotency', () => {
  async function advanceOrderWithPayment(db: Db) {
    const p = await createProduct(db, { price: 1000, stock: 5 })
    const order = await placeOrder(db, { phone: '01611000099', items: [{ variantId: p.variantIds[0], quantity: 1 }] },
      { total: 8, delivered: 2, failed: 6 })
    await asService(db)
    const payment = await one<{ id: string; reference: string; amount: string }>(db,
      `select id, reference, amount from public.start_order_payment($1, $2, 'ADVANCE', 'sslcommerz')`, [order.order_number, '01611000099'])
    return { order, payment }
  }

  it('creates a payment for exactly the advance due and reuses an open attempt', () =>
    inTx(async (db) => {
      const { order, payment } = await advanceOrderWithPayment(db)
      expect(num(payment.amount)).toBe(80)
      await asService(db)
      const again = await value(db, `select id from public.start_order_payment($1, $2, 'ADVANCE', 'sslcommerz')`, [order.order_number, '01611000099'])
      expect(again).toBe(payment.id)
      await expectError(db, `select public.start_order_payment($1, '01700000000', 'ADVANCE', 'sslcommerz')`, [order.order_number], /not found/)
    }))

  it('settles a webhook once no matter how many times it is delivered', () =>
    inTx(async (db) => {
      const { order, payment } = await advanceOrderWithPayment(db)
      await asService(db)
      const confirm = (eventId: string) => value<Record<string, string>>(db,
        `select public.confirm_payment($1, 'sslcommerz', 'VAL-1', 80, $2, 'ipn', '{}'::jsonb, true)`, [payment.reference, eventId])
      expect((await confirm('evt-1')).status).toBe('succeeded')
      expect((await confirm('evt-1')).status).toBe('duplicate_event')
      expect((await confirm('evt-2')).status).toBe('already_succeeded')
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.order_payments where order_id = $1`, [order.id])).toBe(1)
      expect(await value(db, `select count(*)::int from public.finance_transactions where order_id = $1`, [order.id])).toBe(1)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('CONFIRMED')
    }))

  it('holds an underpaid confirmation for manual verification', () =>
    inTx(async (db) => {
      const { order, payment } = await advanceOrderWithPayment(db)
      await asService(db)
      const r = await value<Record<string, string>>(db,
        `select public.confirm_payment($1, 'sslcommerz', 'VAL-2', 10, 'evt-x', 'ipn', '{}'::jsonb, true)`, [payment.reference])
      expect(r.status).toBe('amount_mismatch')
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
      expect(await value(db, `select status from public.payments where id = $1`, [payment.id])).toBe('REQUIRES_VERIFICATION')
    }))

  it('never accepts a payment confirmation from a browser session', () =>
    inTx(async (db) => {
      const { payment } = await advanceOrderWithPayment(db)
      const customer = await createStaff(db, 'VIEWER')
      await asUser(db, customer)
      await expectError(db, `select public.confirm_payment($1, 'sslcommerz', 'X', 80, 'e', 'ipn', '{}'::jsonb, true)`,
        [payment.reference], /permission denied/)
    }))

  it('accepts a manual bKash TrxID once and only counts it after staff verification', () =>
    inTx(async (db) => {
      const { order } = await advanceOrderWithPayment(db)
      await asService(db)
      const submitted = await one<{ id: string; status: string }>(db,
        `select id, status from public.submit_manual_payment($1, $2, 'BKASH', '01711999999', 'abc123xyz', 80)`, [order.order_number, '01611000099'])
      expect(submitted.status).toBe('REQUIRES_VERIFICATION')
      await expectError(db, `select public.submit_manual_payment($1, $2, 'BKASH', '01711999999', 'ABC123XYZ', 80)`,
        [order.order_number, '01611000099'], /already been submitted/)
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
      const verifier = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, verifier)
      await db.query(`select public.verify_manual_payment($1, true, 'Matched statement')`, [submitted.id])
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('CONFIRMED')
      expect(num(await value(db, `select amount_paid from public.orders where id = $1`, [order.id]))).toBe(80)
    }))

  it('deduplicates staff-recorded payments by idempotency key and blocks overpayment', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`select public.record_order_payment($1, 'ADVANCE', 'CASH', 100, null, null, 'key-1')`, [order.id])
      await db.query(`select public.record_order_payment($1, 'ADVANCE', 'CASH', 100, null, null, 'key-1')`, [order.id])
      expect(num(await value(db, `select amount_paid from public.orders where id = $1`, [order.id]))).toBe(100)
      await expectError(db, `select public.record_order_payment($1, 'BALANCE', 'CASH', 1000)`, [order.id], /exceeds/)
    }))

  it('expires unpaid advance orders and releases their stock', () =>
    inTx(async (db) => {
      const { order } = await advanceOrderWithPayment(db)
      await asSystem(db)
      await db.query(`update public.orders set advance_due_at = now() - interval '1 minute' where id = $1`, [order.id])
      expect(await value(db, `select public.expire_unpaid_advance_orders()`)).toBe(1)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('CANCELLED')
      expect(await value(db, `select status from public.payments where order_id = $1`, [order.id])).toBe('CANCELLED')
    }))

  it('auto-collects COD on delivery when configured', () =>
    inTx(async (db) => {
      await setSetting(db, 'finance', { auto_collect_cod_on_delivery: true })
      const { order } = await deliveredExample(db)
      await asSystem(db)
      expect(await value(db, `select payment_status from public.orders where id = $1`, [order.id])).toBe('PAID')
      expect((await cash(db)).cash_in).toBe(1120)
    }))
})

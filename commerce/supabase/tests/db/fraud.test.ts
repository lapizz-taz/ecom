import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory, orderPayload, placeOrder, setSetting } from '../support/fixtures'

afterAll(closePool)

async function score(db: Db, metrics: Record<string, unknown>): Promise<number> {
  await asSystem(db)
  return num(await value(db, `select public.compute_risk_score($1)`, [JSON.stringify(metrics)]))
}

async function evaluate(db: Db, metrics: Record<string, unknown>, context: Record<string, unknown>) {
  await asSystem(db)
  return value<{ decision: string; advance_amount: number; advance_type: string; matched_rules: Array<{ name: string }> }>(
    db, `select public.evaluate_fraud_rules($1, $2)`, [JSON.stringify(metrics), JSON.stringify(context)])
}

describe('risk scoring', () => {
  it('gives new customers the configured neutral score', () =>
    inTx(async (db) => {
      expect(await score(db, {})).toBe(20)
      await setSetting(db, 'fraud', { new_customer_score: 35 })
      expect(await score(db, {})).toBe(35)
    }))

  it('scores bad delivery history high and rewards a clean record', () =>
    inTx(async (db) => {
      expect(await score(db, { delivered_orders: 2, failed_delivery_orders: 6 })).toBe(75)
      expect(await score(db, { delivered_orders: 1, cancelled_orders: 1 })).toBe(25)
      expect(await score(db, { delivered_orders: 10, cancelled_orders: 1 })).toBeLessThan(5)
      expect(await score(db, { delivered_orders: 10, phone_flagged: true })).toBe(90)
      expect(await score(db, { delivered_orders: 10, provider_risk_score: 70 })).toBe(70)
    }))

  it('maps scores to configurable risk levels', () =>
    inTx(async (db) => {
      await asSystem(db)
      const level = (s: number) => value(db, `select public.risk_level_for_score($1)`, [s])
      expect(await level(10)).toBe('LOW')
      expect(await level(30)).toBe('MEDIUM')
      expect(await level(65)).toBe('HIGH')
      expect(await level(80)).toBe('CRITICAL')
      await setSetting(db, 'fraud', { thresholds: { medium: 10, high: 20, critical: 95 } })
      expect(await level(15)).toBe('MEDIUM')
      expect(await level(80)).toBe('HIGH')
    }))
})

describe('fraud rule decisions', () => {
  const context = { order_value: 1500, delivery_charge: 120, return_charge: 60 }

  it('allows low risk orders', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { risk_level: 'LOW' }, context)
      expect(r.decision).toBe('ALLOW')
      expect(num(r.advance_amount)).toBe(0)
    }))

  it('requires the delivery charge in advance for high risk', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { risk_level: 'HIGH' }, context)
      expect(r.decision).toBe('ADVANCE_REQUIRED')
      expect(num(r.advance_amount)).toBe(120)
    }))

  it('sends critical risk to review with delivery + return as the suggested advance', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { risk_level: 'CRITICAL' }, context)
      expect(r.decision).toBe('REVIEW')
      expect(num(r.advance_amount)).toBe(180)
    }))

  it('picks the most severe decision and the largest advance among matched rules', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { risk_level: 'HIGH', failed_cod_orders: 3, is_new_customer: false }, context)
      expect(r.decision).toBe('ADVANCE_REQUIRED')
      expect(num(r.advance_amount)).toBe(180)
      expect(r.matched_rules.map((m) => m.name)).toEqual(expect.arrayContaining(['High risk', 'Repeated failed COD']))
    }))

  it('asks new customers with large orders for a percentage advance', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { risk_level: 'LOW', is_new_customer: true }, { ...context, order_value: 6000 })
      expect(r.decision).toBe('ADVANCE_REQUIRED')
      expect(num(r.advance_amount)).toBe(1200)
    }))

  it('supports custom rules on location and order value', () =>
    inTx(async (db) => {
      await asSystem(db)
      await db.query(`select public.admin_save_fraud_rule($1)`, [JSON.stringify({
        name: 'Risky districts', priority: 5,
        conditions: [{ field: 'district', op: 'in', value: ['Narayanganj', 'Cumilla'] }, { field: 'order_value', op: 'gt', value: 1000 }],
        actions: [{ decision: 'ADVANCE_REQUIRED', advance_type: 'FIXED', advance_value: 250 }],
      })])
      expect((await evaluate(db, { risk_level: 'LOW' }, { ...context, district: 'cumilla' })).advance_amount).toBe(250)
      expect((await evaluate(db, { risk_level: 'LOW' }, { ...context, district: 'Dhaka' })).decision).toBe('ALLOW')
    }))

  it('validates rule conditions', () =>
    inTx(async (db) => {
      await asSystem(db)
      await expectError(db, `select public.admin_save_fraud_rule($1)`, [JSON.stringify({
        name: 'bad', conditions: [{ field: 'risk_score', op: 'between', value: 1 }], actions: [{ decision: 'ALLOW' }],
      })], /invalid rule condition/)
    }))
})

describe('checkout with risk-based advance payment', () => {
  it('passes a low-risk COD order, keeps COD and waits for approval', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      const order = await placeOrder(db, { phone: '01911000001', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(order.status).toBe('CONFIRMATION_REQUIRED')
      expect(order.requirement.mode).toBe('COD')
      expect(num(order.advance_required)).toBe(0)
      const history = await db.query(`select from_status, to_status from public.order_status_history
                                      where order_id = $1 and event = 'STATUS_CHANGED' order by created_at`, [order.id])
      expect(history.rows.map((r) => r.to_status)).toEqual(['FRAUD_CHECK', 'CONFIRMATION_REQUIRED'])
    }))

  it('requires an advance from a high-risk customer and tells them the amount, not the score', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1500 })
      const order = await placeOrder(db, { phone: '01911000002', items: [{ variantId: p.variantIds[0], quantity: 1 }] },
        { total: 8, delivered: 2, failed: 6 })
      expect(order.status).toBe('ADVANCE_REQUIRED')
      expect(num(order.advance_required)).toBe(80)
      expect(order.requirement).toMatchObject({ mode: 'ADVANCE', amount: 80 })
      expect(String(order.requirement.message)).toBe('To confirm this order, a ৳80 advance payment is required.')
      expect(JSON.stringify(order.requirement)).not.toMatch(/score|risk|rule/i)
      expect(num(order.cod_amount)).toBe(1580)
    }))

  it('sends a critical-risk order to manual review', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1500 })
      const order = await placeOrder(db, { phone: '01911000003', items: [{ variantId: p.variantIds[0], quantity: 1 }] },
        { total: 10, delivered: 0, returned: 4, failed: 6 })
      expect(order.status).toBe('FRAUD_REVIEW')
      expect(order.requirement.mode).toBe('REVIEW')
      expect(num(order.advance_required)).toBe(130) // suggested: delivery + return
    }))

  it('rejects orders from blocked customers and releases their stock', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 3 })
      const first = await createOrder(db, { phone: '01911000004', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.customers set status = 'BLOCKED' where id = $1`, [first.customer_id])
      await expectError(db, `select public.place_storefront_order($1)`,
        [JSON.stringify({ customer: { full_name: 'Blocked', phone: '01911000004' }, shipping: { address: 'Somewhere 12', district: 'Dhaka' },
          items: [{ variant_id: p.variantIds[0], quantity: 1 }] })], /ORDER_BLOCKED/)

      // A customer flagged only by fraud rules (not blocked) is rejected at the rule stage.
      await asSystem(db)
      await db.query(`select public.admin_save_fraud_rule($1)`, [JSON.stringify({
        name: 'Block test phone', priority: 1,
        conditions: [{ field: 'phone', op: 'eq', value: '01911000005' }], actions: [{ decision: 'BLOCK', stop_processing: true }],
      })])
      const order = await placeOrder(db, { phone: '01911000005', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      expect(order.status).toBe('REJECTED_FRAUD')
      expect(order.requirement.mode).toBe('BLOCKED')
      expect((await inventory(db, p.variantIds[0])).reserved).toBe(1) // only the first order still holds stock
    }))

  it('treats a failed provider call as high risk instead of passing it', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      await asService(db)
      const check = await one<{ id: string; risk_level: string; status: string }>(db,
        `select id, risk_level, status from public.record_fraud_check($1)`,
        [JSON.stringify({ phone: '01911000006', provider: 'http', status: 'ERROR', error: 'timeout' })])
      expect(check.status).toBe('ERROR')
      expect(check.risk_level).toBe('HIGH')
    }))

  it('holds an order for review when no fraud check could be recorded', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      await asService(db)
      const held = await value<Record<string, unknown>>(db, `select public.place_storefront_order($1, null)`,
        [JSON.stringify(orderPayload({ phone: '01911000007', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))])
      expect(held.status).toBe('FRAUD_REVIEW')
      expect((held.payment_requirement as Record<string, unknown>).mode).toBe('REVIEW')

      // A store that prefers to keep selling during an outage can opt in.
      await setSetting(db, 'fraud', { on_provider_error: 'ALLOW' })
      await asService(db)
      const allowed = await value<Record<string, unknown>>(db, `select public.place_storefront_order($1, null)`,
        [JSON.stringify(orderPayload({ phone: '01911000008', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))])
      expect(allowed.status).toBe('CONFIRMATION_REQUIRED')
    }))

  it('honours full online payment as the payment requirement', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      const order = await placeOrder(db, { phone: '01911000007', paymentMethod: 'FULL_PAYMENT', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(order.status).toBe('ADVANCE_REQUIRED')
      expect(order.requirement.mode).toBe('FULL')
      expect(num(order.advance_required)).toBe(1080)
      expect(num(order.cod_amount)).toBe(1080)
    }))

  it('never lets a fraud check be edited after the fact', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      const order = await placeOrder(db, { phone: '01911000008', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await expectError(db, `update public.fraud_checks set risk_score = 1 where id = $1`, [order.fraud_check_id], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.fraud_checks where id = $1`, [order.fraud_check_id], /IMMUTABLE_RECORD/)
    }))
})

describe('fraud review queue decisions', () => {
  async function reviewOrder(db: Db) {
    const p = await createProduct(db, { price: 2000 })
    return placeOrder(db, { phone: '01911000100', items: [{ variantId: p.variantIds[0], quantity: 1 }] },
      { total: 10, delivered: 0, returned: 4, failed: 6 })
  }

  it('approve confirms the order and records the decision', () =>
    inTx(async (db) => {
      const order = await reviewOrder(db)
      const reviewer = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, reviewer)
      const updated = await one<{ status: string; fraud_status: string; advance_required: string }>(db,
        `select status, fraud_status, advance_required from public.fraud_review_decide($1, 'APPROVE', null, 'Called customer, genuine')`, [order.id])
      expect(updated).toMatchObject({ status: 'CONFIRMED', fraud_status: 'APPROVED' })
      expect(num(updated.advance_required)).toBe(0)
      await asSystem(db)
      const review = await one<{ action: string; decided_by: string }>(db, `select action, decided_by from public.fraud_reviews where order_id = $1`, [order.id])
      expect(review).toMatchObject({ action: 'APPROVE', decided_by: reviewer })
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'fraud.review_approve' and entity_id = $1`, [order.id])).toBe(1)
    }))

  it('request advance moves the order to ADVANCE_REQUIRED with the chosen amount', () =>
    inTx(async (db) => {
      const order = await reviewOrder(db)
      await asSystem(db)
      const updated = await one<{ status: string; advance_required: string }>(db,
        `select status, advance_required from public.fraud_review_decide($1, 'REQUEST_ADVANCE', 300, null)`, [order.id])
      expect(updated.status).toBe('ADVANCE_REQUIRED')
      expect(num(updated.advance_required)).toBe(300)
      await expectError(db, `select public.fraud_review_decide($1, 'REQUEST_ADVANCE', 999999, null)`, [order.id], /between 1 and the order total/)
    }))

  it('reject rejects the order, releases stock and can block the customer', () =>
    inTx(async (db) => {
      const order = await reviewOrder(db)
      await asSystem(db)
      await db.query(`select public.fraud_review_decide($1, 'REJECT', null, 'Fake address', true)`, [order.id])
      const row = await one<{ status: string; customer_status: string }>(db,
        `select o.status, c.status as customer_status from public.orders o join public.customers c on c.id = o.customer_id where o.id = $1`, [order.id])
      expect(row).toEqual({ status: 'REJECTED_FRAUD', customer_status: 'BLOCKED' })
      expect(await value(db, `select count(*)::int from public.stock_reservations where order_id = $1 and status = 'ACTIVE'`, [order.id])).toBe(0)
    }))

  it('requires fraud.review permission', () =>
    inTx(async (db) => {
      const order = await reviewOrder(db)
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.fraud_review_decide($1, 'APPROVE')`, [order.id], /PERMISSION_DENIED/)
      await advanceOrder(db, order.id, [])
    }))
})

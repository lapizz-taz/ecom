import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createProduct, createStaff, orderPayload, setSetting } from '../support/fixtures'

// The courier rating decides, automatically, whether a checkout needs an advance:
// Good → cash on delivery; Low → advance before the order counts; no history or no
// data → the store's own policy, never "fraud" and never a silent pass.

afterAll(closePool)

const POLICY = {
  enabled: true, good_min: 80, mid_min: 50, min_parcels: 3,
  actions: { GOOD: 'COD', MID: 'ADVANCE', LOW: 'ADVANCE', NEW: 'COD', ERROR: 'REVIEW' },
  advance_type: 'FIXED', advance_amount: 150,
}
const policy = (db: Db, patch: Record<string, unknown> = {}) => setSetting(db, 'fraud', { receive_rate: { ...POLICY, ...patch } })

interface Check { id: string; status: string; decision: string; advance_amount: string; risk_level: string; metrics: Record<string, unknown> }

/** A check as the edge function records it: courier counts (or a failure) for the phone. */
async function check(db: Db, phone: string, input: Record<string, unknown> = {}, merchant?: string) {
  await asService(db, merchant)
  return one<Check>(db, `select id, status, decision, advance_amount, risk_level, metrics from public.record_fraud_check($1)`,
    [JSON.stringify({ phone, provider: 'courier_history', providers: ['internal', 'courier_history'], ...input })])
}

async function place(db: Db, phone: string, checkId: string | null, extra: Record<string, unknown> = {}) {
  const p = await createProduct(db, { price: 1000, stock: 5 })
  await asService(db)
  const placed = await value<Record<string, any>>(db, `select public.place_storefront_order($1, $2)`,
    [JSON.stringify({ ...orderPayload({ phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] }), ...extra }), checkId])
  await asSystem(db)
  const order = await one<{ id: string; order_number: string; status: string; advance_required: string; amount_paid: string; fraud_decision: string; delivery_charge: string }>(db,
    `select id, order_number, status, advance_required, amount_paid, fraud_decision, delivery_charge from public.orders where id = $1`, [placed.id])
  return { placed, order }
}

describe('courier rating → advance decision', () => {
  it('Case A: a good receiver orders with cash on delivery', () =>
    inTx(async (db) => {
      await policy(db)
      const c = await check(db, '01712000001', { provider_counts: { total: 20, delivered: 18, returned: 2 } })
      expect(c).toMatchObject({ status: 'SUCCESS', decision: 'ALLOW' })
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'GOOD', parcel_count: 20 })
      expect(num(c.metrics.receive_rate)).toBe(90)
      const { placed, order } = await place(db, '01712000001', c.id)
      expect(placed.payment_requirement).toMatchObject({ mode: 'COD', amount: 0 })
      expect(order.status).toMatch(/^(CONFIRMED|CONFIRMATION_REQUIRED)$/)
      expect(num(order.advance_required)).toBe(0)
    }))

  it('Case B: a poor receiver must pay the configured advance before the order counts', () =>
    inTx(async (db) => {
      await policy(db)
      const c = await check(db, '01712000002', { provider_counts: { total: 10, delivered: 3, returned: 7 } })
      expect(c).toMatchObject({ decision: 'ADVANCE_REQUIRED' })
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'LOW', decision_reason: 'Delivery success Low (30%)' })
      const { placed, order } = await place(db, '01712000002', c.id)
      expect(placed.payment_requirement).toMatchObject({ mode: 'ADVANCE', amount: 150 })
      expect(order).toMatchObject({ status: 'ADVANCE_REQUIRED', fraud_decision: 'ADVANCE_REQUIRED' })
      expect(num(order.advance_required)).toBe(150)
    }))

  it('uses a courier\'s own success rate when it reports only a rate (e.g. Steadfast), and the delivery charge as the advance when set', () =>
    inTx(async (db) => {
      await policy(db, { advance_type: 'DELIVERY_CHARGE' })
      // Rate-only answer: no parcel counts, a 40% rate over a "50+" volume.
      const c = await check(db, '01712000003', { provider_courier_score: 40, provider_parcel_floor: 50 })
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'LOW' })
      const { order } = await place(db, '01712000003', c.id)
      expect(order.status).toBe('ADVANCE_REQUIRED')
      expect(num(order.advance_required)).toBe(num(order.delivery_charge))
      expect(num(order.advance_required)).toBeGreaterThan(0)
    }))

  it('Case C: no history is not fraud — the store chooses (cash on delivery, or an advance)', () =>
    inTx(async (db) => {
      await policy(db)
      const c = await check(db, '01712000004', { provider_counts: {} })
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'NEW' })
      expect(c.decision).toBe('ALLOW')
      expect(c.risk_level).not.toMatch(/HIGH|CRITICAL/)
      // Fewer parcels than the minimum to judge also counts as no history.
      const few = await check(db, '01712000005', { provider_counts: { total: 2, delivered: 0, returned: 2 } })
      expect(few.metrics).toMatchObject({ receive_rate_tier: 'NEW' })

      await policy(db, { actions: { ...POLICY.actions, NEW: 'ADVANCE' } })
      const strict = await check(db, '01712000006', { provider_counts: {} })
      expect(strict).toMatchObject({ decision: 'ADVANCE_REQUIRED' })
      expect(num(strict.advance_amount)).toBe(150)
    }))

  it('one courier source failing still decides from the others (PARTIAL), never as unavailable', () =>
    inTx(async (db) => {
      await policy(db)
      const c = await check(db, '01712000007', { status: 'PARTIAL', error: 'Courier sign-ins: RedX timed out', provider_counts: { total: 12, delivered: 11, returned: 1 } })
      expect(c.status).toBe('PARTIAL')
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'GOOD' })
      expect(c.decision).toBe('ALLOW')
    }))

  it('all courier sources down: the "Check failed" action decides, the reason is kept, and the customer is not relabelled', () =>
    inTx(async (db) => {
      await policy(db)
      // A known good customer of the store (labelled LOW risk).
      await asSystem(db)
      await db.query(`insert into public.customers (full_name, phone, risk_level) values ('Rina', '01712000008', 'LOW')`)
      const c = await check(db, '01712000008', { status: 'ERROR', error: 'BD Courier: HTTP 503; Courier sign-ins: login failed (expired password)' })
      expect(c).toMatchObject({ status: 'ERROR', decision: 'REVIEW' })
      expect(c.metrics).toMatchObject({ receive_rate_tier: 'ERROR', decision_reason: 'Courier history unavailable' })
      await asSystem(db)
      expect(await value(db, `select risk_level from public.customers where phone = '01712000008'`)).toBe('LOW')
      const { order } = await place(db, '01712000008', c.id)
      expect(order.status).toBe('FRAUD_REVIEW')

      // The store can ask for the advance instead.
      await policy(db, { actions: { ...POLICY.actions, ERROR: 'ADVANCE' } })
      const again = await check(db, '01712000009', { status: 'ERROR', error: 'timeout' })
      expect(again).toMatchObject({ decision: 'ADVANCE_REQUIRED' })
    }))

  it('with the rating policy off, an unavailable check follows the provider-error policy (allow, review or advance)', () =>
    inTx(async (db) => {
      await policy(db, { enabled: false })
      await setSetting(db, 'fraud', { on_provider_error: 'ADVANCE', default_advance: { type: 'FIXED', value: 99 } })
      const c = await check(db, '01712000010', { status: 'ERROR', error: 'timeout' })
      expect(c).toMatchObject({ decision: 'ADVANCE_REQUIRED' })
      expect(num(c.advance_amount)).toBe(99)
      await setSetting(db, 'fraud', { on_provider_error: 'ALLOW' })
      expect((await check(db, '01712000011', { status: 'ERROR', error: 'timeout' })).decision).toBe('ALLOW')
    }))

  it('an order placed when no check could be recorded follows the same unavailable policy (never fails open)', () =>
    inTx(async (db) => {
      await policy(db, { actions: { ...POLICY.actions, ERROR: 'ADVANCE' } })
      const { order } = await place(db, '01712000012', null)
      expect(order.status).toBe('ADVANCE_REQUIRED')
      expect(num(order.advance_required)).toBe(150)
    }))

  it('refuses an invalid phone number', () =>
    inTx(async (db) => {
      await asService(db)
      await expectError(db, `select public.record_fraud_check('{"phone": "", "provider": "internal"}')`, [], /phone is required/)
    }))

  it('each store uses its own thresholds', () =>
    inTx(async (db) => {
      await policy(db)
      await asSystem(db, null)
      const m2 = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Strict ${randomUUID().slice(0, 6)}`])
      await asSystem(db, m2)
      await db.query(`select public._merchant_seed_defaults($1)`, [m2])
      await db.query(`update public.settings set value = value || $1::jsonb where key = 'fraud' and merchant_id = $2`, [JSON.stringify({ receive_rate: { ...POLICY, good_min: 95, mid_min: 90, advance_amount: 300 } }), m2])
      const counts = { provider_counts: { total: 20, delivered: 18, returned: 2 } } // 90%
      expect((await check(db, '01712000013', counts)).decision).toBe('ALLOW')
      const strict = await check(db, '01712000013', counts, m2)
      expect(strict).toMatchObject({ decision: 'ADVANCE_REQUIRED' })
      expect(strict.metrics).toMatchObject({ receive_rate_tier: 'MID' })
      expect(num(strict.advance_amount)).toBe(300)
    }))
})

describe('advance payment enforcement', () => {
  async function poorCustomerOrder(db: Db, phone: string) {
    await policy(db)
    const c = await check(db, phone, { provider_counts: { total: 10, delivered: 3, returned: 7 } })
    return place(db, phone, c.id)
  }

  it('pending, failed and verified payments: only a verified payment of the advance opens the order', () =>
    inTx(async (db) => {
      const { order } = await poorCustomerOrder(db, '01712000020')
      await asService(db)
      // Online gateway: the attempt is pending, a short payment is held, the full one opens it.
      const payment = await one<{ id: string; reference: string; amount: string }>(db,
        `select id, reference, amount from public.start_order_payment($1, $2, 'ADVANCE', 'sslcommerz')`, [order.order_number, '01712000020'])
      expect(num(payment.amount)).toBe(150)
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
      await asService(db)
      const failed = await value<Record<string, string>>(db,
        `select public.confirm_payment($1, 'sslcommerz', 'VAL-F', 150, 'evt-f', 'ipn', '{}'::jsonb, false)`, [payment.reference])
      expect(failed.status).not.toBe('succeeded')
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
      expect(num(await value(db, `select amount_paid from public.orders where id = $1`, [order.id]))).toBe(0)

      await asService(db)
      const retry = await one<{ reference: string }>(db,
        `select reference from public.start_order_payment($1, $2, 'ADVANCE', 'sslcommerz')`, [order.order_number, '01712000020'])
      const ok = (evt: string) => value<Record<string, string>>(db,
        `select public.confirm_payment($1, 'sslcommerz', 'VAL-OK', 150, $2, 'ipn', '{}'::jsonb, true)`, [retry.reference, evt])
      expect((await ok('evt-1')).status).toBe('succeeded')
      // Repeated callbacks settle nothing twice.
      expect((await ok('evt-1')).status).toBe('duplicate_event')
      expect((await ok('evt-2')).status).toBe('already_succeeded')
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('CONFIRMED')
      expect(num(await value(db, `select amount_paid from public.orders where id = $1`, [order.id]))).toBe(150)
      expect(await value(db, `select count(*)::int from public.order_payments where order_id = $1`, [order.id])).toBe(1)
    }))

  it('cannot be bypassed: a TrxID the customer typed, a "paid" claim or a browser confirmation do not open the order', () =>
    inTx(async (db) => {
      const { order } = await poorCustomerOrder(db, '01712000021')
      // A transaction id typed at checkout waits for staff verification.
      await asService(db)
      await db.query(`select public.submit_manual_payment($1, $2, 'BKASH', '01711999999', 'TRX12345', 150)`, [order.order_number, '01712000021'])
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')
      // A browser session cannot confirm a payment.
      await asService(db)
      const pay = await one<{ reference: string }>(db, `select reference from public.start_order_payment($1, $2, 'ADVANCE', 'sslcommerz')`, [order.order_number, '01712000021'])
      const visitor = await createStaff(db, 'VIEWER')
      await asUser(db, visitor)
      await expectError(db, `select public.confirm_payment($1, 'sslcommerz', 'X', 150, 'e', 'ipn', '{}'::jsonb, true)`, [pay.reference], /permission denied/)
      // Staff who may change statuses but not review fraud (the Call role) cannot wave it through either.
      const packer = await createStaff(db, 'CALL')
      await asUser(db, packer)
      await expectError(db, `select public.transition_order_status($1, 'CONFIRMED', 'skip advance')`, [order.id], /PERMISSION_DENIED|fraud\.review/)
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [order.id])).toBe('ADVANCE_REQUIRED')

      // Extra fields in the checkout request change nothing.
      const sneaky = await place(db, '01712000021', (await check(db, '01712000021', { provider_counts: { total: 10, delivered: 3, returned: 7 } })).id,
        { amount_paid: 150, payment_status: 'PAID', status: 'CONFIRMED', idempotency_key: randomUUID() })
      expect(sneaky.order.status).toBe('ADVANCE_REQUIRED')
      expect(num(sneaky.order.amount_paid)).toBe(0)
    }))

  it('a repeated checkout submission creates one order', () =>
    inTx(async (db) => {
      await policy(db)
      const c = await check(db, '01712000022', { provider_counts: { total: 10, delivered: 3, returned: 7 } })
      const p = await createProduct(db, { price: 1000, stock: 5 })
      const payload = JSON.stringify({ ...orderPayload({ phone: '01712000022', items: [{ variantId: p.variantIds[0], quantity: 1 }] }), idempotency_key: randomUUID() })
      await asService(db)
      const first = await value<Record<string, string>>(db, `select public.place_storefront_order($1, $2)`, [payload, c.id])
      const second = await value<Record<string, string>>(db, `select public.place_storefront_order($1, $2)`, [payload, c.id])
      expect(second.id).toBe(first.id)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.orders where customer_phone = '01712000022'`)).toBe(1)
    }))
})

describe('storefront lookups before the order is placed', () => {
  it('are limited per visitor and per store', () =>
    inTx(async (db) => {
      await setSetting(db, 'fraud', { checkout_lookups: { per_visitor: 2, per_hour: 3 } })
      const ip = '203.0.113.9'
      const hash = await value<string>(db, `select encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [ip])
      await asService(db)
      expect(await value(db, `select public.checkout_lookup_allowed($1)`, [ip])).toBe(true)
      for (const phone of ['01712000030', '01712000031']) await check(db, phone, { context: { origin: 'checkout', ip_hash: hash } })
      await asService(db)
      expect(await value(db, `select public.checkout_lookup_allowed($1)`, [ip])).toBe(false)
      expect(await value(db, `select public.checkout_lookup_allowed('198.51.100.1')`)).toBe(true)
      await check(db, '01712000032', { context: { origin: 'checkout', ip_hash: 'other' } })
      await asService(db)
      expect(await value(db, `select public.checkout_lookup_allowed('198.51.100.1')`)).toBe(false)
      // Only trusted server code may ask.
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.checkout_lookup_allowed('1.1.1.1')`, [], /permission denied|SYSTEM|not allowed/i)
    }))
})

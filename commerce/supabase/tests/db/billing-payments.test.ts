import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

// Billing & Payments, round two: buying any quantity at the platform's price,
// every payment state, the check log, refunds, and the Super Admin dashboard.

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string): Promise<{ id: string; owner: string }> {
  await as(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}` })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await as(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, owner }
}

const owner = (db: Db, m: { id: string; owner: string }) => asUser(db, m.owner, 'owner@shop.example', m.id)
const available = (db: Db, merchant: string, type: string) => value<number>(db, `select public.credit_available($1, $2)`, [merchant, type])

async function bkashOn(db: Db) {
  await asSystem(db, null)
  await db.query(`update public.platform_settings set value = jsonb_set(jsonb_set(value, '{bkash,enabled}', 'true'), '{bkash,connected}', 'true') where key = 'billing_gateways'`)
}

async function setControls(db: Db, patch: (c: Record<string, any>) => void) {
  await asSystem(db, null)
  const c = await value<Record<string, any>>(db, `select value from public.platform_settings where key = 'billing_controls'`)
  patch(c)
  await db.query(`update public.platform_settings set value = $1 where key = 'billing_controls'`, [JSON.stringify(c)])
}

type Invoice = { id: string; number: string; total: number; lines: Array<Record<string, unknown>> }
type Payment = { payment_id: string; reference: string; amount: number; purpose: string }

/** The store buys credits and starts paying with bKash; the gateway session is recorded. */
async function startPurchase(db: Db, m: { id: string; owner: string }, type: string, quantity: number, session = `PAY-${randomUUID().slice(0, 8)}`) {
  await owner(db, m)
  const inv = await value<Invoice>(db, `select public.credits_buy($1, $2)`, [type, quantity])
  await asService(db, m.id)
  const pay = await value<Payment>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id])
  await db.query(`select public.billing_gateway_payment_session($1, $2)`, [pay.payment_id, session])
  return { inv, pay, session }
}

const confirm = async (db: Db, merchant: string, reference: string, txn: string | null, amount: number | null, success: boolean, payload: Record<string, unknown> = {}) => {
  await asService(db, merchant)
  return value<{ status: string; payment_status?: string }>(db, `select public.billing_gateway_confirm($1, 'bkash', $2, $3, $4, $5)`,
    [reference, txn, amount, success, JSON.stringify(payload)])
}

const paymentRow = async (db: Db, id: string) => {
  await asSystem(db, null)
  return value<Record<string, any>>(db, `select to_jsonb(p) from public.billing_payments p where id = $1`, [id])
}

describe('billing: buy any number of SMS credits at the platform price', () => {
  it('works the total out on the server in whole poisha (৳0.36 per credit) and keeps to the limits', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await owner(db, m)
      const thousand = await value<Invoice>(db, `select public.credits_buy('SMS', 1000)`)
      expect(Number(thousand.total)).toBe(360)
      expect(thousand.lines[0]).toMatchObject({ credit_type: 'SMS', credits: 1000, quantity: 1000, custom: true })
      expect(Number((await value<Invoice>(db, `select public.credits_buy('SMS', 5000)`)).total)).toBe(1800)
      // 333 × 36 poisha = 119.88 Tk exactly, no floating point.
      expect(String(await value(db, `select (public.credits_buy('SMS', 333)) ->> 'total'`))).toBe('119.88')
      // A second click reuses the same open purchase.
      expect(await value(db, `select (public.credits_buy('SMS', 1000)) ->> 'id'`)).toBe(thousand.id)

      await expectError(db, `select public.credits_buy('SMS', 99)`, [], /between 100 and 100000/)
      await expectError(db, `select public.credits_buy('SMS', 100001)`, [], /between 100 and 100000/)
      await expectError(db, `select public.credits_buy('SMS', 0)`, [], /how many/)
      await expectError(db, `select public.credits_buy('AI', 100)`, [], /not available/)
      // Courier credits are off until the platform prices them.
      await expectError(db, `select public.credits_buy('COURIER', 100)`, [], /not available/)

      // The platform changes the price without a code change.
      await setControls(db, (c) => { c.pricing.SMS.unit_poisha = 40 })
      await owner(db, m)
      expect(Number((await value<Invoice>(db, `select public.credits_buy('SMS', 1000)`)).total)).toBe(400)
      // And can switch SMS purchases off.
      await setControls(db, (c) => { c.purposes.SMS = false })
      await owner(db, m)
      await expectError(db, `select public.credits_buy('SMS', 1000)`, [], /not available/)
    }))

  it('tops up the balance with any amount within the limits, kept in poisha', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      await owner(db, m)
      await expectError(db, `select public.credits_buy('BALANCE', 50)`, [], /between 100 and 50000/)
      const { pay } = await startPurchase(db, m, 'BALANCE', 750)
      expect(pay).toMatchObject({ amount: 750, purpose: 'BALANCE' })
      expect((await confirm(db, m.id, pay.reference, 'TRXBAL1', 750, true, { currency: 'BDT' })).status).toBe('succeeded')
      await asSystem(db, null)
      expect(await available(db, m.id, 'BALANCE')).toBe(75000)
    }))

  it('lets only the owner or settings managers buy, and refuses one payment above the limit', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const clerk = await createStaff(db, 'CALL', 'clerk@shop.example', m.id)
      await asUser(db, clerk, 'clerk@shop.example', m.id)
      await expectError(db, `select public.credits_buy('SMS', 1000)`, [], /only the owner/)

      await setControls(db, (c) => { c.max_payment_tk = 300 })
      await owner(db, m)
      await expectError(db, `select public.credits_buy('SMS', 1000)`, [], /at most 300 Tk/)
    }))
})

describe('billing: payments only count once the gateway confirms them', () => {
  it('grants the credits once, however often or however late the confirmation arrives', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const { inv, pay } = await startPurchase(db, m, 'SMS', 1000)
      expect(pay).toMatchObject({ amount: 360, purpose: 'SMS' })

      // The browser said "cancel": cancelled, nothing granted.
      expect((await confirm(db, m.id, pay.reference, null, null, false, { outcome: 'cancelled', reason: 'Cancelled on the bKash page' })).status).toBe('cancelled')
      expect((await paymentRow(db, pay.payment_id)).status).toBe('CANCELLED')
      expect(await available(db, m.id, 'SMS')).toBe(0)

      // bKash later reports it completed after all (delayed verification): the money is applied.
      expect((await confirm(db, m.id, pay.reference, 'TRX1000', 360, true, { source: 'RECONCILE', currency: 'BDT' })).status).toBe('succeeded')
      // Duplicate and retried callbacks change nothing.
      expect((await confirm(db, m.id, pay.reference, 'TRX1000', 360, true)).status).toBe('already_succeeded')
      expect((await confirm(db, m.id, pay.reference, null, null, false)).status).toBe('already_succeeded')
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(1000)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [inv.id])).toBe('PAID')
      expect(await value(db, `select count(*)::int from public.credit_ledger where merchant_id = $1 and kind = 'RECHARGE'`, [m.id])).toBe(1)
      const row = await paymentRow(db, pay.payment_id)
      expect(row).toMatchObject({ status: 'SUCCEEDED', provider_txn_id: 'TRX1000', purpose: 'SMS', needs_review: false })
      // Every check is in the log.
      const outcomes = (await db.query(`select source, outcome from public.billing_payment_checks where payment_id = $1 order by id`, [pay.payment_id])).rows
      expect(outcomes).toEqual([
        { source: 'RETURN', outcome: 'cancelled' },
        { source: 'RECONCILE', outcome: 'succeeded' },
        { source: 'RETURN', outcome: 'already_succeeded' },
        { source: 'RETURN', outcome: 'already_succeeded' },
      ])
      expect(await value(db, `select (value -> 'bkash' ->> 'last_verified_at') is not null from public.platform_settings where key = 'billing_gateways'`)).toBe(true)
    }))

  it('keeps wrong amounts, wrong currency, missing or reused transactions out, flagged for review', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const a = await startPurchase(db, m, 'SMS', 1000)
      expect((await confirm(db, m.id, a.pay.reference, 'TRXA', 36, true)).status).toBe('amount_mismatch')
      expect((await confirm(db, m.id, a.pay.reference, 'TRXA', 360, true, { currency: 'USD' })).status).toBe('currency_mismatch')
      expect((await confirm(db, m.id, a.pay.reference, null, 360, true)).status).toBe('duplicate_transaction')
      const row = await paymentRow(db, a.pay.payment_id)
      expect(row).toMatchObject({ status: 'PENDING', needs_review: true })
      expect(await available(db, m.id, 'SMS')).toBe(0)

      expect((await confirm(db, m.id, a.pay.reference, 'TRXA', 360, true)).status).toBe('succeeded')
      // The same bKash transaction cannot pay a second purchase.
      const b = await startPurchase(db, m, 'SMS', 2000)
      expect((await confirm(db, m.id, b.pay.reference, 'TRXA', 720, true)).status).toBe('duplicate_transaction')
      expect((await paymentRow(db, b.pay.payment_id)).status).toBe('PENDING')
      expect(await available(db, m.id, 'SMS')).toBe(1000)

      // Unknown references and browsers get nothing.
      expect((await confirm(db, m.id, 'BP-NOPE', 'TRXZ', 1, true)).status).toBe('unknown_payment')
      await owner(db, m)
      await expectError(db, `select public.billing_gateway_confirm($1, 'bkash', 'TRXB', 720, true, '{}')`, [b.pay.reference], /permission denied|PERMISSION_DENIED/)
    }))

  it('never moves a confirmed payment back, never changes its amount, and only verified payments succeed', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const { pay } = await startPurchase(db, m, 'SMS', 500)
      await asSystem(db, null)
      await expectError(db, `update public.billing_payments set status = 'SUCCEEDED' where id = $1`, [pay.payment_id], /succeeds only when it is verified/)
      await expectError(db, `update public.billing_payments set amount = 1 where id = $1`, [pay.payment_id], /IMMUTABLE_RECORD/)
      await confirm(db, m.id, pay.reference, 'TRXG', 180, true)
      await asSystem(db, null)
      await expectError(db, `update public.billing_payments set status = 'FAILED' where id = $1`, [pay.payment_id], /INVALID_TRANSITION/)
      await expectError(db, `update public.billing_payments set provider_txn_id = 'OTHER' where id = $1`, [pay.payment_id], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.billing_payment_checks where payment_id = $1`, [pay.payment_id], /IMMUTABLE_RECORD/)
    }))

  it('expires attempts nobody finished', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      await owner(db, m)
      const inv = await value<Invoice>(db, `select public.credits_buy('SMS', 100)`)
      await asService(db, m.id)
      const never = await value<Payment>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id])
      const fresh = await startPurchase(db, m, 'SMS', 200)
      await asSystem(db, null)
      await db.query(`alter table public.billing_payments disable trigger billing_payments_guard`)
      await db.query(`update public.billing_payments set created_at = now() - interval '2 hours' where id = $1`, [never.payment_id])
      await db.query(`alter table public.billing_payments enable trigger billing_payments_guard`)
      await asService(db, null)
      expect(await value(db, `select public.billing_gateway_expire()`)).toBe(1)
      expect((await paymentRow(db, never.payment_id)).status).toBe('EXPIRED')
      expect((await paymentRow(db, fresh.pay.payment_id)).status).toBe('PENDING')
    }))

  it('honours the purchase switches when paying invoices', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      await owner(db, m)
      const inv = await value<Invoice>(db, `select public.credits_buy('SMS', 1000)`)
      await setControls(db, (c) => { c.purposes.SMS = false })
      await asService(db, m.id)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id], /switched off/)
      await setControls(db, (c) => { c.purposes.SMS = true; c.max_payment_tk = 100 })
      await asService(db, m.id)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id], /more than one online payment/)
    }))
})

describe('billing: refunds', () => {
  async function paid(db: Db, m: { id: string; owner: string }, quantity: number) {
    const p = await startPurchase(db, m, 'SMS', quantity)
    await confirm(db, m.id, p.pay.reference, `TRX-${randomUUID().slice(0, 6)}`, Number(p.pay.amount), true)
    return p
  }

  it('refunds through the gateway, takes the bought credits back with a ledger entry, once', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const { pay } = await paid(db, m, 1000)
      await as(db, superId)
      await expectError(db, `select public.platform_billing_refund_start($1, 400, 'Customer asked', false, true)`, [pay.payment_id], /between 0.01 and 360/)
      await expectError(db, `select public.platform_billing_refund_start($1, 360, 'no', false, true)`, [pay.payment_id], /reason/)
      const started = await value<{ status: string; refund_id: string; session: string; txn: string }>(db,
        `select public.platform_billing_refund_start($1, 360, 'Bought by mistake', false, true)`, [pay.payment_id])
      expect(started).toMatchObject({ status: 'processing' })
      expect(started.session).toBeTruthy()
      expect((await paymentRow(db, pay.payment_id)).status).toBe('REFUND_PENDING')
      // A second refund cannot start while one is open.
      await as(db, superId)
      await expectError(db, `select public.platform_billing_refund_start($1, 1, 'Second refund', false, true)`, [pay.payment_id], /only a confirmed payment/)

      await asService(db, null)
      const done = await value<{ status: string; credits_reversed: number }>(db,
        `select public.billing_refund_finish($1, true, 'RFD-1', null, '{}')`, [started.refund_id])
      expect(done).toMatchObject({ status: 'succeeded', credits_reversed: 1000 })
      // Finishing again changes nothing.
      expect(await value(db, `select (public.billing_refund_finish($1, true, 'RFD-1', null, '{}')) ->> 'status'`, [started.refund_id])).toBe('succeeded')
      const row = await paymentRow(db, pay.payment_id)
      expect(row).toMatchObject({ status: 'REFUNDED', refunded_amount: 360 })
      expect(await available(db, m.id, 'SMS')).toBe(0)
      expect(await value(db, `select count(*)::int from public.credit_ledger where merchant_id = $1 and reference_type = 'billing_refund'`, [m.id])).toBe(1)
      await expectError(db, `update public.billing_payments set status = 'SUCCEEDED' where id = $1`, [pay.payment_id], /final/)
    }))

  it('flags a refund whose credits were already spent, and puts a failed gateway refund back', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const { pay } = await paid(db, m, 1000)
      // 700 of the 1,000 credits were used.
      await asSystem(db, null)
      await db.query(`select public._credit_post($1, 'SMS', -700, 'USAGE', 'Sent SMS', null, 'SYSTEM', 'test', 'x', $2)`, [m.id, randomUUID()])

      await as(db, superId)
      const failing = await value<{ refund_id: string }>(db, `select public.platform_billing_refund_start($1, 360, 'Customer asked again', false, true)`, [pay.payment_id])
      await asService(db, null)
      expect(await value(db, `select (public.billing_refund_finish($1, false, null, 'bKash refused the refund', '{}')) ->> 'status'`, [failing.refund_id])).toBe('failed')
      expect((await paymentRow(db, pay.payment_id)).status).toBe('SUCCEEDED')

      // Recorded as refunded outside Fullfilio (manual): only the 300 left come back.
      await as(db, superId)
      const manual = await value<{ status: string; credits_reversed: number; credits_short: number; manual: boolean }>(db,
        `select public.platform_billing_refund_start($1, 360, 'Refunded from the bKash panel', true, true)`, [pay.payment_id])
      expect(manual).toMatchObject({ status: 'succeeded', manual: true, credits_reversed: 300, credits_short: 700 })
      expect(await paymentRow(db, pay.payment_id)).toMatchObject({ status: 'REFUNDED', needs_review: true })
    }))

  it('is for platform staff with billing rights only', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const { pay } = await paid(db, m, 1000)
      await owner(db, m)
      await expectError(db, `select public.platform_billing_refund_start($1, 10, 'I want my money', true, true)`, [pay.payment_id], /PERMISSION_DENIED|permission/)
      await as(db, support)
      await expectError(db, `select public.platform_billing_refund_start($1, 10, 'I want my money', true, true)`, [pay.payment_id], /PERMISSION_DENIED|permission/)
      await asService(db, null)
      await expectError(db, `select public.billing_refund_finish(gen_random_uuid(), true, null, null, '{}')`, [], /NOT_FOUND/)
    }))
})

describe('billing: each store sees only its own payments; the platform sees all', () => {
  it('keeps payments, receipts and checks inside the store', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const a = await newMerchant(db, superId)
      const b = await newMerchant(db, superId)
      await bkashOn(db)
      const { pay } = await startPurchase(db, a, 'SMS', 1000)
      await confirm(db, a.id, pay.reference, 'TRX-ISO', 360, true)

      await owner(db, a)
      const mine = await value<{ payments: Array<{ id: string; status: string; purpose: string }>; pricing: { SMS: { unit_price: number } } }>(db, `select public.my_billing()`)
      expect(mine.payments.map((p) => p.id)).toEqual([pay.payment_id])
      expect(mine.payments[0]).toMatchObject({ status: 'SUCCEEDED', purpose: 'SMS' })
      expect(Number(mine.pricing.SMS.unit_price)).toBe(0.36)
      expect(await value(db, `select (public.billing_receipt($1)) -> 'payment' ->> 'transaction'`, [pay.payment_id])).toBe('TRX-ISO')

      await owner(db, b)
      expect((await value<{ payments: unknown[] }>(db, `select public.my_billing()`)).payments).toEqual([])
      await expectError(db, `select public.billing_receipt($1)`, [pay.payment_id], /NOT_FOUND/)
      expect(await value(db, `select count(*)::int from public.billing_payments where id = $1`, [pay.payment_id])).toBe(0)
      // The check log and refunds are read through the functions only.
      expect(await value(db, `select count(*)::int from public.billing_payment_checks`)).toBe(0)
      await owner(db, a)
      expect(await value(db, `select count(*)::int from public.billing_payment_checks`)).toBe(0)
      await owner(db, b)
      await expectError(db, `select public.platform_billing_dashboard('{}')`, [], /PERMISSION_DENIED|permission/)
    }))

  it('totals collected, pending and refunded money for the Super Admin, with filters', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await bkashOn(db)
      const one = await startPurchase(db, m, 'SMS', 1000)
      await confirm(db, m.id, one.pay.reference, 'TRX-D1', 360, true)
      await startPurchase(db, m, 'BALANCE', 500)
      const failed = await startPurchase(db, m, 'SMS', 100)
      await confirm(db, m.id, failed.pay.reference, null, null, false, { reason: 'Insufficient balance' })

      await as(db, superId)
      const d = await value<{ totals: Record<string, number>; by_purpose: Record<string, number>; rows: Array<{ reference: string }>; count: number }>(db,
        `select public.platform_billing_dashboard($1)`, [JSON.stringify({ q: m.id.slice(0, 0) })])
      expect(Number(d.totals.collected)).toBeGreaterThanOrEqual(360)
      const mineOnly = await value<{ count: number; rows: Array<{ reference: string; status: string }> }>(db,
        `select public.platform_billing_dashboard($1)`, [JSON.stringify({ q: one.pay.reference })])
      expect(mineOnly.count).toBe(1)
      expect(mineOnly.rows[0]).toMatchObject({ reference: one.pay.reference, status: 'SUCCEEDED' })
      const failedOnly = await value<{ rows: Array<{ reference: string }> }>(db,
        `select public.platform_billing_dashboard($1)`, [JSON.stringify({ status: 'FAILED', q: failed.pay.reference })])
      expect(failedOnly.rows.map((r) => r.reference)).toEqual([failed.pay.reference])

      const detail = await value<{ checks: Array<{ outcome: string }>; credits: Array<{ amount: number }>; invoice: { number: string } }>(db,
        `select public.platform_billing_payment($1)`, [one.pay.payment_id])
      expect(detail.checks.map((c) => c.outcome)).toEqual(['succeeded'])
      expect(detail.credits.map((c) => c.amount)).toEqual([1000])
    }))

  it('saves prices and switches only for billing managers, with a reason and validation', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      await as(db, superId)
      const c = (await value<{ controls: Record<string, any> }>(db, `select public.platform_billing_controls()`)).controls
      expect(c.pricing.SMS.unit_poisha).toBe(36)
      c.pricing.SMS.unit_poisha = 35
      await expectError(db, `select public.platform_billing_controls_save($1, 'no')`, [JSON.stringify(c)], /reason/)
      await db.query(`select public.platform_billing_controls_save($1, 'New SMS rate from provider')`, [JSON.stringify(c)])
      await asSystem(db, null)
      expect(await value(db, `select (value -> 'pricing' -> 'SMS' ->> 'unit_poisha')::int from public.platform_settings where key = 'billing_controls'`)).toBe(35)
      await as(db, superId)
      const bad = structuredClone(c)
      bad.pricing.SMS.unit_poisha = 0
      await expectError(db, `select public.platform_billing_controls_save($1, 'Free SMS for all')`, [JSON.stringify(bad)], /price per credit/)
      // Not through the plain settings editor.
      await expectError(db, `select public.platform_setting_save('billing_controls', $1, 'Sneaky edit')`, [JSON.stringify(c)], /own page/)
      await as(db, support)
      await expectError(db, `select public.platform_billing_controls_save($1, 'Support changing prices')`, [JSON.stringify(c)], /PERMISSION_DENIED|permission/)
    }))
})

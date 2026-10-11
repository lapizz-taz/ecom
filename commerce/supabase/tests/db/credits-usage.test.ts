import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string, opts: { active?: boolean } = {}): Promise<{ id: string; owner: string }> {
  await as(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}` })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await as(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  if (opts.active) {
    // A paying merchant: the trial is over and the period is paid.
    await asSystem(db, null)
    await db.query(`update public.subscriptions set status = 'ACTIVE', trial_ends_at = now(), current_period_start = now(),
      current_period_end = now() + interval '1 month' where merchant_id = $1 and ended_at is null`, [created.id])
  }
  return { id: created.id, owner }
}

type Entry = { id: number; amount: number; balance_after: number; kind: string }
type Gate = { allowed: boolean; usage_id: string | null; charge?: string; reason?: string; credits?: number; duplicate?: boolean }

const available = (db: Db, merchant: string, type: string) => value<number>(db, `select public.credit_available($1, $2)`, [merchant, type])
const lotsSum = (db: Db, merchant: string, type: string) =>
  value<number>(db, `select coalesce(sum(remaining), 0)::int from public.credit_lots where merchant_id = $1 and credit_type = $2`, [merchant, type])
const balance = (db: Db, merchant: string, type: string) =>
  value<number>(db, `select coalesce((select balance from public.credit_balances where merchant_id = $1 and credit_type = $2), 0)`, [merchant, type])

async function grant(db: Db, superId: string, merchant: string, type: string, amount: number, kind = 'ADJUSTMENT', expires: string | null = null) {
  await as(db, superId)
  return value<Entry>(db, `select public.platform_credit_adjust($1, $2, $3, $4, 'Test credits for the merchant', $5::timestamptz, $6)`,
    [merchant, type, amount, kind, expires, randomUUID()])
}

async function lookup(db: Db, merchant: string, key = randomUUID()): Promise<Gate> {
  await asService(db, merchant)
  return value<Gate>(db, `select public.courier_lookup_begin('01711000777', $1)`, [key])
}

describe('credits: the ledger', () => {
  it('records every change with its balance, never twice for one request, and keeps balance = lots', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      const request = randomUUID()
      const first = await value<Entry>(db, `select public.platform_credit_adjust($1, 'SMS', 300, 'PROMO', 'Welcome credits', now() + interval '10 days', $2)`, [m.id, request])
      const again = await value<Entry>(db, `select public.platform_credit_adjust($1, 'SMS', 300, 'PROMO', 'Welcome credits', now() + interval '10 days', $2)`, [m.id, request])
      expect(again.id).toBe(first.id)
      expect(first).toMatchObject({ amount: 300, balance_after: 300, kind: 'PROMO' })
      const second = await value<Entry>(db, `select public.platform_credit_adjust($1, 'SMS', -120, 'ADJUSTMENT', 'Correction for a test', null, $2)`, [m.id, randomUUID()])
      expect(second.balance_after).toBe(180)
      await expectError(db, `select public.platform_credit_adjust($1, 'SMS', -500, 'ADJUSTMENT', 'Too much taken', null, $2)`, [m.id, randomUUID()], /INSUFFICIENT_CREDITS/)
      await expectError(db, `select public.platform_credit_adjust($1, 'SMS', -5, 'PROMO', 'Promo cannot remove', null, $2)`, [m.id, randomUUID()], /added, not removed/)
      await expectError(db, `select public.platform_credit_adjust($1, 'SMS', 5, 'ADJUSTMENT', 'no', null, $2)`, [m.id, randomUUID()], /reason/)

      await asSystem(db, null)
      expect(await balance(db, m.id, 'SMS')).toBe(180)
      expect(await lotsSum(db, m.id, 'SMS')).toBe(180)
      const rows = (await db.query(`select kind, amount, balance_after, actor_kind, reason from public.credit_ledger where merchant_id = $1 order by id`, [m.id])).rows
      expect(rows).toEqual([
        { kind: 'PROMO', amount: 300, balance_after: 300, actor_kind: 'PLATFORM', reason: 'Welcome credits' },
        { kind: 'ADJUSTMENT', amount: -120, balance_after: 180, actor_kind: 'PLATFORM', reason: 'Correction for a test' },
      ])
      await expectError(db, `update public.credit_ledger set amount = 1 where merchant_id = $1`, [m.id], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.credit_ledger where merchant_id = $1`, [m.id], /IMMUTABLE_RECORD/)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where merchant_id = $1 and action like 'credits.%'`, [m.id])).toBe(2)
    }))

  it('spends credits that expire first, and writes off expired ones', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await grant(db, superId, m.id, 'COURIER', 50)
      await grant(db, superId, m.id, 'COURIER', 20, 'PROMO', new Date(Date.now() + 86_400_000).toISOString())
      await asSystem(db, null)
      // A spend of 25 takes the 20 expiring credits first.
      await db.query(`select public._credit_post($1, 'COURIER', -25, 'USAGE', 'test spend', null, 'SYSTEM', null, null, $2)`, [m.id, 'spend-1'])
      expect(await value(db, `select remaining from public.credit_lots where merchant_id = $1 and expires_at is not null`, [m.id])).toBe(0)
      expect(await available(db, m.id, 'COURIER')).toBe(45)

      await grant(db, superId, m.id, 'COURIER', 10, 'PROMO', new Date(Date.now() + 60_000).toISOString())
      await asSystem(db, null)
      await db.query(`update public.credit_lots set expires_at = now() - interval '1 second' where merchant_id = $1 and remaining = 10`, [m.id])
      expect(await available(db, m.id, 'COURIER')).toBe(45)
      expect(await value(db, `select public.credits_expire_all()`)).toBeGreaterThanOrEqual(1)
      expect(await balance(db, m.id, 'COURIER')).toBe(45)
      expect(await value(db, `select amount from public.credit_ledger where merchant_id = $1 and kind = 'EXPIRY'`, [m.id])).toBe(-10)
      expect(await lotsSum(db, m.id, 'COURIER')).toBe(45)
    }))

  it('sends large changes to a second person, and limits who may change credits', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const other = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      const pending = await value<{ pending_approval: string }>(db,
        `select public.platform_credit_adjust($1, 'SMS', 5000, 'ADJUSTMENT', 'Big goodwill grant', null, $2)`, [m.id, randomUUID()])
      expect(pending.pending_approval).toBeTruthy()
      await asSystem(db, null)
      expect(await balance(db, m.id, 'SMS')).toBe(0)
      await as(db, superId)
      await expectError(db, `select public.platform_approval_decide($1, true)`, [pending.pending_approval], /second person/)
      await as(db, other)
      const done = await value<{ status: string }>(db, `select public.platform_approval_decide($1, true, 'Checked')`, [pending.pending_approval])
      expect(done.status).toBe('EXECUTED')
      await asSystem(db, null)
      expect(await balance(db, m.id, 'SMS')).toBe(5000)
      const entry = (await db.query(`select actor_id, metadata from public.credit_ledger where merchant_id = $1`, [m.id])).rows[0]
      expect(entry.actor_id).toBe(superId)
      expect(entry.metadata.approved_by).toBe(other)

      await as(db, viewer)
      await expectError(db, `select public.platform_credit_adjust($1, 'SMS', 5, 'PROMO', 'Viewer tries', null, null)`, [m.id], /PERMISSION_DENIED/)
      await as(db, billing)
      await db.query(`select public.platform_credit_adjust($1, 'SMS', 5, 'PROMO', 'Billing grants', null, null)`, [m.id])
      // Merchant staff: read their own credits, never write them.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.platform_credit_adjust($1, 'SMS', 5, 'PROMO', 'Self service', null, null)`, [m.id], /PERMISSION_DENIED/)
      await expectError(db, `insert into public.credit_ledger (merchant_id, credit_type, kind, amount, balance_after, idempotency_key) values ($1, 'SMS', 'PROMO', 5, 5, 'x')`, [m.id], /permission denied/)
      await expectError(db, `select public._credit_post($1, 'SMS', 5, 'PROMO', 'x', null, 'MERCHANT', null, null, 'x')`, [m.id], /permission denied/)
      const mine = await value<{ balances: Array<{ code: string; available: number }> }>(db, `select public.my_credits()`)
      expect(mine.balances.find((b) => b.code === 'SMS')?.available).toBe(5005)
      expect(mine.balances.map((b) => b.code)).not.toContain('AI')
      expect(await value(db, `select count(*)::int from public.credit_ledger`)).toBe(2)
      // Another business sees none of it.
      const otherOwner = await createStaff(db, 'OWNER')
      await asUser(db, otherOwner)
      expect(await value(db, `select count(*)::int from public.credit_ledger where merchant_id = $1`, [m.id])).toBe(0)
      expect(await value(db, `select count(*)::int from public.credit_balances where merchant_id = $1`, [m.id])).toBe(0)
    }))
})

describe('BD Courier: lookups through the platform account', () => {
  it('gives eligible paying merchants the configured free lookups, then charges credits, and refunds failures', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId, { active: true })
      // The policy decides; set it here rather than relying on defaults.
      await as(db, superId)
      await db.query(`select public.platform_usage_policy_save('BD_COURIER', $1, 'Test policy')`, [JSON.stringify({
        free: { enabled: true, limit: 2, period: 'MONTH', plans: [], statuses: ['ACTIVE'] }, after_free: 'CREDITS', credits_per_unit: 1,
        monthly_cap: 4, unmetered_plans: ['FOUNDER'],
      })])
      const a = await lookup(db, m.id)
      const b = await lookup(db, m.id)
      expect([a.charge, b.charge]).toEqual(['FREE', 'FREE'])
      const c = await lookup(db, m.id)
      expect(c).toMatchObject({ allowed: false, reason: 'NO_CREDITS' })

      await grant(db, superId, m.id, 'COURIER', 10)
      const d = await lookup(db, m.id)
      expect(d).toMatchObject({ allowed: true, charge: 'CREDITS', credits: 1 })
      await asSystem(db, null)
      expect(await available(db, m.id, 'COURIER')).toBe(9)
      // BD Courier timed out: the credit comes back, and the free count is not used up by failures.
      await asService(db, m.id)
      await db.query(`select public.courier_lookup_finish($1, false, 'Timed out')`, [d.usage_id])
      await db.query(`select public.courier_lookup_finish($1, false, 'Timed out')`, [d.usage_id])
      await asSystem(db, null)
      expect(await available(db, m.id, 'COURIER')).toBe(10)
      expect(await value(db, `select count(*)::int from public.credit_ledger where merchant_id = $1 and kind = 'REFUND'`, [m.id])).toBe(1)

      // The same request key twice is one use.
      const key = randomUUID()
      const e1 = await lookup(db, m.id, key)
      const e2 = await lookup(db, m.id, key)
      expect(e2).toMatchObject({ usage_id: e1.usage_id, duplicate: true })
      await asService(db, m.id)
      await db.query(`select public.courier_lookup_finish($1, true)`, [e1.usage_id])
      // Monthly cap (4): two free + this one = 3 used, one more allowed, then refused.
      expect((await lookup(db, m.id)).allowed).toBe(true)
      expect(await lookup(db, m.id)).toMatchObject({ allowed: false, reason: 'LIMIT_REACHED' })

      await as(db, superId)
      const report = await value<{ totals: Record<string, number>; denied_reasons: Record<string, number> }>(db,
        `select public.platform_usage_report('BD_COURIER', current_date - 1, current_date + 1, $1)`, [m.id])
      // Attempted: 2 free + 1 failed + 2 paid (the repeated key is one use); 2 refused.
      expect(report.totals).toMatchObject({ attempted: 5, denied: 2, failed: 1, succeeded: 1, free_units: 2, credits: 2, credits_refunded: 1 })
      expect(report.denied_reasons).toMatchObject({ NO_CREDITS: 1, LIMIT_REACHED: 1 })
    }))

  it('refuses when the feature is off for the merchant, trial accounts get no free use by default, and the founder plan is unmetered', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const trial = await newMerchant(db, superId)
      expect(await lookup(db, trial.id)).toMatchObject({ allowed: false, reason: 'NO_CREDITS' })
      // A merchant-specific limit is an explicit decision: it applies even on a trial.
      await as(db, superId)
      await db.query(`select public.platform_service_override_set($1, 'BD_COURIER', 3, null, null, 'Pilot merchant')`, [trial.id])
      expect(await lookup(db, trial.id)).toMatchObject({ allowed: true, charge: 'FREE' })
      await as(db, superId)
      await db.query(`select public.platform_merchant_feature_set($1, 'courier_history', false, 'Abuse')`, [trial.id])
      expect(await lookup(db, trial.id)).toMatchObject({ allowed: false, reason: 'FEATURE_OFF' })

      expect(await lookup(db, MERCHANT_1)).toMatchObject({ allowed: true, charge: 'PLAN' })
      // Only the service role reaches the gate.
      await asUser(db, trial.owner, 'owner@shop.example', trial.id)
      await expectError(db, `select public.courier_lookup_begin('01711000777', $1)`, [randomUUID()], /permission denied|PERMISSION_DENIED/)
    }))
})

describe('SMS: through the platform provider, charged by the SMS policy', () => {
  async function queueSms(db: Db, merchant: string, segments = 1): Promise<string> {
    await asSystem(db, merchant)
    return value<string>(db, `insert into public.notification_logs (event, channel, recipient, body, status, segments, encoding, purpose)
      values ('ORDER_CREATED', 'SMS', '8801711000999', 'Your order is on the way', 'QUEUED', $1, 'GSM', 'AUTOMATION') returning id`, [segments])
  }
  async function claim(db: Db, merchant: string): Promise<string[]> {
    await asService(db, merchant)
    return (await db.query(`select id from public.claim_notifications(50) where channel = 'SMS'`)).rows.map((r) => r.id)
  }
  const complete = (db: Db, id: string, success: boolean, permanent = false, delivery: string | null = null) =>
    db.query(`select public.complete_notification($1, $2, 'smsnetbd', $3, $4, 0.25, $5, $6)`, [id, success, success ? 'REQ-1' : null, success ? null : 'rejected', permanent, delivery])

  it('waits for credits, charges once per message (not per retry), refunds failures, and keeps undelivered charged by default', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = value || '{"connected": true, "provider": "smsnetbd", "sender_id": "FULLFILIO"}' where key = 'sms'`)
      const first = await queueSms(db, m.id, 2)
      expect(await claim(db, m.id)).toEqual([])
      await asSystem(db, null)
      const held = (await db.query(`select status, error, attempts from public.notification_logs where id = $1`, [first])).rows[0]
      expect(held).toMatchObject({ status: 'QUEUED', attempts: 0 })
      expect(held.error).toMatch(/Waiting for SMS credits/)

      await grant(db, superId, m.id, 'SMS', 10)
      await asSystem(db, null)
      await db.query(`update public.notification_logs set next_attempt_at = now() where id = $1`, [first])
      expect(await claim(db, m.id)).toEqual([first])
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(8)
      // A temporary failure goes back to the queue; the retry is not charged again.
      await asService(db, m.id)
      await complete(db, first, false)
      await asSystem(db, null)
      await db.query(`update public.notification_logs set next_attempt_at = now() where id = $1`, [first])
      expect(await claim(db, m.id)).toEqual([first])
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(8)
      await asService(db, m.id)
      await complete(db, first, true, false, 'PENDING')
      // The provider's charge is the platform's cost, not shown as the merchant's.
      await asSystem(db, null)
      expect(await value(db, `select cost_source from public.notification_logs where id = $1`, [first])).toBe('ESTIMATE')
      expect(await value(db, `select provider_cost::text from public.service_usage where idempotency_key = $1`, [`sms:${first}`])).toBe('0.2500')
      await asService(db, m.id)
      await db.query(`select public.record_sms_delivery($1, 'FAILED')`, [first])
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(8)
      expect(await value(db, `select outcome from public.service_usage where idempotency_key = $1`, [`sms:${first}`])).toBe('UNDELIVERED')

      // Rejected by the provider: refunded in full.
      const second = await queueSms(db, m.id, 3)
      expect(await claim(db, m.id)).toEqual([second])
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(5)
      await asService(db, m.id)
      await complete(db, second, false, true)
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(8)
      expect(await value(db, `select status from public.service_usage where idempotency_key = $1`, [`sms:${second}`])).toBe('FAILED')

      // Refund for undelivered messages, when the platform turns it on.
      await as(db, superId)
      const policy = await value<Record<string, unknown>>(db, `select (public.platform_service_status('SMS')) -> 'policy'`)
      await db.query(`select public.platform_usage_policy_save('SMS', $1, 'Refund undelivered')`, [JSON.stringify({ ...policy, refund_undelivered: true })])
      const third = await queueSms(db, m.id, 1)
      await claim(db, m.id)
      await asService(db, m.id)
      await complete(db, third, true, false, 'PENDING')
      await db.query(`select public.record_sms_delivery($1, 'FAILED')`, [third])
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(8)
    }))

  it('gives paying merchants their free SMS first, at no cost in their Finance', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId, { active: true })
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = value || '{"connected": true, "provider": "smsnetbd"}' where key = 'sms'`)
      const id = await queueSms(db, m.id, 2)
      expect(await claim(db, m.id)).toEqual([id])
      await asSystem(db, null)
      expect(await value(db, `select charge from public.service_usage where idempotency_key = $1`, [`sms:${id}`])).toBe('FREE')
      expect(await value(db, `select cost::float from public.notification_logs where id = $1`, [id])).toBe(0)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const mine = await value<{ usage: { sms: { free: { used: number; remaining: number; limit: number } } } }>(db, `select public.my_credits()`)
      expect(mine.usage.sms.free).toMatchObject({ used: 2, remaining: 18, limit: 20 })
    }))
})

describe('recharge: credits arrive only after a verified payment', () => {
  it('pays a credit package through the gateway exactly once, refusing wrong amounts', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      const pkg = await value<{ id: string; credits: number; bonus_credits: number; price: string }>(db,
        `select to_jsonb(k) from public.credit_packages k where name = 'SMS 2,000'`)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const inv = await value<{ id: string; total: number; gateways: string[] }>(db, `select public.credits_start_recharge($1)`, [pkg.id])
      expect(inv.total).toBe(900)
      expect(await value(db, `select (public.credits_start_recharge($1)) ->> 'id'`, [pkg.id])).toBe(inv.id)

      await asService(db, m.id)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id], /not available/)
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
      await asService(db, m.id)
      const pay = await value<{ payment_id: string; reference: string; amount: number }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id])
      expect(pay.amount).toBe(900)
      await db.query(`select public.billing_gateway_payment_session($1, 'TRX-SESSION-1')`, [pay.payment_id])
      await asService(db, null)
      expect(await value(db, `select (public.billing_gateway_lookup('bkash', 'TRX-SESSION-1')) ->> 'merchant_id'`)).toBe(m.id)

      await asService(db, m.id)
      expect(await value(db, `select (public.billing_gateway_confirm($1, 'bkash', 'TXN1', 90, true, '{}')) ->> 'status'`, [pay.reference])).toBe('amount_mismatch')
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(0)
      await asService(db, m.id)
      expect(await value(db, `select (public.billing_gateway_confirm($1, 'bkash', 'TXN1', 900, true, '{}')) ->> 'status'`, [pay.reference])).toBe('succeeded')
      expect(await value(db, `select (public.billing_gateway_confirm($1, 'bkash', 'TXN1', 900, true, '{}')) ->> 'status'`, [pay.reference])).toBe('already_succeeded')
      await asSystem(db, null)
      expect(await available(db, m.id, 'SMS')).toBe(pkg.credits + pkg.bonus_credits)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [inv.id])).toBe('PAID')
      expect(await value(db, `select count(*)::int from public.credit_ledger where merchant_id = $1 and kind = 'RECHARGE'`, [m.id])).toBe(1)

      // The same gateway transaction cannot pay a second invoice.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const inv2 = await value<{ id: string }>(db, `select public.credits_start_recharge($1)`, [pkg.id])
      await asService(db, m.id)
      const pay2 = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv2.id])
      expect(await value(db, `select (public.billing_gateway_confirm($1, 'bkash', 'TXN1', 900, true, '{}')) ->> 'status'`, [pay2.reference])).toBe('duplicate_transaction')
      // Browsers never confirm payments.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN9', 900, true, '{}')`, [pay2.reference], /permission denied|PERMISSION_DENIED/)
    }))

  it('also credits a package paid by bank transfer, once a second person verifies it', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      const pkg = await value<string>(db, `select id from public.credit_packages where name = 'Courier checks 100'`)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const inv = await value<{ id: string }>(db, `select public.credits_start_recharge($1)`, [pkg])
      await as(db, billing)
      const p = await value<{ id: string }>(db, `select public.platform_payment_record($1, '{"amount":150,"method":"BANK","reference":"BANK-55"}')`, [inv.id])
      await asSystem(db, null)
      expect(await available(db, m.id, 'COURIER')).toBe(0)
      await as(db, superId)
      await db.query(`select public.platform_payment_verify($1, true, 'In the statement')`, [p.id])
      await asSystem(db, null)
      expect(await available(db, m.id, 'COURIER')).toBe(100)
    }))

  it('lets the owner pay even while the account is restricted', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'SUSPENDED' where id = $1`, [m.id])
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      expect(await value(db, `select public.has_permission('settings.manage')`)).toBe(false)
      expect(await value(db, `select public.billing_can_pay()`)).toBe(true)
    }))
})

describe('policies and settings', () => {
  it('validates usage policies, keeps their history, and keeps connection settings off the plain settings path', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      await as(db, superId)
      await expectError(db, `select public.platform_usage_policy_save('SMS', '{"free":{"enabled":true,"limit":-1,"period":"MONTH"},"after_free":"CREDITS","credits_per_unit":1,"unit":"SEGMENT","hold_hours":6}', 'Bad limit')`, [], /free limit/)
      await expectError(db, `select public.platform_usage_policy_save('SMS', '{"free":{"enabled":true,"limit":5,"period":"WEEK"},"after_free":"CREDITS","credits_per_unit":1,"unit":"SEGMENT","hold_hours":6}', 'Bad period')`, [], /once or every month/)
      const saved = await value<{ free: { limit: number } }>(db, `select public.platform_usage_policy_save('SMS',
        '{"free":{"enabled":false,"limit":0,"period":"ONCE","plans":[],"statuses":["ACTIVE"]},"after_free":"CREDITS","credits_per_unit":1,"unit":"MESSAGE","hold_hours":2,"unmetered_plans":["FOUNDER"]}',
        'No free SMS any more')`)
      expect(saved.free.limit).toBe(0)
      const history = await value<Array<{ ref: string; note: string }>>(db, `select public.platform_config_history('platform_setting', 'usage.sms')`)
      expect(history[0].note).toBe('No free SMS any more')
      await expectError(db, `select public.platform_setting_save('sms', '{"connected": true, "provider": "fake"}', 'sneaky')`, [], /own page/)
      await as(db, tech)
      await expectError(db, `select public.platform_usage_policy_save('SMS', '{}', 'Not allowed')`, [], /PERMISSION_DENIED/)
      const status = await value<{ config: Record<string, unknown>; can: { edit: boolean } }>(db, `select public.platform_service_status('SMS')`)
      expect(status.can.edit).toBe(false)
      expect(JSON.stringify(status)).not.toMatch(/api_key|password|secret_id/)
    }))
})

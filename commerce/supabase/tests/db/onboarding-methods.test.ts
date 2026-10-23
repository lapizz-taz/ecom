import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

async function newPerson(db: Db) {
  await asSystem(db, null)
  const id = randomUUID()
  const email = `founder-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Nadia Rahman"}')`, [id, email])
  return { id, email }
}
const signUp = JSON.stringify({ business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', plan_code: 'GROWTH' })
const asStaff = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function onboarding(db: Db, value_: Record<string, unknown>) {
  await asSystem(db, null)
  await db.query(`update public.platform_settings set value = value || $1::jsonb where key = 'onboarding'`, [JSON.stringify(value_)])
}
async function signUpAs(db: Db) {
  const me = await newPerson(db)
  await asUser(db, me.id, me.email, null)
  const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`, [signUp])
  return { ...me, merchant: r.merchant_id as string, r }
}
const accessOf = async (db: Db, merchant: string) => { await asSystem(db, null); return value<string>(db, `select public.merchant_access_mode($1)`, [merchant]) }

describe('onboarding by online payment', () => {
  it('keeps the admin closed until the gateway confirms the first invoice, then opens it', () =>
    inTx(async (db) => {
      await onboarding(db, { method: 'online_payment' })
      await asSystem(db, null)
      await db.query(`update public.plans set trial_days = 0 where code = 'GROWTH'`)
      await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)

      const m = await signUpAs(db)
      expect(m.r.activation).toMatchObject({ state: 'awaiting_payment' })
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')

      // The owner sees what to pay on the plan page.
      await asUser(db, m.id, m.email, m.merchant)
      const plan = await value<Record<string, any>>(db, `select public.my_plan()`)
      expect(plan.activation).toMatchObject({ state: 'awaiting_payment', invoice_id: m.r.activation.invoice_id })
      expect(plan.invoices[0]).toMatchObject({ id: m.r.activation.invoice_id, status: 'OPEN', total: 5000 })

      // A wrong amount, or the browser itself, opens nothing.
      await asService(db, m.merchant)
      const pay = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [m.r.activation.invoice_id])
      expect(await value(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-ON-1', 100, true, '{}') ->> 'status'`, [pay.reference])).toBe('amount_mismatch')
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-ON-2', 5000, true, '{}')`, [pay.reference], /permission denied|PERMISSION_DENIED/)
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')

      // The gateway's server-to-server confirmation of the full amount opens it.
      await asService(db, m.merchant)
      expect(await value(db, `select public.billing_gateway_confirm($1, 'bkash', 'TXN-ON-3', 5000, true, '{}') ->> 'status'`, [pay.reference])).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      await asSystem(db, null)
      const after = await value<Record<string, any>>(db, `select jsonb_build_object('status', m.status, 'activation', m.onboarding -> 'activation', 'via', m.onboarding ->> 'activated_via',
        'sub', (select status from public.subscriptions s where s.merchant_id = m.id and s.ended_at is null)) from public.merchants m where id = $1`, [m.merchant])
      expect(after).toEqual({ status: 'ACTIVE', activation: null, via: 'payment', sub: 'ACTIVE' })
    }))

  it('starts a plan with a trial at once, as before', () =>
    inTx(async (db) => {
      await onboarding(db, { method: 'online_payment' })
      const m = await signUpAs(db)
      expect(m.r.status).toBe('TRIALING')
      expect(m.r.activation).toBeNull()
      expect(await accessOf(db, m.merchant)).toBe('FULL')
    }))
})

describe('onboarding by WhatsApp', () => {
  it('gives the prefilled message, waits for the platform team, and only they can activate', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await expectError(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'whatsapp', reminder_days: [3, 1] })], /official WhatsApp number/)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({
        method: 'whatsapp', whatsapp_number: '+880 1999-000111', reminder_days: [1, 3, 99],
        whatsapp_template: 'Hi, activate {business} ({phone}) on {plan}',
      })])
      await asAnon(db, null)
      expect(await value(db, `select public.public_signup_options() -> 'onboarding'`)).toEqual({ method: 'whatsapp', whatsapp_number: '8801999000111' })

      const m = await signUpAs(db)
      expect(m.r.activation).toMatchObject({ state: 'awaiting_whatsapp', whatsapp_number: '8801999000111', whatsapp_message: 'Hi, activate Nadia Crafts (01712345678) on Growth' })
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      // Nothing is billed while it waits.
      await asSystem(db, null)
      await db.query(`select public.billing_run()`)
      expect(await value(db, `select count(*)::int from public.billing_invoices where merchant_id = $1`, [m.merchant])).toBe(0)

      // The merchant cannot activate itself.
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.platform_merchant_activate($1, 'self')`, [m.merchant], /PERMISSION_DENIED|platform/)

      await asStaff(db, superId)
      const pending = await value<Array<{ merchant_id: string; state: string }>>(db, `select public.platform_pending_activations()`)
      expect(pending.find((p) => p.merchant_id === m.merchant)?.state).toBe('awaiting_whatsapp')
      await expectError(db, `select public.platform_merchant_activate($1, '')`, [m.merchant], /say why/)
      expect(await value(db, `select public.platform_merchant_activate($1, 'Paid 5000 by bKash, TrxID 9AB')->> 'subscription'`, [m.merchant])).toBe('TRIALING')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      await asStaff(db, superId)
      await expectError(db, `select public.platform_merchant_activate($1, 'again')`, [m.merchant], /not waiting/)
    }))
})

describe('renewals and expiry reminders', () => {
  it('raises the next invoice early on Renew now and reminds platform staff on the chosen days', () =>
    inTx(async (db) => {
      await onboarding(db, { method: 'online_payment', reminder_days: [3, 1] })
      const m = await signUpAs(db)
      await asSystem(db, null)
      await db.query(`update public.subscriptions set status = 'ACTIVE', trial_ends_at = null, current_period_start = now() - interval '29 days',
        current_period_end = now() + interval '2 days 20 hours' where merchant_id = $1 and ended_at is null`, [m.merchant])

      await asUser(db, m.id, m.email, m.merchant)
      const inv = await value<Record<string, any>>(db, `select public.billing_renew_now()`)
      expect(inv).toMatchObject({ status: 'OPEN', total: 5000 })
      expect((await value<Record<string, any>>(db, `select public.billing_renew_now()`)).id).toBe(inv.id)
      expect(await value(db, `select public.my_plan() -> 'reminder_days'`)).toEqual([3, 1])

      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      expect(await value(db, `select (public.billing_run() ->> 'reminders')::int`)).toBeGreaterThanOrEqual(1)
      expect(await value(db, `select count(*)::int from public.subscription_events e join public.subscriptions s on s.id = e.subscription_id
        where s.merchant_id = $1 and e.event = 'reminder.sent' and e.detail ->> 'days' = '3'`, [m.merchant])).toBe(1)
      // Once per day-mark.
      await db.query(`select public.billing_run()`)
      expect(await value(db, `select count(*)::int from public.subscription_events e join public.subscriptions s on s.id = e.subscription_id
        where s.merchant_id = $1 and e.event = 'reminder.sent'`, [m.merchant])).toBe(1)
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1 and kind = 'subscription.expiring' and merchant_id = $2`, [staff, m.merchant])).toBe(1)
    }))
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

// New businesses: 2 days free, then 99 Tk for the first month, then the plan's normal price.

async function newPerson(db: Db) {
  await asSystem(db, null)
  const id = randomUUID()
  const email = `founder-${id.slice(0, 8)}@shop.example`
  await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Nadia Rahman"}')`, [id, email])
  return { id, email }
}
const asStaff = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function offer(db: Db, value_: Record<string, unknown>) {
  await asSystem(db, null)
  await db.query(`insert into public.platform_settings (key, value) values ('signup_offer', '{}') on conflict (key) do nothing`)
  await db.query(`update public.platform_settings set value = value || $1::jsonb where key = 'signup_offer'`, [JSON.stringify(value_)])
}
async function onlinePayment(db: Db) {
  await asSystem(db, null)
  await db.query(`update public.platform_settings set value = value || '{"method": "online_payment"}' where key = 'onboarding'`)
  await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
}
async function signUpAs(db: Db, plan = 'GROWTH') {
  const me = await newPerson(db)
  await asUser(db, me.id, me.email, null)
  const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`,
    [JSON.stringify({ business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', plan_code: plan })])
  return { ...me, merchant: r.merchant_id as string, r }
}
const sub = async (db: Db, merchant: string) => {
  await asSystem(db, null)
  return value<Record<string, any>>(db, `select to_jsonb(s) from public.subscriptions s where merchant_id = $1 and ended_at is null`, [merchant])
}
const accessOf = async (db: Db, merchant: string) => { await asSystem(db, null); return value<string>(db, `select public.merchant_access_mode($1)`, [merchant]) }
const invoices = async (db: Db, merchant: string) => {
  await asSystem(db, null)
  return value<Array<{ id: string; total: number; status: string; period_start: string; lines: Array<Record<string, any>> }>>(db,
    `select coalesce(jsonb_agg(jsonb_build_object('id', id, 'total', total, 'status', status, 'period_start', period_start, 'lines', lines) order by period_start), '[]')
     from public.billing_invoices where merchant_id = $1 and kind = 'SUBSCRIPTION' and status <> 'VOID'`, [merchant])
}
async function pay(db: Db, merchant: string, invoice: string, amount: number) {
  await asService(db, merchant)
  const p = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [invoice])
  return value<string>(db, `select public.billing_gateway_confirm($1, 'bkash', $2, $3, true, '{}') ->> 'status'`, [p.reference, `TXN-${randomUUID().slice(0, 8)}`, amount])
}
const hours = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 3_600_000)

describe('new-business offer', () => {
  it('2 days free, then 99 Tk for the first month (pay to continue), then the plan price', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, { enabled: true, trial_days: 2, first_price: 99, first_periods: 1 })

      // The sign-up page shows it.
      await asAnon(db, null)
      const options = await value<{ plans: Array<{ code: string; trial_days: number; offer: Record<string, unknown> | null }> }>(db, `select public.public_signup_options()`)
      expect(options.plans.find((p) => p.code === 'GROWTH')).toMatchObject({ trial_days: 2, offer: { trial_days: 2, first_price: 99, first_periods: 1 } })

      const m = await signUpAs(db)
      expect(m.r).toMatchObject({ status: 'TRIALING', activation: null })
      let s = await sub(db, m.merchant)
      expect(hours(s.trial_ends_at, s.current_period_start)).toBe(48)
      expect(Number(s.intro_price)).toBe(99)
      expect(hours(s.intro_until, s.trial_ends_at)).toBeGreaterThanOrEqual(28 * 24)
      expect(await accessOf(db, m.merchant)).toBe('FULL')

      // The trial ends without payment: the first invoice is 99 Tk and the admin waits for it.
      await db.query(`update public.subscriptions set current_period_start = now() - interval '2 days 1 minute', trial_ends_at = now() - interval '1 minute',
                      intro_until = now() - interval '1 minute' + interval '1 month' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const [first] = await invoices(db, m.merchant)
      expect(first).toMatchObject({ total: 99, status: 'OPEN' })
      expect(first.lines[0]).toMatchObject({ amount: 99, intro: true, regular_price: 2490 })
      expect((await sub(db, m.merchant)).status).toBe('PAST_DUE')
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      await asUser(db, m.id, m.email, m.merchant)
      const plan = await value<Record<string, any>>(db, `select public.my_plan()`)
      expect(plan.access_mode).toBe('BLOCKED')
      expect(plan.subscription).toMatchObject({ status: 'PAST_DUE', intro_price: 99 })

      // Paying 99 Tk opens it for the month.
      expect(await pay(db, m.merchant, first.id, 99)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      s = await sub(db, m.merchant)
      expect(s.status).toBe('ACTIVE')
      expect(s.current_period_start).toBe(first.period_start)

      // A month later (the paid month ends where the introductory price ends): the plan's price.
      expect(s.current_period_end).toBe(s.intro_until)
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const all = await invoices(db, m.merchant)
      expect(all.map((i) => i.total).sort((a, b) => a - b)).toEqual([99, 2490])
      expect(all.find((i) => i.total === 2490)!.lines[0].intro).toBeUndefined()
      // Unpaid there is the normal grace period, not the trial gate.
      expect(await accessOf(db, m.merchant)).toBe('FULL')
    }))

  it('paying early during the trial ("Renew now") is the 99 Tk first month', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, { enabled: true, trial_days: 2, first_price: 99, first_periods: 1 })
      const m = await signUpAs(db)
      await asUser(db, m.id, m.email, m.merchant)
      const inv = await value<{ id: string; total: number }>(db, `select public.billing_renew_now()`)
      expect(Number(inv.total)).toBe(99)
      expect(await pay(db, m.merchant, inv.id, 99)).toBe('succeeded')
      expect((await sub(db, m.merchant)).status).toBe('ACTIVE')
    }))

  it('off: the plan trial and price as before; a free plan is never on the offer', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, { enabled: false })
      const m = await signUpAs(db)
      const s = await sub(db, m.merchant)
      expect(s.intro_price).toBeNull()
      await asSystem(db, null)
      const planTrial = await value<number>(db, `select trial_days from public.plans where code = 'GROWTH'`)
      expect(hours(s.trial_ends_at, s.current_period_start)).toBe(planTrial * 24)
      await asAnon(db, null)
      const options = await value<{ plans: Array<{ code: string; offer: unknown }> }>(db, `select public.public_signup_options()`)
      expect(options.plans.every((p) => p.offer === null)).toBe(true)

      // A first price at or above the plan's is no offer.
      await offer(db, { enabled: true, trial_days: 2, first_price: 5000, first_periods: 1 })
      const n = await signUpAs(db)
      const t = await sub(db, n.merchant)
      expect(t.intro_price).toBeNull()
      expect(hours(t.trial_ends_at, t.current_period_start)).toBe(48)
    }))

  it('WhatsApp sign-up gets the offer when the platform team activates it', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'whatsapp', whatsapp_number: '8801999000111', reminder_days: [1] })])
      await offer(db, { enabled: true, trial_days: 2, first_price: 99, first_periods: 1 })
      const m = await signUpAs(db)
      expect((await sub(db, m.merchant)).status).toBe('PAUSED')
      await asStaff(db, superId)
      await value(db, `select public.platform_merchant_activate($1, 'Talked on WhatsApp')`, [m.merchant])
      const s = await sub(db, m.merchant)
      expect(s.status).toBe('TRIALING')
      expect(Number(s.intro_price)).toBe(99)
      expect(hours(s.trial_ends_at, s.current_period_start)).toBe(48)
    }))

  it('Super Admin sets it, checked; merchants cannot', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1, 'launch offer')`,
        [JSON.stringify({ enabled: true, trial_days: '2', first_price: '99', first_periods: '1' })]))
        .toEqual({ enabled: true, trial_days: 2, first_price: 99, first_periods: 1 })
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`, [JSON.stringify({ enabled: true, trial_days: '', first_price: '99', first_periods: '1' })], /free trial is 0 to 90 days/)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`, [JSON.stringify({ enabled: true, trial_days: '2', first_price: 'abc', first_periods: '1' })], /first month price/)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`, [JSON.stringify({ enabled: true, trial_days: '2', first_price: '99', first_periods: '0' })], /1 to 12 months/)
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      await asStaff(db, support)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`, [JSON.stringify({ enabled: false, trial_days: '2', first_price: '99', first_periods: '1' })], /PERMISSION_DENIED|not allowed/)
    }))
})

describe('billing settings', () => {
  it('an empty number cannot be saved, and the billing run reads one as the default', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await expectError(db, `select public.platform_setting_save('billing', $1)`,
        [JSON.stringify({ grace_days: '', invoice_due_days: 7, expire_after_days: 30, default_plan: 'STARTER', currency: 'BDT' })], /grace days is a number of days/)
      expect(await value(db, `select public.platform_setting_save('billing', $1) ->> 'grace_days'`,
        [JSON.stringify({ grace_days: '5', invoice_due_days: 7, expire_after_days: 30, default_plan: 'STARTER', currency: 'BDT' })])).toBe('5')

      // What production had: empty strings saved before the check.
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = value || '{"grace_days": "", "invoice_due_days": ""}' where key = 'billing'`)
      await expect(db.query(`select public.billing_run()`)).resolves.toBeTruthy()
    }))
})

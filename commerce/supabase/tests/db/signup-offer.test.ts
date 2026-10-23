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
      expect(first.lines[0]).toMatchObject({ amount: 99, intro: true, regular_price: 5000 })
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
      expect(all.map((i) => i.total).sort((a, b) => a - b)).toEqual([99, 5000])
      expect(all.find((i) => i.total === 5000)!.lines[0].intro).toBeUndefined()
      // The offer is over: the first month at the plan's price is paid to continue (no grace).
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      expect(await pay(db, m.merchant, all.find((i) => i.total === 5000)!.id, 5000)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      // Later renewals have the normal grace period.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '3 minutes' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect((await sub(db, m.merchant)).status).toBe('PAST_DUE')
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
        .toEqual({ enabled: true, trial_months: 0, trial_days: 2, trial_price: null, first_price: 99, first_periods: 1, setup_fee: null })
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`, [JSON.stringify({ enabled: true, trial_days: '', first_price: '99', first_periods: '1' })], /days are 0 to 90/)
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

describe('new-business offer without a trial, with a one-time fee', () => {
  const OFFER = { enabled: true, trial_days: 0, first_price: 99, first_periods: 1, setup_fee: 1000 }
  const lineKinds = (i: { lines: Array<Record<string, any>> }) => i.lines.map((l) => [l.kind, Number(l.amount)])
  const openInvoice = async (db: Db, merchant: string) => (await invoices(db, merchant)).find((i) => i.status === 'OPEN')

  it('pay 99 Tk to start (closed until paid), then the one-time 1,000 Tk fee with the plan price, then the plan price', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      await asAnon(db, null)
      const options = await value<{ plans: Array<{ code: string; trial_days: number; offer: Record<string, unknown> | null }> }>(db, `select public.public_signup_options()`)
      expect(options.plans.find((p) => p.code === 'GROWTH')).toMatchObject({ trial_days: 0, offer: { trial_days: 0, first_price: 99, setup_fee: 1000 } })

      // Signed up: nothing opens before the 99 Tk is paid.
      const m = await signUpAs(db)
      expect(m.r).toMatchObject({ status: 'ACTIVE', activation: { state: 'awaiting_payment' } })
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      const [first] = await invoices(db, m.merchant)
      expect(first).toMatchObject({ total: 99, status: 'OPEN' })
      expect(lineKinds(first)).toEqual([['plan', 99]])
      await asUser(db, m.id, m.email, m.merchant)
      expect((await value<Record<string, any>>(db, `select public.my_plan()`)).subscription).toMatchObject({ intro_price: 99, setup_fee_pending: 1000 })

      // Paid: one month of use.
      expect(await pay(db, m.merchant, first.id, 99)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      let s = await sub(db, m.merchant)
      expect(s.status).toBe('ACTIVE')
      expect(s.current_period_end).toBe(s.intro_until)

      // The month is over: the plan price plus the one-time fee.
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const second = (await openInvoice(db, m.merchant))!
      expect(second.total).toBe(6000)
      expect(lineKinds(second)).toEqual([['plan', 5000], ['setup_fee', 1000]])
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      await asUser(db, m.id, m.email, m.merchant)
      expect((await value<Record<string, any>>(db, `select public.my_plan()`)).subscription.setup_fee_pending).toBeNull()
      expect(await pay(db, m.merchant, second.id, 6000)).toBe('succeeded')

      // From then on only the plan price.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const third = (await openInvoice(db, m.merchant))!
      expect(third.total).toBe(5000)
      expect(lineKinds(third)).toEqual([['plan', 5000]])
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      s = await sub(db, m.merchant)
      expect(Number(s.setup_fee)).toBe(1000)
    }))

  it('the fee is not lost when its invoice is replaced by a plan change: the plan change carries it', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      const m = await signUpAs(db)
      expect(await pay(db, m.merchant, (await openInvoice(db, m.merchant))!.id, 99)).toBe('succeeded')
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect((await openInvoice(db, m.merchant))!.total).toBe(6000)

      // Instead of paying it, the business moves to Starter: that payment replaces the open invoice,
      // so it carries the fee (security audit run 4: else each plan change put the fee off again).
      await asUser(db, m.id, m.email, m.merchant)
      const change = await value<{ id: string; total: number }>(db, `select public.billing_choose_plan('STARTER')`)
      expect(Number(change.total)).toBe(3500)
      expect(await pay(db, m.merchant, change.id, 3500)).toBe('succeeded')
      expect(await openInvoice(db, m.merchant)).toBeUndefined()

      // The fee was charged once: the next invoice is the plan alone.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const next = (await openInvoice(db, m.merchant))!
      expect(lineKinds(next)).toEqual([['plan', 2500]])
    }))

  it('WhatsApp sign-up: the team activating it is the 99 Tk payment; the next invoice has the fee', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'whatsapp', whatsapp_number: '8801999000111', reminder_days: [1] })])
      await offer(db, OFFER)
      const m = await signUpAs(db)
      await asStaff(db, superId)
      await value(db, `select public.platform_merchant_activate($1, 'Paid 99 Tk by bKash, TrxID 9XK2')`, [m.merchant])
      const s = await sub(db, m.merchant)
      expect(s.status).toBe('ACTIVE')
      expect(s.current_period_end).toBe(s.intro_until)
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      expect(await invoices(db, m.merchant)).toEqual([])

      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect(lineKinds((await openInvoice(db, m.merchant))!)).toEqual([['plan', 5000], ['setup_fee', 1000]])
    }))

  it('Super Admin sets the fee, checked', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1, 'pay to start')`,
        [JSON.stringify({ enabled: true, trial_days: '0', first_price: '99', first_periods: '1', setup_fee: '1000' })]))
        .toEqual({ enabled: true, trial_months: 0, trial_days: 0, trial_price: null, first_price: 99, first_periods: 1, setup_fee: 1000 })
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1) -> 'setup_fee'`,
        [JSON.stringify({ enabled: true, trial_days: '0', first_price: '99', first_periods: '1', setup_fee: '' })])).toBeNull()
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_days: '0', first_price: '99', first_periods: '1', setup_fee: '1k' })], /one-time fee/)
    }))
})

describe('new-business offer: a paid trial, then the one-time fee with the plan price', () => {
  const OFFER = { enabled: true, trial_days: 2, trial_price: 99, first_price: null, first_periods: 1, setup_fee: 1000 }
  const lineKinds = (i: { lines: Array<Record<string, any>> }) => i.lines.map((l) => [l.kind, Number(l.amount)])
  const openInvoice = async (db: Db, merchant: string) => (await invoices(db, merchant)).find((i) => i.status === 'OPEN')
  const periodHours = async (db: Db, id: string) => {
    await asSystem(db, null)
    return value<number>(db, `select round(extract(epoch from period_end - period_start) / 3600)::int from public.billing_invoices where id = $1`, [id])
  }

  it('99 Tk opens a 2-day trial; to continue, 1,000 Tk once with the plan price; then the plan price', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      await asAnon(db, null)
      const options = await value<{ plans: Array<{ code: string; trial_days: number; offer: Record<string, unknown> | null }> }>(db, `select public.public_signup_options()`)
      expect(options.plans.find((p) => p.code === 'GROWTH')).toMatchObject({ trial_days: 2, offer: { trial_days: 2, trial_price: 99, first_price: null, setup_fee: 1000 } })

      // Signed up: closed until the 99 Tk trial is paid.
      const m = await signUpAs(db)
      expect(m.r).toMatchObject({ status: 'ACTIVE', activation: { state: 'awaiting_payment' } })
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      const [trial] = await invoices(db, m.merchant)
      expect(trial).toMatchObject({ total: 99, status: 'OPEN' })
      expect(trial.lines[0].label).toContain('(trial; then 5,000 BDT)')
      expect(await periodHours(db, trial.id)).toBe(48)
      await asUser(db, m.id, m.email, m.merchant)
      expect((await value<Record<string, any>>(db, `select public.my_plan()`)).subscription).toMatchObject({ intro_price: 99, intro_trial: true, setup_fee_pending: 1000 })

      // Paid: two days of use.
      expect(await pay(db, m.merchant, trial.id, 99)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      let s = await sub(db, m.merchant)
      expect(s.status).toBe('ACTIVE')
      expect(s.current_period_end).toBe(s.intro_until)
      expect(hours(s.current_period_end, s.current_period_start)).toBe(48)

      // The trial is over: the one-time fee with the first month, closed until paid.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const second = (await openInvoice(db, m.merchant))!
      expect(lineKinds(second)).toEqual([['plan', 5000], ['setup_fee', 1000]])
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      await asUser(db, m.id, m.email, m.merchant)
      expect((await value<Record<string, any>>(db, `select public.my_plan()`)).access_mode).toBe('BLOCKED')
      expect(await pay(db, m.merchant, second.id, 6000)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')

      // Then the plan price, with the normal grace period.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect(lineKinds((await openInvoice(db, m.merchant))!)).toEqual([['plan', 5000]])
      s = await sub(db, m.merchant)
      expect(s.status).toBe('PAST_DUE')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
    }))

  it('WhatsApp sign-up: the team activating it is the trial payment', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'whatsapp', whatsapp_number: '8801999000111', reminder_days: [1] })])
      await offer(db, OFFER)
      const m = await signUpAs(db)
      await asStaff(db, superId)
      await value(db, `select public.platform_merchant_activate($1, 'Paid 99 Tk by bKash, TrxID 7QK1')`, [m.merchant])
      const s = await sub(db, m.merchant)
      expect(s).toMatchObject({ status: 'ACTIVE', intro_trial: true })
      expect(s.current_period_end).toBe(s.intro_until)
      expect(hours(s.current_period_end, s.current_period_start)).toBe(48)
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      expect(await invoices(db, m.merchant)).toEqual([])

      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect(lineKinds((await openInvoice(db, m.merchant))!)).toEqual([['plan', 5000], ['setup_fee', 1000]])
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
    }))

  it('Super Admin sets the trial price, checked', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1, 'paid trial')`,
        [JSON.stringify({ enabled: true, trial_days: '2', trial_price: '99', first_price: '', first_periods: '1', setup_fee: '1000' })]))
        .toEqual({ enabled: true, trial_months: 0, trial_days: 2, trial_price: 99, first_price: null, first_periods: 1, setup_fee: 1000 })
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_days: '0', trial_price: '99', first_price: '', first_periods: '1' })], /needs months or days/)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_days: '2', trial_price: '99', first_price: '99', first_periods: '1' })], /not both/)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_days: '2', trial_price: 'free', first_price: '', first_periods: '1' })], /price to start is an amount/)
    }))
})

describe('choosing another plan before the first payment', () => {
  const OFFER = { enabled: true, trial_days: 2, trial_price: 99, first_price: null, first_periods: 1, setup_fee: 1000 }

  it('switches the plan, voids the unpaid first invoice and raises the trial invoice again', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      const m = await signUpAs(db, 'GROWTH')
      const [growthTrial] = await invoices(db, m.merchant)
      await asUser(db, m.id, m.email, m.merchant)
      const r = await value<{ applied: boolean; plan: string; activation_invoice_id: string }>(db, `select public.billing_choose_plan('starter')`)
      expect(r).toMatchObject({ applied: true, plan: 'STARTER' })
      await asSystem(db, null)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [growthTrial.id])).toBe('VOID')
      expect((await invoices(db, m.merchant)).map((i) => [i.id, i.total, i.status])).toEqual([[r.activation_invoice_id, 99, 'OPEN']])
      const s = await sub(db, m.merchant)
      expect(s).toMatchObject({ price: 2500, intro_trial: true })
      expect(Number(s.setup_fee)).toBe(1000)
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')

      // The same plan again: nothing to change.
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.billing_choose_plan('STARTER')`, [], /already on the Starter plan/)

      // Paid: open; a later plan change is paid at the plan's price, with the one-time setup fee
      // while it is still due (security audit run 5: else switching plans each period skipped it).
      expect(await pay(db, m.merchant, r.activation_invoice_id, 99)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      await asUser(db, m.id, m.email, m.merchant)
      expect(await value(db, `select public.billing_choose_plan('GROWTH')`)).toMatchObject({ applied: false, total: 5000 + 1000 })
    }))

  it('not while a payment was just started', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      const m = await signUpAs(db, 'GROWTH')
      const [inv] = await invoices(db, m.merchant)
      await asService(db, m.merchant)
      await db.query(`select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id])
      await asUser(db, m.id, m.email, m.merchant)
      await expectError(db, `select public.billing_choose_plan('STARTER')`, [], /payment for this plan was started/)
      // An abandoned attempt (over half an hour old) does not block it.
      await asSystem(db, null)
      await db.query(`update public.billing_payments set created_at = now() - interval '31 minutes' where invoice_id = $1`, [inv.id])
      await asUser(db, m.id, m.email, m.merchant)
      expect(await value(db, `select public.billing_choose_plan('STARTER')`)).toMatchObject({ applied: true })
    }))
})

describe('new-business offer: 99 Tk for 1 month + 2 days, then the one-time fee with the plan price', () => {
  const OFFER = { enabled: true, trial_months: 1, trial_days: 2, trial_price: 99, first_price: null, first_periods: 1, setup_fee: 1000 }
  const lineKinds = (i: { lines: Array<Record<string, any>> }) => i.lines.map((l) => [l.kind, Number(l.amount)])
  const openInvoice = async (db: Db, merchant: string) => (await invoices(db, merchant)).find((i) => i.status === 'OPEN')
  const coversMonthAndTwoDays = async (db: Db, id: string) => {
    await asSystem(db, null)
    return value<boolean>(db, `select period_end = period_start + interval '1 month 2 days' from public.billing_invoices where id = $1`, [id])
  }

  it('99 Tk opens 1 month + 2 days; to continue, 1,000 Tk once with the plan price (closed until paid); then the plan price', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      await asAnon(db, null)
      const options = await value<{ plans: Array<{ code: string; offer: Record<string, unknown> | null }> }>(db, `select public.public_signup_options()`)
      expect(options.plans.find((p) => p.code === 'GROWTH')!.offer).toMatchObject({ trial_months: 1, trial_days: 2, trial_price: 99, first_price: null, setup_fee: 1000 })

      // Signed up: closed until the 99 Tk is paid; the invoice covers 1 month + 2 days.
      const m = await signUpAs(db)
      expect(m.r).toMatchObject({ status: 'ACTIVE', activation: { state: 'awaiting_payment' } })
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      const [first] = await invoices(db, m.merchant)
      expect(first).toMatchObject({ total: 99, status: 'OPEN' })
      expect(lineKinds(first)).toEqual([['plan', 99]])
      expect(first.lines[0].label).toContain('(introductory price; then 5,000 BDT)')
      expect(await coversMonthAndTwoDays(db, first.id)).toBe(true)

      // Paid: open for the whole 1 month + 2 days, with nothing more to pay in it.
      expect(await pay(db, m.merchant, first.id, 99)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      let s = await sub(db, m.merchant)
      expect(s.current_period_end).toBe(s.intro_until)
      await asSystem(db, null)
      expect(await value(db, `select current_period_end = current_period_start + interval '1 month 2 days' from public.subscriptions where id = $1`, [s.id])).toBe(true)
      await db.query(`select public.billing_run()`)
      expect(await openInvoice(db, m.merchant)).toBeUndefined()

      // The period is over: the one-time fee with the first month at the plan's price, closed until paid.
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      const second = (await openInvoice(db, m.merchant))!
      expect(lineKinds(second)).toEqual([['plan', 5000], ['setup_fee', 1000]])
      expect(await accessOf(db, m.merchant)).toBe('BLOCKED')
      expect(await pay(db, m.merchant, second.id, 6000)).toBe('succeeded')
      expect(await accessOf(db, m.merchant)).toBe('FULL')

      // Then the plan price, with the normal grace period.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.merchant])
      await db.query(`select public.billing_run()`)
      expect(lineKinds((await openInvoice(db, m.merchant))!)).toEqual([['plan', 5000]])
      s = await sub(db, m.merchant)
      expect(s.status).toBe('PAST_DUE')
      expect(await accessOf(db, m.merchant)).toBe('FULL')
    }))

  it('choosing another plan before paying raises the same 1 month + 2 days invoice', () =>
    inTx(async (db) => {
      await onlinePayment(db)
      await offer(db, OFFER)
      const m = await signUpAs(db, 'GROWTH')
      await asUser(db, m.id, m.email, m.merchant)
      const r = await value<{ activation_invoice_id: string }>(db, `select public.billing_choose_plan('STARTER')`)
      const [inv] = await invoices(db, m.merchant)
      expect(inv).toMatchObject({ id: r.activation_invoice_id, total: 99, status: 'OPEN' })
      expect(inv.lines[0].label).toContain('(introductory price; then 2,500 BDT)')
      expect(await coversMonthAndTwoDays(db, inv.id)).toBe(true)
    }))

  it('WhatsApp sign-up: the team activating it is the 99 Tk payment', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'whatsapp', whatsapp_number: '8801999000111', reminder_days: [1] })])
      await offer(db, OFFER)
      const m = await signUpAs(db)
      await asStaff(db, superId)
      await value(db, `select public.platform_merchant_activate($1, 'Paid 99 Tk by bKash, TrxID 7QK2')`, [m.merchant])
      const s = await sub(db, m.merchant)
      expect(s).toMatchObject({ status: 'ACTIVE', intro_trial: true })
      expect(s.current_period_end).toBe(s.intro_until)
      await asSystem(db, null)
      expect(await value(db, `select current_period_end = current_period_start + interval '1 month 2 days' from public.subscriptions where id = $1`, [s.id])).toBe(true)
      expect(await accessOf(db, m.merchant)).toBe('FULL')
      expect(await invoices(db, m.merchant)).toEqual([])
    }))

  it('Super Admin sets the months, checked', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asStaff(db, superId)
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1, '1 month + 2 days for 99')`,
        [JSON.stringify({ enabled: true, trial_months: '1', trial_days: '2', trial_price: '99', first_price: '', first_periods: '1', setup_fee: '1000' })]))
        .toEqual({ enabled: true, trial_months: 1, trial_days: 2, trial_price: 99, first_price: null, first_periods: 1, setup_fee: 1000 })
      // Months alone are a period too.
      expect(await value(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_months: '1', trial_days: '0', trial_price: '99', first_price: '', first_periods: '1' })]))
        .toMatchObject({ trial_months: 1, trial_days: 0, trial_price: 99 })
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_months: '13', trial_days: '2', trial_price: '99', first_price: '', first_periods: '1' })], /months are 0 to 12/)
      await expectError(db, `select public.platform_setting_save('signup_offer', $1)`,
        [JSON.stringify({ enabled: true, trial_months: 'one', trial_days: '2', trial_price: '99', first_price: '', first_periods: '1' })], /months are 0 to 12/)
    }))
})

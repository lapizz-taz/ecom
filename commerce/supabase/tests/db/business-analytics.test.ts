import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function merchant(db: Db, superId: string, demo = false): Promise<string> {
  await as(db, superId)
  const m = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}`, is_demo: demo })])
  return m.id
}

/** A paying merchant: monthly plan at `price`, a paid invoice and a verified payment of it. */
async function paying(db: Db, id: string, price: number) {
  await asSystem(db, null)
  await db.query(`update public.subscriptions set status = 'ACTIVE', price = $2, billing_interval = 'MONTH', trial_ends_at = now() - interval '1 day',
    current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days' where merchant_id = $1 and ended_at is null`, [id, price])
  const inv = await value<string>(db, `insert into public.billing_invoices (merchant_id, subscription_id, kind, lines, total, amount_paid, status, due_at, paid_at, period_start, period_end)
    select $1, s.id, 'SUBSCRIPTION', '[]', $2, $2, 'PAID', now(), now(), now() - interval '1 day', now() + interval '29 days'
    from public.subscriptions s where s.merchant_id = $1 and s.ended_at is null returning id`, [id, price])
  await db.query(`insert into public.billing_payments (merchant_id, invoice_id, amount, method, status, verified_at) values ($1, $2, $3, 'BANK', 'SUCCEEDED', now())`, [id, inv, price])
}

async function usage(db: Db, id: string, service: 'SMS' | 'BD_COURIER', status: string, opts: { units?: number; cost?: number | null; charge?: string } = {}) {
  await asSystem(db, null)
  await db.query(`insert into public.service_usage (merchant_id, service, units, status, charge, credits, credit_type, idempotency_key, provider_cost)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, service, opts.units ?? 1, status, opts.charge ?? 'CREDITS', opts.charge === 'FREE' ? 0 : opts.units ?? 1,
    service === 'SMS' ? 'SMS' : 'COURIER', randomUUID(), opts.cost ?? null])
}

type Report = {
  mrr: { mrr: number; arr: number; paying: number }
  revenue: { total: number; subscriptions: number; credits: number; by_plan: Array<{ code: string; amount: number }> }
  sms: { units: number; credit_sales: number; provider_cost_reported: number; provider_cost_estimated: number | null; units_without_cost: number }
  bd_courier: { lookups: number; cost_estimated: number | null }
  subscriptions: { churned: number; paying_at_start: number; churn_rate: number | null }
  costs: { total: number; by_category: Record<string, number> }
  margin: { revenue: number; known_costs: number; estimated_costs: number; contribution: number; complete: boolean; missing: string[]; assumptions: string[] }
  merchants: { new: number; total: number }
}
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

describe('analytics: revenue, costs and margin', () => {
  it('counts only verified money, labels estimates, lists what is missing and leaves demo merchants out', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const a = await merchant(db, superId)
      const b = await merchant(db, superId)
      const demo = await merchant(db, superId, true)
      await paying(db, a, 990)
      await paying(db, b, 2490)
      await paying(db, demo, 5990)
      // A payment still waiting for a second person is not revenue.
      await asSystem(db, null)
      const open = await value<string>(db, `insert into public.billing_invoices (merchant_id, kind, lines, total, due_at) values ($1, 'OTHER', '[]', 500, now()) returning id`, [a])
      await db.query(`insert into public.billing_payments (merchant_id, invoice_id, amount, method, status) values ($1, $2, 500, 'BANK', 'PENDING')`, [a, open])
      // SMS: two parts with the provider's own cost, three without; BD Courier: four lookups.
      await usage(db, a, 'SMS', 'SUCCEEDED', { units: 2, cost: 0.6 })
      await usage(db, a, 'SMS', 'SUCCEEDED', { units: 3 })
      await usage(db, b, 'SMS', 'FAILED', { units: 1 })
      for (let i = 0; i < 4; i++) await usage(db, b, 'BD_COURIER', 'SUCCEEDED')
      await usage(db, demo, 'BD_COURIER', 'SUCCEEDED')
      await db.query(`update public.platform_settings set value = value || '{"cost_per_segment": 0.25}' where key = 'sms'`)
      await db.query(`update public.platform_settings set value = '{"bd_courier_per_lookup": null, "payment_fee_percent": null}' where key = 'cost_assumptions'`)

      await as(db, support)
      await expectError(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()], /PERMISSION_DENIED/)
      await as(db, billing)
      let r = await value<Report>(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()])
      // Other test merchants may exist; compare what these two add.
      expect(r.revenue.subscriptions).toBeGreaterThanOrEqual(990 + 2490)
      expect(r.revenue.by_plan.reduce((s, p) => s + Number(p.amount), 0)).toBe(Number(r.revenue.subscriptions))
      expect(r.mrr.arr).toBe(r.mrr.mrr * 12)
      expect(r.sms.provider_cost_reported).toBeGreaterThanOrEqual(0.6)
      expect(r.sms.units_without_cost).toBeGreaterThanOrEqual(3)
      expect(r.sms.provider_cost_estimated).toBe(r.sms.units_without_cost * 0.25)
      expect(r.bd_courier.lookups).toBeGreaterThanOrEqual(4)
      expect(r.bd_courier.cost_estimated).toBeNull()
      expect(r.margin.complete).toBe(false)
      expect(r.margin.missing.join(' ')).toMatch(/BD Courier lookups have no cost per lookup set/)
      expect(r.margin.missing.join(' ')).toMatch(/Recorded costs cover 0 of/)
      expect(r.margin.assumptions.join(' ')).toMatch(/0.25 BDT each/)
      const before = r

      // The demo merchant's 5,990 and lookup are never counted.
      await asSystem(db, null)
      await db.query(`update public.merchants set is_demo = false where id = $1`, [demo])
      await as(db, billing)
      const withDemo = await value<Report>(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()])
      expect(withDemo.revenue.subscriptions - before.revenue.subscriptions).toBe(5990)
      expect(withDemo.bd_courier.lookups - before.bd_courier.lookups).toBe(1)
      await asSystem(db, null)
      await db.query(`update public.merchants set is_demo = true where id = $1`, [demo])

      // Costs: recorded from bills, append-only; assumptions fill the gaps and say so.
      await as(db, support)
      await expectError(db, `select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: today(), category: 'INFRASTRUCTURE', amount: 1000, note: 'Hosting' })], /PERMISSION_DENIED/)
      await as(db, billing)
      await expectError(db, `select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: today(), category: 'INFRASTRUCTURE', amount: -50, note: 'Oops' })], /which entry it corrects/)
      await expectError(db, `select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: '2099-01-01', category: 'INFRASTRUCTURE', amount: 5, note: 'Future' })], /not in the future/)
      const hosting = await value<{ id: number }>(db, `select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: today(), category: 'INFRASTRUCTURE', amount: 3200, note: 'Supabase + Vercel' })])
      await db.query(`select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: today(), category: 'INFRASTRUCTURE', amount: -200, note: 'Vercel credit applied', corrects: hosting.id })])
      await db.query(`select public.platform_cost_entry_add($1)`, [JSON.stringify({ month: daysAgo(30), category: 'OTHER', amount: 100, note: 'Domain renewal' })])
      await expectError(db, `select public.platform_cost_assumptions_save('{"bd_courier_per_lookup": -1}')`, [], /positive number/)
      await db.query(`select public.platform_cost_assumptions_save('{"bd_courier_per_lookup": 1.5, "payment_fee_percent": 1.85}', 'From the BD Courier contract')`)
      r = await value<Report>(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()])
      expect(r.costs.by_category.INFRASTRUCTURE).toBe(3000)
      expect(r.bd_courier.cost_estimated).toBe(r.bd_courier.lookups * 1.5)
      expect(r.margin.missing).toEqual([])
      expect(r.margin.complete).toBe(true)
      expect(r.margin.contribution).toBeCloseTo(r.margin.revenue - r.margin.known_costs - r.margin.estimated_costs, 2)
      expect(r.margin.assumptions.join(' ')).toMatch(/1.5 BDT each/)
      expect(r.margin.assumptions.join(' ')).toMatch(/1.85% of money received/)

      await asSystem(db, null)
      await expectError(db, `update public.platform_cost_entries set amount = 1 where id = $1`, [hosting.id], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.platform_cost_entries where id = $1`, [hosting.id], /IMMUTABLE_RECORD/)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action like 'analytics.%' and actor_id = $1`, [billing])).toBe(4)
    }))

  it('measures churn against paying subscriptions at the start of the range', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superId)
      const base = await value<Report>(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()])
      const a = await merchant(db, superId)
      const b = await merchant(db, superId)
      await asSystem(db, null)
      for (const id of [a, b]) {
        await db.query(`update public.subscriptions set status = 'ACTIVE', price = 990, started_at = now() - interval '90 days',
          trial_ends_at = now() - interval '80 days', created_at = now() - interval '90 days' where merchant_id = $1 and ended_at is null`, [id])
      }
      await db.query(`update public.subscriptions set status = 'EXPIRED', ended_at = now() - interval '3 days' where merchant_id = $1 and ended_at is null`, [b])
      await as(db, superId)
      const r = await value<Report>(db, `select public.platform_business_report($1, $2)`, [daysAgo(30), today()])
      expect(r.subscriptions.paying_at_start - base.subscriptions.paying_at_start).toBe(2)
      expect(r.subscriptions.churned - base.subscriptions.churned).toBe(1)
      expect(r.subscriptions.churn_rate).toBe(Math.round((r.subscriptions.churned / r.subscriptions.paying_at_start) * 1000) / 10)
    }))
})

describe('analytics: usage and merchant health', () => {
  it('shows each merchant’s SMS and BD Courier use with what is left, and explains health signals', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const a = await merchant(db, superId)
      await usage(db, a, 'SMS', 'SUCCEEDED', { units: 2 })
      await usage(db, a, 'SMS', 'SUCCEEDED', { units: 1, charge: 'FREE' })
      await usage(db, a, 'SMS', 'FAILED', { units: 1 })
      await usage(db, a, 'BD_COURIER', 'SUCCEEDED')
      await usage(db, a, 'BD_COURIER', 'DENIED', { charge: 'NONE' })
      await as(db, support)
      const u = await value<{ merchants: Array<Record<string, any>> }>(db, `select public.platform_usage_overview($1, $2)`, [daysAgo(7), today()])
      const row = u.merchants.find((m) => m.id === a)!
      expect(row).toMatchObject({ sms_attempted: 3, sms_sent: 2, sms_failed: 1, sms_billable: 2, sms_free: 1, bd_attempted: 1, bd_succeeded: 1, bd_refused: 1, bd_billable: 1 })
      expect(row.sms_state).toHaveProperty('free_remaining')
      expect(row.bd_state).toHaveProperty('monthly_cap')

      // Health: a failing store connection and an overdue payment.
      await asSystem(db, null)
      await db.query(`insert into public.sales_channels (merchant_id, platform, name, shop_domain, status) values ($1, 'SHOPIFY', 'Shop', $2, 'ERROR')`,
        [a, `h-${randomUUID().slice(0, 6)}.myshopify.com`])
      await db.query(`update public.subscriptions set status = 'PAST_DUE', grace_until = now() + interval '3 days' where merchant_id = $1 and ended_at is null`, [a])
      await as(db, support)
      const h = await value<{ rows: Array<{ id: string; score: number; band: string; needs: string[]; signals: Array<{ key: string; points: number }> }>; method: string }>(db,
        `select public.platform_merchant_health('{"need":"billing"}')`)
      const mh = h.rows.find((r) => r.id === a)!
      expect(mh.signals.map((s) => s.key)).toEqual(expect.arrayContaining(['store_error', 'past_due']))
      expect(mh.score).toBe(100 - mh.signals.reduce((s, x) => s + x.points, 0))
      expect(mh.needs).toEqual(expect.arrayContaining(['technical', 'billing']))
      expect(h.method).toMatch(/not a churn decision/)
      const technical = await value<{ rows: Array<{ id: string }> }>(db, `select public.platform_merchant_health('{"need":"activity"}')`)
      expect(technical.rows.map((r) => r.id)).not.toContain(a)

      // The overview shows billing only to those allowed to see billing.
      const o = await value<{ billing: unknown; metered: { bd_lookups: number } }>(db, `select public.platform_overview_business($1, $2)`, [daysAgo(7), today()])
      expect(o.billing).toBeNull()
      expect(o.metered.bd_lookups).toBeGreaterThanOrEqual(1)
      await as(db, superId)
      const o2 = await value<{ billing: { past_due: number } }>(db, `select public.platform_overview_business($1, $2)`, [daysAgo(7), today()])
      expect(o2.billing.past_due).toBeGreaterThanOrEqual(1)
    }))
})

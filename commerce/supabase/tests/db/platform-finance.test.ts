import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
const dhakaDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
const today = () => dhakaDate(new Date())
const daysAgo = (n: number) => dhakaDate(new Date(Date.now() - n * 86_400_000))

type Ledger = {
  total: number; count: number; usd_total: number | null
  categories: Array<{ id: string; code: string; total: number; count: number }>
  days: Array<{ date: string; total: number; cells: Record<string, { amount: number; count: number; usd: number | null }> }>
}
type Entries = { total: number; sum: number; items: Array<{ id: string; source: string; amount: number; editable: boolean; voided: boolean; merchant: string | null; category: { code: string } }> }

async function category(db: Db, type: 'INCOME' | 'EXPENSE', code: string): Promise<string> {
  await asSystem(db, null)
  return value<string>(db, `select id from public.platform_finance_categories where type = $1 and code = $2`, [type, code])
}

async function merchant(db: Db, superId: string, demo = false): Promise<string> {
  await as(db, superId)
  const m = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}`, is_demo: demo })])
  return m.id
}

/** A verified payment from a merchant for an invoice of this kind. */
async function payment(db: Db, merchantId: string, kind: string, amount: number): Promise<string> {
  await asSystem(db, null)
  const inv = await value<string>(db, `insert into public.billing_invoices (merchant_id, kind, lines, total, amount_paid, status, due_at, paid_at)
    values ($1, $2, '[]', $3, $3, 'PAID', now(), now()) returning id`, [merchantId, kind, amount])
  return value<string>(db, `insert into public.billing_payments (merchant_id, invoice_id, amount, method, status, verified_at)
    values ($1, $2, $3, 'BANK', 'SUCCEEDED', now()) returning id`, [merchantId, inv, amount])
}

describe('Super Admin income & expenses', () => {
  it('records, edits and deletes entries by hand, with platform permissions', () =>
    inTx(async (db) => {
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const salary = await category(db, 'EXPENSE', 'SALARY')
      const servers = await category(db, 'EXPENSE', 'INFRASTRUCTURE')
      const services = await category(db, 'INCOME', 'SERVICES')
      const subscriptions = await category(db, 'INCOME', 'SUBSCRIPTIONS')

      await as(db, support)
      await expectError(db, `select public.platform_finance_ledger('EXPENSE', $1, $2)`, [daysAgo(30), today()], /PERMISSION_DENIED/)
      await as(db, viewer)
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: salary, amount: 1000, txn_date: today() })], /PERMISSION_DENIED/)

      await as(db, billing)
      const a = await value<{ id: string; txn_number: string }>(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: salary, sub_category: 'Support team', amount: 25000, txn_date: daysAgo(2), notes: 'October salaries' })])
      expect(a.txn_number).toMatch(/^PF-\d{6}$/)
      // USD is converted at the rate given.
      const b = await value<{ amount: string }>(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: servers, sub_category: 'Cloudflare', foreign_amount: 25, foreign_currency: 'usd', exchange_rate: 122, txn_date: daysAgo(1) })])
      expect(Number(b.amount)).toBe(3050)
      await value(db, `select public.platform_finance_entry_save($1)`, [JSON.stringify({ type: 'INCOME', category_id: services, amount: 5000, txn_date: today() })])

      // Wrong type, auto-only category, future date, nothing to record.
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'INCOME', category_id: salary, amount: 10, txn_date: today() })], /choose a income category/)
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'INCOME', category_id: subscriptions, amount: 10, txn_date: today() })], /filled automatically/)
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: salary, amount: 10, txn_date: dhakaDate(new Date(Date.now() + 3 * 86_400_000)) })], /not in the future/)
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: salary, amount: 0, txn_date: today() })], /above 0/)

      let ledger = await value<Ledger>(db, `select public.platform_finance_ledger('EXPENSE', $1, $2)`, [daysAgo(30), today()])
      expect(Number(ledger.total)).toBe(28050)
      expect(ledger.count).toBe(2)
      expect(Number(ledger.usd_total)).toBe(25)
      expect(Number(ledger.categories.find((c) => c.code === 'SALARY')!.total)).toBe(25000)
      expect(Number(ledger.days.find((d) => d.date === daysAgo(1))!.cells[servers].usd)).toBe(25)

      // Edit, then delete: deleted entries stop counting but stay on record.
      await value(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ id: a.id, category_id: salary, amount: 26000, txn_date: daysAgo(2), reason: 'bonus' })])
      await expectError(db, `select public.platform_finance_entry_void($1, '')`, [a.id], /say why/)
      await value(db, `select public.platform_finance_entry_void($1, 'Entered twice')`, [a.id])
      await expectError(db, `select public.platform_finance_entry_void($1, 'again')`, [a.id], /already deleted/)
      await expectError(db, `select public.platform_finance_entry_save($1)`,
        [JSON.stringify({ id: a.id, category_id: salary, amount: 1, txn_date: today() })], /not deleted/)
      ledger = await value<Ledger>(db, `select public.platform_finance_ledger('EXPENSE', $1, $2)`, [daysAgo(30), today()])
      expect(Number(ledger.total)).toBe(3050)
      const shown = await value<Entries>(db, `select public.platform_finance_entries($1)`,
        [JSON.stringify({ type: 'EXPENSE', from: daysAgo(30), to: today(), show_voided: true })])
      expect(shown.items.map((e) => e.voided).sort()).toEqual([false, true])
      expect(Number(shown.sum)).toBe(3050)

      await as(db, viewer)
      const overview = await value<{ income: number; expense: number; series: unknown[]; can_create: boolean }>(db,
        `select public.platform_finance_overview($1, $2)`, [daysAgo(6), today()])
      expect(Number(overview.expense)).toBe(3050)
      expect(Number(overview.income)).toBeGreaterThanOrEqual(5000)
      expect(overview.series).toHaveLength(7)
      expect(overview.can_create).toBe(false)

      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where entity_type = 'platform_finance_entry' and actor_id = $1`, [billing])).toBe(5)
    }))

  it('counts money merchants paid (not demo merchants) as income and refunds as expense', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const shop = await merchant(db, superId)
      const demo = await merchant(db, superId, true)
      const before = await (async () => { await as(db, superId); return value<Ledger>(db, `select public.platform_finance_ledger('INCOME', $1, $2)`, [today(), today()]) })()
      const sub = await payment(db, shop, 'SUBSCRIPTION', 990)
      await payment(db, shop, 'CREDITS', 500)
      await payment(db, demo, 'SUBSCRIPTION', 5990)
      await db.query(`insert into public.billing_refunds (payment_id, merchant_id, amount, reason, method, status, completed_at)
        values ($1, $2, 200, 'Charged twice by mistake', 'MANUAL', 'SUCCEEDED', now())`, [sub, shop])

      await as(db, superId)
      const after = await value<Ledger>(db, `select public.platform_finance_ledger('INCOME', $1, $2)`, [today(), today()])
      const total = (l: Ledger, code: string) => Number(l.categories.find((c) => c.code === code)?.total ?? 0)
      expect(total(after, 'SUBSCRIPTIONS') - total(before, 'SUBSCRIPTIONS')).toBe(990)
      expect(total(after, 'CREDITS') - total(before, 'CREDITS')).toBe(500)
      const items = await value<Entries>(db, `select public.platform_finance_entries($1)`, [JSON.stringify({ type: 'INCOME', from: today(), to: today(), source: 'BILLING' })])
      const mine = items.items.filter((e) => e.merchant && e.id.startsWith('billing:') && Number(e.amount) !== 5990)
      expect(mine.every((e) => !e.editable)).toBe(true)
      const expense = await value<Entries>(db, `select public.platform_finance_entries($1)`, [JSON.stringify({ type: 'EXPENSE', from: today(), to: today() })])
      expect(expense.items.find((e) => e.id.startsWith('refund:'))).toMatchObject({ category: { code: 'MERCHANT_REFUNDS' }, editable: false })
    }))

  it('syncs Meta ad spend once per account and day, converted to taka', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superId)
      await expectError(db, `select public.platform_ad_account_save($1, $2)`,
        [JSON.stringify({ name: 'Fullfilio ads', ad_account_id: 'act_123456', usd_rate: 122 }), superId], /permission denied/i)

      await asService(db, null)
      const acct = await value<{ id: string }>(db, `select public.platform_ad_account_save($1, $2)`,
        [JSON.stringify({ name: 'Fullfilio ads', ad_account_id: 'act_123456', usd_rate: 122, meta: { name: 'Fullfilio', currency: 'USD', token_hint: '••••abcd', status: 'OK' } }), superId])
      await expectError(db, `select public.platform_ad_account_save($1, $2)`,
        [JSON.stringify({ name: 'Again', ad_account_id: 'act_123456', usd_rate: 120 }), superId], /already connected/)
      const rows = [{ date: daysAgo(2), spend: 10 }, { date: daysAgo(1), spend: 12.5 }, { date: today(), spend: 0 }]
      let r = await value<{ days: number; amount: number }>(db, `select public.platform_ad_spend_apply($1, $2, $3, $4)`, [acct.id, daysAgo(2), today(), JSON.stringify(rows)])
      expect(r.days).toBe(2)
      expect(Number(r.amount)).toBe(2745)
      // Running the same window again changes nothing; Meta's correction updates the day; a day that drops to 0 goes.
      await value(db, `select public.platform_ad_spend_apply($1, $2, $3, $4)`, [acct.id, daysAgo(2), today(), JSON.stringify(rows)])
      r = await value(db, `select public.platform_ad_spend_apply($1, $2, $3, $4)`,
        [acct.id, daysAgo(1), today(), JSON.stringify([{ date: daysAgo(1), spend: 0 }, { date: today(), spend: 4 }])])
      await asSystem(db, null)
      const stored = (await db.query(`select txn_date::text as d, amount::numeric as amount, foreign_amount::numeric as usd from public.platform_finance_entries
        where ad_account_id = $1 order by txn_date`, [acct.id])).rows
      expect(stored.map((s) => [s.d, Number(s.amount), Number(s.usd)])).toEqual([[daysAgo(2), 1220, 10], [today(), 488, 4]])

      await as(db, superId)
      const list = await value<{ accounts: Array<{ spend_30d: number; days: number; token_hint: string }> }>(db, `select public.platform_ad_accounts_list()`)
      expect(Number(list.accounts[0].spend_30d)).toBe(1708)
      const ad = await value<Entries>(db, `select public.platform_finance_entries($1)`, [JSON.stringify({ type: 'EXPENSE', source: 'META_ADS', from: daysAgo(5), to: today() })])
      expect(ad.items).toHaveLength(2)
      expect(ad.items.every((e) => !e.editable && e.category.code === 'ADVERTISING')).toBe(true)
      await expectError(db, `select public.platform_finance_entry_void($1, 'not ours')`, [ad.items[0].id], /disconnect it there/)

      // Disconnecting stops the sync and forgets the token; the spend stays.
      await asService(db, null)
      const off = await value<{ is_active: boolean; status: string; token_hint: string | null; days: number }>(db,
        `select public.platform_ad_account_disconnect($1, $2)`, [acct.id, superId])
      expect(off).toMatchObject({ is_active: false, status: 'DISCONNECTED', token_hint: null, days: 2 })
      expect(await value<number>(db, `select count(*)::int from public.platform_ad_accounts_for_sync(null)`)).toBe(0)
    }))

  it('adds categories and keeps built-in ones switched on', () =>
    inTx(async (db) => {
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const ops = await createPlatformStaff(db, 'OPERATIONS_MANAGER')
      const salary = await category(db, 'EXPENSE', 'SALARY')
      await as(db, ops)
      await expectError(db, `select public.platform_finance_category_save($1)`, [JSON.stringify({ type: 'EXPENSE', name: 'Snacks' })], /PERMISSION_DENIED/)
      await as(db, billing)
      const c = await value<{ id: string; code: string; allow_manual: boolean }>(db, `select public.platform_finance_category_save($1)`,
        [JSON.stringify({ type: 'EXPENSE', name: 'Office snacks', color: 'pink', subcategories: ['Tea', 'Tea', ' '] })])
      expect(c.code).toMatch(/^OFFICE_SNACKS_[A-F0-9]{4}$/)
      const updated = await value<{ subcategories: string[]; is_active: boolean }>(db, `select public.platform_finance_category_save($1)`,
        [JSON.stringify({ id: c.id, subcategories: ['Tea', 'Biscuits'], is_active: false })])
      expect(updated).toMatchObject({ subcategories: ['Biscuits', 'Tea'], is_active: false })
      await expectError(db, `select public.platform_finance_category_save($1)`, [JSON.stringify({ id: salary, is_active: false })], /stay on/)
      const list = await value<Array<{ code: string }>>(db, `select public.platform_finance_categories_list()`)
      expect(list.some((x) => x.code === 'MERCHANT_REFUNDS')).toBe(true)
    }))
})

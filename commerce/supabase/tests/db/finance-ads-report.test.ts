import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function today(db: Db): Promise<string> {
  await asSystem(db)
  return value<string>(db, `select ((now() at time zone public.store_timezone())::date)::text`)
}

type Ledger = {
  total: number; count: number
  categories: Array<{ id: string; code: string; total: number; count: number; subcategories: string[] }>
  days: Array<{ date: string; total: number; cells: Record<string, { amount: number; count: number }> }>
}

describe('income & expense ledger', () => {
  it('moves the payment account, edits by reversal and shows only live entries in the matrix', () =>
    inTx(async (db) => {
      const d = await today(db)
      const account = await value<string>(db, `insert into public.finance_accounts(name, kind, opening_balance) values ('Test bKash', 'MOBILE_WALLET', 1000) returning id`)
      const rent = await value<string>(db, `select id from public.finance_categories where code = 'RENT'`)
      await asUser(db, await createStaff(db, 'FINANCE_MANAGER'))
      const balance = async () => num(await value(db, `select coalesce(sum(amount), 0) from public.finance_account_movements where account_id = $1`, [account]))

      const id = await value<string>(db, `select id from public.create_finance_transaction($1)`,
        [JSON.stringify({ type: 'EXPENSE', category_id: rent, amount: 300, txn_date: d, account_id: account, sub_category: 'Office' })])
      expect(await balance()).toBe(-300)
      expect(await value(db, `select subcategories from public.finance_categories where id = $1`, [rent])).toContain('Office')

      // Edit = reverse + new entry; the account follows both.
      const edited = await value<string>(db, `select id from public.finance_entry_update($1, $2, 'Wrong amount')`,
        [id, JSON.stringify({ category_id: rent, amount: 450, txn_date: d, account_id: account, sub_category: 'Office' })])
      expect(edited).not.toBe(id)
      expect(await balance()).toBe(-450)
      await expectError(db, `select public.finance_entry_update($1, $2)`, [id, JSON.stringify({ category_id: rent, amount: 1 })], /already been reversed/)

      // Foreign-currency entries are converted with the rate.
      const ads = await value<string>(db, `select id from public.finance_categories where allow_manual and type = 'EXPENSE' and code <> 'RENT' order by code limit 1`)
      const usd = await value<Record<string, unknown>>(db, `select to_jsonb(public.create_finance_transaction($1))`,
        [JSON.stringify({ type: 'EXPENSE', category_id: ads, foreign_amount: 10, exchange_rate: 122, txn_date: d })])
      expect(num(usd.amount)).toBe(1220)
      expect(usd.foreign_currency).toBe('USD')

      const ledger = await value<Ledger>(db, `select public.finance_ledger('EXPENSE', $1, $1)`, [d])
      const rentRow = ledger.categories.find((c) => c.id === rent)!
      expect(num(rentRow.total)).toBe(450)
      expect(rentRow.count).toBe(1)
      const day = ledger.days.find((x) => x.date === d)!
      expect(num(day.cells[rent].amount)).toBe(450)
      expect(num(day.total)).toBeGreaterThanOrEqual(1670)

      const entries = await value<{ items: Array<{ id: string; reversed: boolean; is_reversal: boolean; editable: boolean }> }>(db,
        `select public.finance_entries($1)`, [JSON.stringify({ type: 'EXPENSE', from: d, to: d, category_id: rent })])
      const live = entries.items.filter((e) => !e.reversed && !e.is_reversal)
      expect(live.map((e) => e.id)).toEqual([edited])
      expect(live[0].editable).toBe(true)

      // Viewers can read but not write.
      await asUser(db, await createStaff(db, 'VIEWER'))
      await expectError(db, `select public.create_finance_transaction($1)`, [JSON.stringify({ type: 'EXPENSE', category_id: rent, amount: 1 })], /finance.manage|permission/i)
    }))
})

describe('ads report: campaign quality', () => {
  it('judges a campaign by delivered and returned orders and keeps untagged paid orders unknown', () =>
    inTx(async (db) => {
      const d = await today(db)
      await asService(db)
      await db.query(`select public.meta_ads_apply_sync($1)`, [JSON.stringify({
        account_id: 'act_rep', since: d, until: d, complete: true,
        campaigns: [{ id: '7001', name: 'Winter Jackets', status: 'ACTIVE', effective_status: 'ACTIVE' }],
        adsets: [{ id: '7101', campaign_id: '7001', name: 'Broad', status: 'ACTIVE' }],
        ads: [{ id: '7201', adset_id: '7101', campaign_id: '7001', name: 'Reel', status: 'ACTIVE' }],
        insights: [{ ad_id: '7201', adset_id: '7101', campaign_id: '7001', date: d, platform: 'facebook', spend: '5', impressions: '500', clicks: '20', link_clicks: '10' }],
      })])

      const product = await createProduct(db, { price: 1000, cost: 400, stock: 20 })
      const order = async (phone: string, params: Record<string, string>, path: string[]) => {
        const o = await createOrder(db, { phone, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
        await asService(db)
        const t = { at: new Date().toISOString(), landing: '/', referrer: null, params }
        await db.query(`select public.record_order_attribution($1, $2)`, [o.id, JSON.stringify({ visitor_id: `v-${phone}`, first_touch: t, last_touch: t })])
        if (path.length) await advanceOrder(db, o.id, path)
        return o
      }
      const tagged = { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Winter Jackets', campaign_id: '7001', adset_id: '7101', ad_id: '7201', fbclid: 'x' }
      const shipped = ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED']
      await order('01711000701', tagged, [...shipped, 'DELIVERED'])
      await order('01711000702', tagged, [...shipped, 'DELIVERED'])
      await order('01711000703', tagged, [...shipped, 'DELIVERED'])
      await order('01711000704', tagged, [...shipped, 'FAILED_DELIVERY', 'RETURNED'])
      await order('01711000705', tagged, [])
      await order('01711000706', { utm_source: 'facebook', utm_medium: 'paid', fbclid: 'y' }, [])

      await asUser(db, await createStaff(db, 'MANAGER'))
      type Campaign = { key: string; platform: string; orders: number; delivered: number; returned: number; in_progress: number; delivery_rate: number; grade: string; verdict: string; unknown: boolean; spend: number }
      const report = await value<{ campaigns: Campaign[]; totals: Record<string, number> }>(db, `select public.report_ads($1, $1)`, [d])
      const c = report.campaigns.find((x) => x.key === '7001')!
      expect(c).toMatchObject({ platform: 'META', orders: 5, delivered: 3, returned: 1, in_progress: 1, unknown: false })
      expect(num(c.delivery_rate)).toBe(75)
      expect(num(c.spend)).toBeGreaterThan(0)
      expect(c.grade).toMatch(/^[A-D]$/)
      const unknown = report.campaigns.find((x) => x.unknown)!
      expect(unknown).toMatchObject({ key: '_paid_', orders: 1, verdict: 'WAIT' })
      expect(num(report.totals.unknown_campaign_orders)).toBe(1)

      await asUser(db, await createStaff(db, 'INVENTORY_MANAGER'))
      await expectError(db, `select public.report_ads($1, $1)`, [d], /marketing.view|permission/i)
    }))
})

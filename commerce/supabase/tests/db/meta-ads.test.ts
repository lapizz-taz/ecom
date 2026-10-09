import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, setSetting } from '../support/fixtures'

afterAll(closePool)

const TODAY_SQL = `(now() at time zone public.store_timezone())::date`

async function today(db: Db): Promise<string> {
  await asSystem(db)
  return value<string>(db, `select ${TODAY_SQL}::text`)
}

const insight = (ad: string, adset: string, campaign: string, date: string, platform: string, spend: number, extra: Record<string, unknown> = {}) => ({
  ad_id: ad, adset_id: adset, campaign_id: campaign, date, platform, spend: String(spend),
  impressions: String(spend * 100), clicks: String(spend), link_clicks: String(Math.round(spend / 2)),
  campaign_name: `Campaign ${campaign}`, adset_name: `Ad set ${adset}`, ad_name: `Ad ${ad}`, ...extra,
})

async function sync(db: Db, payload: Record<string, unknown>) {
  await asService(db)
  return value<Record<string, number>>(db, `select public.meta_ads_apply_sync($1)`, [JSON.stringify(payload)])
}

async function advertising(db: Db, from: string, to: string) {
  await asSystem(db)
  return num(await value(db, `select coalesce(sum(ft.amount), 0) from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id where c.code = 'ADVERTISING' and ft.txn_date between $1 and $2`, [from, to]))
}

/** An order placed from a tracked link (or none), optionally delivered. */
async function trackedOrder(db: Db, phone: string, params: Record<string, string> | null, opts: { price?: number; deliver?: boolean; referrer?: string } = {}) {
  const p = await createProduct(db, { price: opts.price ?? 1000, cost: 400, stock: 5 })
  const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  if (params || opts.referrer) {
    await asService(db)
    const t = { at: new Date().toISOString(), landing: '/product/belt', referrer: opts.referrer ?? null, params: params ?? {} }
    await db.query(`select public.record_order_attribution($1, $2)`, [order.id, JSON.stringify({ visitor_id: `visitor-${phone}`, first_touch: t, last_touch: t })])
  }
  if (opts.deliver) await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
  return { order, product: p }
}

const metaParams = (campaign: string, adset: string, ad: string, site = 'fb') => ({
  utm_source: 'facebook', utm_medium: 'paid', utm_campaign: `Campaign ${campaign}`, campaign_id: campaign, adset_id: adset, ad_id: ad,
  site_source_name: site, fbclid: 'IwAR123',
})

describe('Meta Ads sync', () => {
  it('stores campaigns, ad sets, ads and daily spend, converted to the store currency, and posts it to Finance once', () =>
    inTx(async (db) => {
      await setSetting(db, 'meta_ads', { exchange_rate: 120, tax_percent: 15 })
      const d = await today(db)
      const payload = {
        account_id: 'act_42', since: d, until: d, complete: true,
        campaigns: [{ id: '9001', name: 'Korean Belt', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '500000' }],
        adsets: [{ id: '9101', campaign_id: '9001', name: 'Broad 18-30', status: 'ACTIVE' }],
        ads: [{ id: '9201', adset_id: '9101', campaign_id: '9001', name: 'Belt Reel 03', status: 'ACTIVE',
          creative: { id: '77', name: 'Reel', thumbnail_url: 'https://scontent.example/t.jpg', title: 'Belt' } }],
        insights: [
          insight('9201', '9101', '9001', d, 'facebook', 10, { purchases: 2, purchase_value: 30 }),
          insight('9201', '9101', '9001', d, 'instagram', 5),
        ],
      }
      const r = await sync(db, payload)
      expect(r).toMatchObject({ campaigns: 1, adsets: 1, ads: 1, insights: 2 })
      // 15 USD × 120 × 1.15 = 2,070
      expect(num(r.cost)).toBe(2070)
      await asSystem(db)
      expect(await value(db, `select daily_budget::text from public.meta_campaigns where id = '9001'`)).toBe('5000.00')
      const spend = await value<Record<string, unknown>>(db, `select to_jsonb(s) from public.marketing_spend s
        join public.marketing_campaigns c on c.id = s.campaign_id where c.external_id = '9001'`)
      expect(spend).toMatchObject({ spend: 2070, orders: 2, revenue: 3600, source: 'API' })
      expect(await advertising(db, d, d)).toBe(2070)

      // Same numbers again: nothing changes, nothing is posted twice.
      await sync(db, payload)
      expect(await advertising(db, d, d)).toBe(2070)

      // Meta revises the day; the instagram row disappears (complete sync): one correction.
      await sync(db, { ...payload, insights: [insight('9201', '9101', '9001', d, 'facebook', 12)] })
      await asSystem(db)
      expect(num(await value(db, `select cost from public.meta_ad_insights where ad_id = '9201' and platform = 'instagram'`))).toBe(0)
      expect(await advertising(db, d, d)).toBe(1656)
      expect(num(await value(db, `select count(*) from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
        where c.code = 'ADVERTISING' and ft.txn_date = $1`, [d]))).toBe(2)
    }))

  it('keeps names of archived items that only appear in insights, and recalculates when the rate changes', () =>
    inTx(async (db) => {
      const d = await today(db)
      await sync(db, { since: d, until: d, insights: [insight('8201', '8101', '8001', d, 'facebook', 100, { campaign_name: 'Old Eid Sale' })] })
      await asSystem(db)
      expect(await value(db, `select name from public.meta_campaigns where id = '8001'`)).toBe('Old Eid Sale')
      expect(await advertising(db, d, d)).toBe(100)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.meta_ads_update_settings(110, 0)`, [], /marketing\.manage|permission/i)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.meta_ads_update_settings(0, 0)`, [], /exchange rate/)
      await db.query(`select public.meta_ads_update_settings(110, 10)`)
      // 100 × 110 × 1.10 = 12,100
      expect(await advertising(db, d, d)).toBe(12100)
    }))

  it('refuses sync windows that are too long and calls from staff', () =>
    inTx(async (db) => {
      await expectError(db, `select public.meta_ads_apply_sync('{"since":"2026-01-01","until":"2026-12-31"}')`, [], /1 to 120 days/)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.meta_ads_apply_sync('{"since":"2026-10-01","until":"2026-10-01"}')`, [], /PERMISSION_DENIED|permission/i)
      await asAnon(db)
      expect(await value(db, `select count(*)::int from public.meta_ad_insights`).catch(() => 0)).toBe(0)
    }))
})

describe('attribution report', () => {
  async function scenario(db: Db) {
    const d = await today(db)
    await setSetting(db, 'meta_ads', { exchange_rate: 1, tax_percent: 0 })
    await sync(db, {
      since: d, until: d,
      campaigns: [{ id: '7001', name: 'Korean Belt', status: 'ACTIVE' }, { id: '7002', name: 'Wallets', status: 'ACTIVE' }],
      adsets: [{ id: '7101', campaign_id: '7001', name: 'Broad 18-30' }, { id: '7102', campaign_id: '7002', name: 'Retarget' }],
      ads: [{ id: '7201', adset_id: '7101', campaign_id: '7001', name: 'Belt Reel 03' }, { id: '7202', adset_id: '7102', campaign_id: '7002', name: 'Wallet Static' }],
      insights: [
        insight('7201', '7101', '7001', d, 'facebook', 600),
        insight('7201', '7101', '7001', d, 'instagram', 200),
        insight('7202', '7102', '7002', d, 'facebook', 300),
      ],
    })
    const a = await trackedOrder(db, '01711001701', metaParams('7001', '7101', '7201'), { price: 1500, deliver: true })
    const b = await trackedOrder(db, '01711001702', metaParams('7001', '7101', '7201'), { price: 1200 })
    const c = await trackedOrder(db, '01711001703', metaParams('7001', '7101', '7201', 'ig'), { price: 900, deliver: true })
    const organic = await trackedOrder(db, '01711001704', { srsltid: 'AfmB' }, { price: 800, deliver: true, referrer: 'https://www.google.com/' })
    const unknown = await trackedOrder(db, '01711001705', null, { price: 700, deliver: true })
    return { d, a, b, c, organic, unknown }
  }

  async function report(db: Db, d: string, group: string, filters: Record<string, string> = {}) {
    const admin = await createStaff(db, 'ADMIN')
    await asUser(db, admin)
    return value<{ rows: Array<Record<string, unknown>>; totals: Record<string, number>; spend: number | null }>(db,
      `select public.report_attribution($1::date, $1::date, $2, $3)`, [d, group, JSON.stringify(filters)])
  }
  const row = (rows: Array<Record<string, unknown>>, label: string) => rows.find((r) => r.label === label)

  it('groups sales by source, with Meta spend split by placement and nothing guessed for Unknown', () =>
    inTx(async (db) => {
      const { d } = await scenario(db)
      const r = await report(db, d, 'source')
      const fb = row(r.rows, 'Facebook Ads')!
      expect(fb).toMatchObject({ orders: 2, delivered: 1, ad_spend: 900 })
      expect(num(fb.revenue)).toBeGreaterThan(0)
      expect(num(fb.roas)).toBeCloseTo(num(fb.revenue) / 900, 2)
      expect(num(fb.cost_per_order)).toBe(450)
      // Profit counts the cost of goods only for delivered orders (cost 400 each here).
      expect(num(fb.product_cost)).toBe(400)
      expect(num(fb.net_profit)).toBeCloseTo(num(fb.revenue) - 400 - num(fb.delivery_cost) - num(fb.return_cost) - 900, 2)
      expect(row(r.rows, 'Instagram Ads')).toMatchObject({ orders: 1, delivered: 1, ad_spend: 200 })
      expect(row(r.rows, 'Google')).toMatchObject({ orders: 1, ad_spend: null, roas: null })
      // No tracking data: Unknown, and no ad spend is ever assigned to it.
      expect(row(r.rows, 'Unknown')).toMatchObject({ orders: 1, ad_spend: null })
      expect(r.totals).toMatchObject({ orders: 5, delivered: 4, unattributed: 1 })
      expect(num(r.spend)).toBe(1100)
    }))

  it('drills into campaigns, ad sets and ads, shows campaigns that spent without orders, and leaves products without spend', () =>
    inTx(async (db) => {
      const { d, a } = await scenario(db)
      const campaigns = await report(db, d, 'campaign', { source: 'Facebook Ads' })
      expect(row(campaigns.rows, 'Korean Belt')).toMatchObject({ orders: 2, ad_spend: 600 })
      expect(row(campaigns.rows, 'Wallets')).toMatchObject({ orders: 0, ad_spend: 300, roas: 0 })

      const ads = await report(db, d, 'ad', { campaign: '7001' })
      expect(row(ads.rows, 'Belt Reel 03')).toMatchObject({ orders: 3, ad_spend: 800 })

      const delivered = await report(db, d, 'campaign', { campaign: '7001', status: 'delivered' })
      expect(row(delivered.rows, 'Korean Belt')).toMatchObject({ orders: 2, delivered: 2, ad_spend: 800 })

      const products = await report(db, d, 'product', { product: a.product.productId })
      expect(products.spend).toBeNull()
      expect(products.rows).toHaveLength(1)
      expect(products.rows[0]).toMatchObject({ orders: 1, ad_spend: null })

      const byDay = await report(db, d, 'date')
      expect(byDay.rows[0]).toMatchObject({ key: d, orders: 5, ad_spend: 1100 })
    }))

  it('reports Meta campaigns with their numbers and the orders their links brought', () =>
    inTx(async (db) => {
      const { d } = await scenario(db)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const campaigns = await value<Array<Record<string, unknown>>>(db, `select public.report_meta_ads($1::date, $1::date, 'campaign', null)`, [d])
      const belt = campaigns.find((c) => c.id === '7001')!
      expect(belt).toMatchObject({ name: 'Korean Belt', spend: 800, orders: 3, delivered: 2, impressions: 80000 })
      expect(num(belt.ctr)).toBeGreaterThan(0)
      const ads = await value<Array<Record<string, unknown>>>(db, `select public.report_meta_ads($1::date, $1::date, 'ad', '7102')`, [d])
      expect(ads.map((x) => x.name)).toEqual(['Wallet Static'])

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.report_attribution(current_date, current_date, 'source', '{}')`, [], /marketing\.view|permission/i)
    }))
})

describe('finance', () => {
  it('posts the gateway fee set for the provider, and none when it is 0', () =>
    inTx(async (db) => {
      await setSetting(db, 'payments', { providers: { bkash: { enabled: true, type: 'redirect', fee_percent: 1.5 } } })
      const { order } = await trackedOrder(db, '01711001801', null, { price: 1000 })
      await asSystem(db)
      const ref = await value<string>(db, `select reference from public.start_order_payment($1, '01711001801', 'FULL', 'bkash')`, [order.order_number])
      await asService(db)
      await db.query(`select public.confirm_payment($1, 'bkash', 'TRXFEE1', 10000, 'ev-fee-1', 'paid', '{}', true)`, [ref])
      await asSystem(db)
      const fee = num(await value(db, `select coalesce(sum(ft.amount), 0) from public.finance_transactions ft
        join public.finance_categories c on c.id = ft.category_id where c.code = 'PAYMENT_FEES' and ft.order_id = $1`, [order.id]))
      const paid = num(await value(db, `select amount_paid from public.orders where id = $1`, [order.id]))
      expect(fee).toBeCloseTo(Math.round(paid * 1.5) / 100, 2)

      await setSetting(db, 'payments', { providers: { bkash: { enabled: true, type: 'redirect', fee_percent: 0 } } })
      const second = await trackedOrder(db, '01711001802', null, { price: 500 })
      await asSystem(db)
      const ref2 = await value<string>(db, `select reference from public.start_order_payment($1, '01711001802', 'FULL', 'bkash')`, [second.order.order_number])
      await asService(db)
      await db.query(`select public.confirm_payment($1, 'bkash', 'TRXFEE2', 10000, 'ev-fee-2', 'paid', '{}', true)`, [ref2])
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
        where c.code = 'PAYMENT_FEES' and ft.order_id = $1`, [second.order.id]))).toBe(0)
    }))

  it('breaks costs down by kind in the finance overview', () =>
    inTx(async (db) => {
      const d = await today(db)
      await setSetting(db, 'meta_ads', { exchange_rate: 1, tax_percent: 0 })
      await sync(db, { since: d, until: d, insights: [insight('6201', '6101', '6001', d, 'facebook', 250)] })
      await asSystem(db)
      await db.query(`select public._post_finance('EXPENSE', 'SMS', 3.5, $1::date, true, null, null, null, null, 'test', 'sms:test-overview', null)`, [d])
      await db.query(`select public._post_finance('EXPENSE', 'COD_FEES', 12, $1::date, true, null, null, null, null, 'test', 'codfee:test-overview', null)`, [d])
      const finance = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, finance)
      const f = await value<Record<string, number>>(db, `select public.finance_overview($1::date, $1::date)`, [d])
      expect(num(f.marketing_costs)).toBe(250)
      expect(num(f.sms_costs)).toBe(3.5)
      expect(num(f.courier_cod_fees)).toBe(12)
      expect(num(f.delivery_costs)).toBeGreaterThanOrEqual(12)
      expect(f).toHaveProperty('payment_fees')
      expect(f).toHaveProperty('gross_sales')
      expect(f).toHaveProperty('online_collected')
      expect(num(f.other_expenses)).toBeCloseTo(num(f.operating_expenses) - num(f.delivery_costs) - 250 - 3.5 - num(f.payment_fees), 2)
    }))
})

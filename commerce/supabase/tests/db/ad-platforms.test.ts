import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function localDay(db: Db, offset = 0): Promise<string> {
  await asSystem(db)
  return value<string>(db, `select (public._local_date(now()) + $1::int)::text`, [offset])
}

async function connect(db: Db, platform: 'tiktok' | 'google', accounts: Array<Record<string, unknown>>, user = 'ads@example.com') {
  const staff = await createStaff(db, 'ADMIN')
  await asService(db)
  const conn = await value<{ id: string }>(db, `select public.ad_connection_save($1, $2, $3)`,
    [platform, JSON.stringify({ external_user: user, display_name: user, token_hint: '••••abcd', accounts }), staff])
  await asSystem(db)
  const rows = await db.query<{ id: string; external_id: string; is_selected: boolean }>(
    `select id, external_id, is_selected from public.ad_accounts where connection_id = $1 order by external_id`, [conn.id])
  return { conn, accounts: rows.rows, staff }
}

async function apply(db: Db, accountId: string, since: string, until: string, days: unknown[], campaigns: unknown[] = []) {
  await asService(db)
  return value<Record<string, number>>(db, `select public.ad_platform_apply_sync($1)`,
    [JSON.stringify({ account_id: accountId, since, until, campaigns, days })])
}

async function advertising(db: Db, day: string) {
  await asSystem(db)
  return num(await value(db, `select coalesce(sum(ft.amount), 0) from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id where c.code = 'ADVERTISING' and ft.txn_date = $1`, [day]))
}

describe('TikTok / Google Ads', () => {
  it('lists accounts: TikTok advertisers are chosen at once, Google waits unless there is just one', () =>
    inTx(async (db) => {
      const t = await connect(db, 'tiktok', [{ external_id: '7001', name: 'Main', currency: 'USD' }, { external_id: '7002', name: 'Two' }], 'tt')
      expect(t.accounts.map((a) => a.is_selected)).toEqual([true, true])
      const g = await connect(db, 'google', [
        { external_id: '111-222-3333', name: 'MCC', is_manager: true },
        { external_id: '4445556666', name: 'Shop', login_customer_id: '1112223333' },
        { external_id: '7778889999', name: 'Other' },
      ])
      expect(g.accounts.map((a) => [a.external_id, a.is_selected])).toEqual([['1112223333', false], ['4445556666', false], ['7778889999', false]])
      const single = await connect(db, 'google', [{ external_id: '5550001111', name: 'Only one' }], 'one@example.com')
      expect(single.accounts[0].is_selected).toBe(true)
      // A manager account has no campaigns of its own.
      await asUser(db, g.staff)
      await expectError(db, `select public.ad_account_update($1, '{"is_selected": true}')`, [g.accounts[0].id], /manager account/)
    }))

  it('converts spend with the account rate and VAT, posts it to Finance and leaves other accounts alone', () =>
    inTx(async (db) => {
      const d = await localDay(db)
      const { accounts, staff } = await connect(db, 'tiktok', [{ external_id: '8001', name: 'A', currency: 'USD' }, { external_id: '8002', name: 'B', currency: 'BDT' }], 'tt2')
      const [a, b] = accounts
      await asUser(db, staff)
      await db.query(`select public.ad_account_update($1, '{"usd_rate": 120, "tax_percent": 15}')`, [a.id])
      const r = await apply(db, a.id, d, d, [{ campaign_id: '900001', date: d, spend: 10, impressions: 1000, clicks: 30, conversions: 2 }],
        [{ id: '900001', name: 'Belt — Sales', status: 'ENABLE' }])
      expect(num(r.cost)).toBe(1380) // 10 × 120 × 1.15
      await apply(db, b.id, d, d, [{ campaign_id: '900002', date: d, spend: 500 }])
      expect(await advertising(db, d)).toBe(1880) // BDT account: no conversion
      await asSystem(db)
      expect(await value(db, `select status::text from public.marketing_campaigns where external_id = '900001'`)).toBe('ACTIVE')

      // Syncing account A again with nothing zeroes A only.
      await apply(db, a.id, d, d, [])
      expect(await advertising(db, d)).toBe(500)
      await asSystem(db)
      expect(num(await value(db, `select cost from public.ad_platform_stats where campaign_id = '900002'`))).toBe(500)
    }))

  it('re-costs synced days when the rate changes', () =>
    inTx(async (db) => {
      const d = await localDay(db)
      const { accounts, staff } = await connect(db, 'google', [{ external_id: '6660001111', name: 'Shop', currency: 'USD' }], 'g2@example.com')
      await apply(db, accounts[0].id, d, d, [{ campaign_id: '33', date: d, spend: 5 }])
      expect(await advertising(db, d)).toBe(550) // default 110
      await asUser(db, staff)
      await db.query(`select public.ad_account_update($1, '{"usd_rate": 100}')`, [accounts[0].id])
      expect(await advertising(db, d)).toBe(500)
    }))

  it('ties orders to a campaign only through the campaign_id their link carried', () =>
    inTx(async (db) => {
      const d = await localDay(db)
      const { accounts } = await connect(db, 'tiktok', [{ external_id: '8101', name: 'Main', currency: 'BDT' }], 'tt3')
      await apply(db, accounts[0].id, d, d, [{ campaign_id: '1700000001', date: d, spend: 300, clicks: 50 }], [{ id: '1700000001', name: 'Wallet', status: 'ENABLE' }])
      const p = await createProduct(db, { price: 1000, cost: 300, stock: 5 })
      const order = await createOrder(db, { phone: '01711000991', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const plain = await createOrder(db, { phone: '01711000992', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      const t = { at: new Date().toISOString(), landing: '/', referrer: null, params: { utm_source: 'tiktok', utm_medium: 'paid', campaign_id: '1700000001', ttclid: 'E.C.P' } }
      await db.query(`select public.record_order_attribution($1, $2)`, [order.id, JSON.stringify({ visitor_id: 'visitor-tt-1', first_touch: t, last_touch: t })])
      const viewer = await createStaff(db, 'MANAGER')
      await asUser(db, viewer)
      const report = await value<{ campaigns: Array<{ id: string; orders: number; cost: number }>; days: unknown[] }>(
        db, `select public.ad_platform_report('tiktok', $1, $1)`, [d])
      expect(report.campaigns).toEqual([expect.objectContaining({ id: '1700000001', name: 'Wallet', orders: 1, cost: 300 })])
      expect(report.days).toHaveLength(1)
      await asSystem(db)
      // The attribution report's spend line uses the same key.
      expect(await value(db, `select campaign_key from public.ad_spend_facts where source = 'TikTok Ads'`)).toBe('1700000001')
      expect(plain.id).toBeTruthy()
    }))

  it('accepts an OAuth state once, only for its platform and before it expires', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ADMIN')
      await asService(db)
      const state = 'a'.repeat(64)
      await db.query(`select public.ad_oauth_state_create('tiktok', $1, $2, 'https://shop.test/admin/marketing/tiktok')`, [state, staff])
      await expectError(db, `select public.ad_oauth_state_create('tiktok', $1, $2, 'https://evil.test/steal')`, ['b'.repeat(64), staff], /return address/)
      expect(await value(db, `select public.ad_oauth_state_take('google', $1)`, [state])).toBeNull()
      expect(await value(db, `select public.ad_oauth_state_take('tiktok', $1)`, [state])).toMatchObject({ return_to: 'https://shop.test/admin/marketing/tiktok' })
      expect(await value(db, `select public.ad_oauth_state_take('tiktok', $1)`, [state])).toBeNull()
      // Staff cannot call the service functions.
      await asUser(db, staff)
      await expectError(db, `select public.ad_oauth_state_take('tiktok', $1)`, [state], /PERMISSION_DENIED|permission/i)
      await expectError(db, `select public.ad_platform_apply_sync('{}')`, [], /PERMISSION_DENIED|permission/i)
    }))
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
const dhakaDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
const today = () => dhakaDate(new Date())
const daysAgo = (n: number) => dhakaDate(new Date(Date.now() - n * 86_400_000))
const touch = (params: Record<string, string>, referrer: string | null = null) =>
  JSON.stringify({ visitor_id: 'v1', first_touch: { at: new Date().toISOString(), landing: '/', referrer, params }, last_touch: null, extra: 'x'.repeat(10) })

type Row = { id: string; name: string; cost: number; leads: number; paying: number; revenue: number; cpl: number | null; roas: number | null; meta_leads: number; messages: number }
type Report = { rows: Row[]; totals: { cost: number; meta_leads: number }; leads: { total: number; meta: number; meta_paying: number; meta_unmatched: number; by_source: Record<string, number> } }

async function signupRequest(db: Db, name: string): Promise<string> {
  await asSystem(db, null)
  return value<string>(db, `insert into public.signup_requests (business_name, full_name, phone, message) values ($1, 'Owner', '01712345678', 'hi') returning id`, [name])
}

describe('Super Admin ads report', () => {
  it('shows each campaign’s spend, Meta results, our leads, paying stores and cost per lead', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      await asService(db, null)
      const acct = await value<{ id: string }>(db, `select public.platform_ad_account_save($1, $2)`,
        [JSON.stringify({ name: 'Fullfilio ads', ad_account_id: 'act_555000', usd_rate: 120, meta: { currency: 'USD', status: 'OK' } }), superId])
      await value(db, `select public.platform_meta_apply_sync($1, $2)`, [acct.id, JSON.stringify({
        since: daysAgo(3), until: today(),
        campaigns: [{ id: 'c1', name: 'Store owners | Leads', effective_status: 'ACTIVE', daily_budget: '1000' }, { id: 'c2', name: 'Retarget', effective_status: 'PAUSED' }],
        adsets: [{ id: 's1', campaign_id: 'c1', name: 'Dhaka sellers' }],
        ads: [{ id: 'a1', adset_id: 's1', campaign_id: 'c1', name: 'Video 1', creative: { thumbnail_url: 'https://x/t.jpg' } }],
        insights: [
          { ad_id: 'a1', adset_id: 's1', campaign_id: 'c1', date: daysAgo(1), spend: 10, impressions: 1000, clicks: 50, link_clicks: 40, leads: 3, messages: 2 },
          { ad_id: 'a1', adset_id: 's1', campaign_id: 'c1', date: today(), spend: 5, impressions: 500, clicks: 20, link_clicks: 10, leads: 1 },
          { ad_id: 'a9', campaign_id: 'c2', date: today(), spend: 2, impressions: 100, clicks: 1, link_clicks: 1 },
        ],
      })])

      // A WhatsApp sign-up from the c1 ad (campaign_id in the link), a self sign-up that names the campaign,
      // a contact message from organic Facebook, and a sign-up with no tracking.
      const wa = await signupRequest(db, 'Shop A')
      await asAnon(db, null)
      await value(db, `select public.public_lead_touch('WHATSAPP_SIGNUP', $1, $2)`, [wa, touch({ utm_source: 'facebook', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1' })])
      // Unknown ids and other kinds are ignored, not errors.
      await value(db, `select public.public_lead_touch('WHATSAPP_SIGNUP', $1, $2)`, [randomUUID(), touch({ campaign_id: 'c1' })])
      await value(db, `select public.public_lead_touch('SELF_SIGNUP', $1, $2)`, [randomUUID(), touch({ campaign_id: 'c1' })])
      await value(db, `select public.platform_contact_submit($1)`, [JSON.stringify({ name: 'Rahim', phone: '01812345678', message: 'I want a demo please', topic: 'SALES',
        attribution: JSON.parse(touch({}, 'https://m.facebook.com/')) })])
      await signupRequest(db, 'Shop C')

      await as(db, superId)
      const shop = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop B ${randomUUID().slice(0, 4)}` })])
      await asSystem(db, null)
      await db.query(`update public.merchants set onboarding = onboarding || '{"self_signup": true}' where id = $1`, [shop.id])
      await db.query(`insert into public.platform_lead_touches (kind, ref, attribution) values ('SELF_SIGNUP', $1, $2)`,
        [shop.id, touch({ utm_source: 'fb', utm_medium: 'paid', utm_campaign: 'store owners | leads', fbclid: 'abc' })])
      const inv = await value<string>(db, `insert into public.billing_invoices (merchant_id, kind, lines, total, amount_paid, status, due_at, paid_at)
        values ($1, 'SUBSCRIPTION', '[]', 990, 990, 'PAID', now(), now()) returning id`, [shop.id])
      await db.query(`insert into public.billing_payments (merchant_id, invoice_id, amount, method, status, verified_at) values ($1, $2, 990, 'BANK', 'SUCCEEDED', now())`, [shop.id, inv])

      await as(db, support)
      await expectError(db, `select public.platform_ads_report($1, $2)`, [daysAgo(7), today()], /PERMISSION_DENIED/)
      await as(db, superId)
      const r = await value<Report>(db, `select public.platform_ads_report($1, $2)`, [daysAgo(7), today()])
      const c1 = r.rows.find((x) => x.id === 'c1')!
      expect(c1).toMatchObject({ name: 'Store owners | Leads', leads: 2, paying: 1, meta_leads: 4, messages: 2 })
      expect(Number(c1.cost)).toBe(1800)
      expect(Number(c1.cpl)).toBe(900)
      expect(Number(c1.revenue)).toBe(990)
      expect(Number(c1.roas)).toBe(0.55)
      expect(Number(r.rows.find((x) => x.id === 'c2')!.cost)).toBe(240)
      expect(Number(r.totals.cost)).toBe(2040)
      expect(r.leads).toMatchObject({ meta: 2, meta_paying: 1, meta_unmatched: 0 })
      expect(r.leads.by_source).toMatchObject({ META_ADS: 2, FACEBOOK_ORGANIC: 1, UNKNOWN: 1 })

      // Drill down: the ad sets of c1, then its ads.
      const sets = await value<Report>(db, `select public.platform_ads_report($1, $2, 'adset', 'c1')`, [daysAgo(7), today()])
      expect(sets.rows.map((x) => [x.id, x.leads])).toEqual([['s1', 1]])
      const ads = await value<Report>(db, `select public.platform_ads_report($1, $2, 'ad', 's1')`, [daysAgo(7), today()])
      expect(ads.rows.map((x) => [x.id, Number(x.cost), x.leads])).toEqual([['a1', 1800, 1]])

      const leads = await value<Array<{ kind: string; source: string; campaign: string | null; paying: boolean }>>(db,
        `select public.platform_ads_leads($1, $2, 'META_ADS')`, [daysAgo(7), today()])
      expect(leads.map((l) => [l.kind, l.campaign, l.paying]).sort()).toEqual([
        ['SELF_SIGNUP', 'Store owners | Leads', true], ['WHATSAPP_SIGNUP', 'Store owners | Leads', false]])

      // Only the kept parts of a touch are stored.
      await asSystem(db, null)
      const stored = await value<Record<string, unknown>>(db, `select attribution from public.platform_lead_touches where kind = 'WHATSAPP_SIGNUP' and ref = $1`, [wa])
      expect(stored).not.toHaveProperty('extra')
    }))
})

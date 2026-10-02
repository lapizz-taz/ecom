import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, placeOrder } from '../support/fixtures'

afterAll(closePool)

async function classify(db: Db, touch: unknown) {
  await asSystem(db)
  return value<Record<string, unknown>>(db, `select public.classify_touch($1)`, [touch === null ? null : JSON.stringify(touch)])
}

const touch = (params: Record<string, string>, referrer: string | null = null, landing = '/product/belt') =>
  ({ at: '2026-10-01T10:00:00Z', landing, referrer, params })

describe('source classification', () => {
  it('recognises ads only when ad tags or ids say so', () =>
    inTx(async (db) => {
      expect(await classify(db, touch({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Korean Belt', utm_term: 'Broad 18-30', utm_content: 'Belt Reel 03', campaign_id: '120', adset_id: '121', ad_id: '122', fbclid: 'IwAR' })))
        .toMatchObject({ channel: 'paid_social', source: 'Facebook Ads', is_paid: true, platform: 'META', campaign: 'Korean Belt', adset: 'Broad 18-30', ad: 'Belt Reel 03', ad_id: '122', click_id_type: 'fbclid' })
      expect(await classify(db, touch({ utm_source: 'ig', utm_medium: 'paid' }))).toMatchObject({ source: 'Instagram Ads', platform: 'META' })
      expect(await classify(db, touch({ fbclid: 'IwAR', ad_id: '9', site_source_name: 'ig' }))).toMatchObject({ source: 'Instagram Ads' })
      expect(await classify(db, touch({ gclid: 'Cj0' }))).toMatchObject({ channel: 'paid_search', source: 'Google Ads', platform: 'GOOGLE' })
      expect(await classify(db, touch({ ttclid: 'E.C' }))).toMatchObject({ source: 'TikTok Ads', platform: 'TIKTOK' })
      // Facebook adds fbclid to post links too: not claimed as an ad.
      expect(await classify(db, touch({ fbclid: 'IwAR' }, 'https://l.facebook.com/l.php'))).toMatchObject({ channel: 'social', source: 'Facebook', is_paid: null })
    }))

  it('labels organic, messaging, referral and direct traffic', () =>
    inTx(async (db) => {
      expect(await classify(db, touch({ srsltid: 'AfmB' }, 'https://www.google.com/'))).toMatchObject({ channel: 'organic_search', source: 'Google', is_paid: false })
      expect(await classify(db, touch({}, 'https://www.google.com.bd/'))).toMatchObject({ channel: 'organic_search', source: 'Google' })
      expect(await classify(db, touch({}, 'https://m.facebook.com/'))).toMatchObject({ channel: 'organic_social', source: 'Facebook' })
      expect(await classify(db, touch({}, 'https://l.instagram.com/'))).toMatchObject({ source: 'Instagram' })
      expect(await classify(db, touch({}, 'https://web.whatsapp.com/'))).toMatchObject({ channel: 'messaging', source: 'WhatsApp' })
      expect(await classify(db, touch({ utm_source: 'whatsapp' }))).toMatchObject({ channel: 'messaging', source: 'WhatsApp' })
      expect(await classify(db, touch({ utm_source: 'newsletter', utm_medium: 'email' }))).toMatchObject({ channel: 'email' })
      expect(await classify(db, touch({}, 'https://blog.example.org/post'))).toMatchObject({ channel: 'referral', source: 'blog.example.org' })
      expect(await classify(db, touch({}))).toMatchObject({ channel: 'direct', source: 'Direct' })
      expect(await classify(db, null)).toMatchObject({ channel: 'unknown', source: 'Unknown', is_paid: null })
    }))
})

describe('order attribution', () => {
  async function order(db: Db, phone = '01711000301') {
    const p = await createProduct(db, { price: 500, stock: 20 })
    return placeOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  }

  it('stores the last touch, the first touch and the journey', () =>
    inTx(async (db) => {
      const o = await order(db)
      await asSystem(db)
      for (const [type, mins] of [['PAGE_VIEW', 50], ['VIEW_PRODUCT', 45], ['PAGE_VIEW', 30], ['ADD_TO_CART', 20], ['BEGIN_CHECKOUT', 10]] as const) {
        await db.query(`insert into public.storefront_events(session_id, visitor_id, event_type, created_at) values ($1, 'visitor-abc-123', $2, now() - make_interval(mins => $3))`,
          [mins > 40 ? 'session-one-1' : 'session-two-2', type, mins])
      }
      await asService(db)
      const row = await value<Record<string, unknown>>(db, `select to_jsonb(public.record_order_attribution($1, $2))`, [o.id, JSON.stringify({
        visitor_id: 'visitor-abc-123', session_id: 'session-two-2',
        first_touch: touch({ srsltid: 'AfmB' }, 'https://www.google.com/', '/'),
        last_touch: touch({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Korean Belt', utm_term: 'Broad 18-30', utm_content: 'Belt Reel 03', ad_id: '122' }, 'https://m.facebook.com/'),
      })])
      expect(row).toMatchObject({
        channel: 'paid_social', source: 'Facebook Ads', campaign: 'Korean Belt', adset: 'Broad 18-30', ad: 'Belt Reel 03', ad_id: '122',
        first_channel: 'organic_search', first_source: 'Google', landing_page: '/product/belt', referrer_host: 'm.facebook.com',
        journey: { visits: 2, page_views: 2, product_views: 1, add_to_cart: 1, checkouts: 1 },
      })
      await asSystem(db)
      expect(await value(db, `select utm_campaign from public.orders where id = $1`, [o.id])).toBe('Korean Belt')

      // A retry does not overwrite what was recorded.
      await asService(db)
      const again = await value<Record<string, unknown>>(db, `select to_jsonb(public.record_order_attribution($1, $2))`, [o.id, JSON.stringify({ last_touch: touch({}) })])
      expect(again.source).toBe('Facebook Ads')
    }))

  it('never invents a source: known visitor with no touch is direct, nothing at all is unknown', () =>
    inTx(async (db) => {
      const a = await order(db, '01711000302')
      const b = await order(db, '01711000303')
      await asService(db)
      expect(await value(db, `select (public.record_order_attribution($1, $2)).source`, [a.id, JSON.stringify({ visitor_id: 'visitor-xyz-999', first_touch: touch({}, null, '/'), last_touch: null })])).toBe('Direct')
      expect(await value(db, `select (public.record_order_attribution($1, '{}'::jsonb)).source`, [b.id])).toBe('Unknown')
    }))

  it('lets staff set the source of orders they took, but not overwrite tracked ad data', () =>
    inTx(async (db) => {
      const tracked = await order(db, '01711000304')
      const p = await createProduct(db, { price: 300, stock: 5 })
      const manual = await createOrder(db, { phone: '01711000305', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      await db.query(`select public.record_order_attribution($1, $2)`, [tracked.id, JSON.stringify({ last_touch: touch({ gclid: 'x' }) })])
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      expect(await value(db, `select (public.admin_set_order_source($1, 'MESSENGER', 'Asked on the page')).source`, [manual.id])).toBe('Messenger')
      await expectError(db, `select public.admin_set_order_source($1, 'WHATSAPP')`, [tracked.id], /already has tracked source data/)
      await expectError(db, `select public.admin_set_order_source($1, 'SOMETHING')`, [manual.id], /choose where this order came from/)
      await expectError(db, `select public.record_order_attribution($1, '{}'::jsonb)`, [manual.id], /permission denied|PERMISSION_DENIED/)
    }))

  it('keeps tracking data away from customers and anonymous visitors', () =>
    inTx(async (db) => {
      await asAnon(db)
      await expectError(db, `select * from public.order_attributions`, [], /permission denied/)
      await expectError(db, `select * from public.checkout_leads`, [], /permission denied/)
      // Visitors can record journey events, nothing else.
      await db.query(`select public.track_visit_event('visitor-abc-123', 'session-abc-1', 'PAGE_VIEW', null, '/shop')`)
      await db.query(`select public.track_visit_event('visitor-abc-123', 'session-abc-1', 'PAGE_VIEW', null, '/shop')`)
      await db.query(`select public.track_visit_event('bad', 'session-abc-1', 'PAGE_VIEW', null, '/shop')`)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.storefront_events where visitor_id = 'visitor-abc-123'`)).toBe(1)
    }))
})

describe('incomplete checkouts', () => {
  it('keeps one open lead per visitor, then marks it converted when they order', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 10 })
      const lead = (extra: Record<string, unknown> = {}) => JSON.stringify({
        visitor_id: 'visitor-lead-001', phone: '01711000401', items: [{ variant_id: p.variantIds[0], quantity: 1 }], subtotal: 700, total: 770,
        attribution: { last_touch: touch({ utm_source: 'facebook', utm_medium: 'paid' }) }, ...extra,
      })
      await asService(db)
      const id = await value<string>(db, `select public.capture_checkout_lead($1)`, [lead()])
      expect(await value(db, `select public.capture_checkout_lead($1)`, [lead({ customer_name: 'Rahim', address: 'House 5, Mirpur', district: 'Dhaka' })])).toBe(id)
      await asSystem(db)
      expect(await one(db, `select customer_name, district, source, status from public.checkout_leads where id = $1`, [id]))
        .toEqual({ customer_name: 'Rahim', district: 'Dhaka', source: 'Facebook Ads', status: 'OPEN' })

      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const contacted = await one<{ status: string; contact_count: number; notes: string }>(db,
        `select status, contact_count, notes from public.admin_update_checkout_lead($1, 'CONTACTED', 'No answer')`, [id])
      expect(contacted).toMatchObject({ status: 'CONTACTED', contact_count: 1 })
      expect(contacted.notes).toContain('No answer')

      // Ordering with the same phone closes the lead, whichever way the order comes in.
      const o = await placeOrder(db, { phone: '01711000401', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      expect(await value(db, `select public.convert_checkout_lead('visitor-lead-001', '01711000401', $1)`, [o.id])).toBe(0)
      await asSystem(db)
      expect(await one(db, `select status, order_id from public.checkout_leads where id = $1`, [id])).toEqual({ status: 'CONVERTED', order_id: o.id })
      // Right after ordering, the same visitor isn't recorded as abandoning.
      await asService(db)
      expect(await value(db, `select public.capture_checkout_lead($1)`, [lead()])).toBeNull()
    }))

  it('respects the setting and rejects junk', () =>
    inTx(async (db) => {
      await asService(db)
      expect(await value(db, `select public.capture_checkout_lead($1)`, [JSON.stringify({ visitor_id: 'visitor-lead-002', phone: 'abc', items: [{}] })])).toBeNull()
      expect(await value(db, `select public.capture_checkout_lead($1)`, [JSON.stringify({ visitor_id: 'visitor-lead-002', phone: '01711000402', items: [] })])).toBeNull()
      await asSystem(db)
      await db.query(`update public.settings set value = value || '{"capture_incomplete": false}' where key = 'orders'`)
      await asService(db)
      expect(await value(db, `select public.capture_checkout_lead($1)`, [JSON.stringify({ visitor_id: 'visitor-lead-002', phone: '01711000402', items: [{ variant_id: 'x', quantity: 1 }] })])).toBeNull()
      const packer = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, packer)
      await expectError(db, `select public.capture_checkout_lead('{}')`, [], /permission denied/)
    }))
})

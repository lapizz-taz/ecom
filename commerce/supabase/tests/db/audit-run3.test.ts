import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

// Regression tests for the security audit (run 3) fixes.

describe('custom domains: platform-owned names', () => {
  async function setup(db: Db) {
    await asSystem(db, null)
    await db.query(`update public.features set globally_enabled = true where code = 'custom_domains'`)
    await db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify({ root_domain: 'stores.test', main_site: 'marketing' })])
    await db.query(`update public.merchants set slug = 'victim' where id = $1`, [MERCHANT_1])
    await asSystem(db, MERCHANT_1)
    await db.query(`update public.settings set value = value || '{"mode":"OWN"}' where merchant_id = $1 and key = 'storefront'`, [MERCHANT_1])
    await asSystem(db, null)
    const mA = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
    await asSystem(db, mA)
    await db.query(`select public._merchant_seed_defaults($1)`, [mA])
    await asSystem(db, null)
    await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true), ($2, 'custom_domains', true)
      on conflict do nothing`, [mA, MERCHANT_1])
    const emailA = `a-${randomUUID().slice(0, 6)}@example.com`
    const ownerA = await createStaff(db, 'OWNER', emailA, mA)
    return { mA, ownerA, emailA }
  }
  const resolve = async (db: Db, host: string) => {
    await asAnon(db, null)
    return value<Record<string, any>>(db, `select public.storefront_resolve($1)`, [host])
  }

  it('refuses the root domain, its subdomains and the platform host', () =>
    inTx(async (db) => {
      const { mA, ownerA, emailA } = await setup(db)
      await asUser(db, ownerA, emailA, mA)
      for (const d of ['victim.stores.test', 'stores.test', 'www.stores.test', 'fullfilio.com', 'www.fullfilio.com', 'shop.fullfilio.com']) {
        await expectError(db, `select public.store_domain_guard($1, 'add')`, [d], /DOMAIN_REJECTED/)
      }
      await db.query(`select public.store_domain_guard('my-own-shop.test', 'add')`)
      await asSystem(db, null)
      expect(await value<string[]>(db, `select coalesce(array_agg(domain), '{}') from public.store_domains where merchant_id = $1`, [mA])).toEqual(['my-own-shop.test'])
    }))

  it('a row under the root domain never overrides the slug subdomain or the platform', () =>
    inTx(async (db) => {
      const { mA } = await setup(db)
      // A claim that slipped in earlier (before this fix).
      await asSystem(db, null)
      await db.query(`insert into public.store_domains (merchant_id, domain, status) values ($1, 'victim.stores.test', 'PENDING'), ($1, 'stores.test', 'PENDING')`, [mA])
      expect(await resolve(db, 'victim.stores.test')).toMatchObject({ kind: 'store', merchant_id: MERCHANT_1 })
      expect(await resolve(db, 'stores.test')).toEqual({ kind: 'platform' })
      expect(await resolve(db, 'www.stores.test')).toEqual({ kind: 'platform' })
      await asSystem(db, null)
      expect(await value(db, `select public.store_domain_known('victim.stores.test')`)).toBe(false)
    }))

  it("refuses the www/apex twin of another store's domain", () =>
    inTx(async (db) => {
      const { mA, ownerA, emailA } = await setup(db)
      const ownerB = await createStaff(db, 'OWNER')
      await asUser(db, ownerB, 'b@example.com', MERCHANT_1)
      await db.query(`select public.store_domain_guard('shop.test', 'add')`)
      await asUser(db, ownerA, emailA, mA)
      await expectError(db, `select public.store_domain_guard('www.shop.test', 'add')`, [], /DUPLICATE/)
      // The same store may add both.
      await asUser(db, ownerB, 'b@example.com', MERCHANT_1)
      await db.query(`select public.store_domain_guard('www.shop.test', 'add')`)
      expect(await resolve(db, 'www.shop.test')).toMatchObject({ kind: 'store', merchant_id: MERCHANT_1 })
    }))
})

describe('Super Admin finance and ads report: merchant scope', () => {
  const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())

  it('an ASSIGNED employee sees only assigned merchants in the books and the leads', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const sfx = randomUUID().slice(0, 6)
      const make = async (name: string, email: string, phone: string) => {
        await as(db, superId)
        return (await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name, owner_email: email, phone })])).id
      }
      const a = await make(`Assigned Shop ${sfx}`, `owner-a-${sfx}@shop.example`, '01700000001')
      const b = await make(`Other Shop ${sfx}`, `owner-b-${sfx}@shop.example`, '01700000002')
      await asSystem(db, null)
      for (const [m, amount, ref] of [[a, 111, `REF-A-${sfx}`], [b, 222, `REF-B-${sfx}`]] as const) {
        const inv = await value<string>(db, `insert into public.billing_invoices (merchant_id, kind, lines, total, amount_paid, status, due_at, paid_at)
          values ($1, 'SUBSCRIPTION', '[]', $2, $2, 'PAID', now(), now()) returning id`, [m, amount])
        await db.query(`insert into public.billing_payments (merchant_id, invoice_id, amount, method, status, verified_at, reference)
          values ($1, $2, $3, 'BANK', 'SUCCEEDED', now(), $4)`, [m, inv, amount, ref])
      }
      await db.query(`update public.merchants set onboarding = coalesce(onboarding, '{}'::jsonb) || '{"self_signup": true}'::jsonb where id in ($1, $2)`, [a, b])
      await db.query(`insert into public.signup_requests (business_name, full_name, phone, message) values ('Lead Co', 'Lead Person', '01811111111', 'hi')`)

      const emp = await createPlatformStaff(db, 'BILLING_MANAGER', { scope: 'ASSIGNED', merchants: [a] })
      await as(db, emp)
      const entries = await value<{ items: Array<{ merchant: string | null }> }>(db,
        `select public.platform_finance_entries($1)`, [JSON.stringify({ source: 'BILLING', type: 'INCOME', from: today(), to: today() })])
      const names = entries.items.map((i) => i.merchant)
      expect(names).toContain(`Assigned Shop ${sfx}`)
      expect(names).not.toContain(`Other Shop ${sfx}`)
      const leads = (await value<Array<{ merchant_id: string | null; business: string }>>(db, `select public.platform_ads_leads($1::date, $1::date)`, [today()])) ?? []
      expect(leads.some((l) => l.merchant_id === a)).toBe(true)
      expect(leads.some((l) => l.merchant_id === b)).toBe(false)
      expect(leads.some((l) => l.business === 'Lead Co')).toBe(false)

      // ALL-scope staff still see everything.
      await as(db, superId)
      const all = (await value<Array<{ merchant_id: string | null; business: string }>>(db, `select public.platform_ads_leads($1::date, $1::date)`, [today()])) ?? []
      expect(all.some((l) => l.merchant_id === b)).toBe(true)
      expect(all.some((l) => l.business === 'Lead Co')).toBe(true)
    }))
})

describe('inbox: customer and order data need their own permissions', () => {
  it('an inbox-only role gets no customer profile or orders, and cannot link or read orders', () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      const roleId = await value<string>(db,
        `insert into public.roles (merchant_id, code, name, rank) values ($1, 'CHATONLY', 'Chat Only', 10) returning id`, [MERCHANT_1])
      await db.query(`insert into public.role_permissions (merchant_id, role_id, permission_id)
        select $1, $2, p.id from public.permissions p where p.code in ('inbox.view','inbox.reply')`, [MERCHANT_1, roleId])
      const agent = await createStaff(db, 'CHATONLY')
      const product = await createProduct(db, { price: 1000, stock: 5 })
      const order = await createOrder(db, { name: 'Victim Shopper', phone: '01799888777', district: 'Dhaka', items: [{ variantId: product.variantIds[0], quantity: 1 }] })

      await asService(db, MERCHANT_1)
      const ch = (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
        [JSON.stringify({ platform: 'FACEBOOK', external_id: '7777777001', name: 'Audit Page' })])).id
      const conv = (await value<{ conversation_id: string }>(db, `select public.inbox_ingest($1::jsonb)`,
        [JSON.stringify({ channel_id: ch, thread_key: 'psid-x', customer: { external_id: 'psid-x', name: 'Someone' }, message: { external_id: 'm_x_1', body: 'hi' } })])).conversation_id

      await asUser(db, agent)
      await expectError(db, `select public.inbox_order_message($1, 'INVOICE')`, [order.id], /PERMISSION|permission/)
      await expectError(db, `select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_id: order.customer_id })], /PERMISSION|permission/)
      await expectError(db, `select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ linked_order_id: order.id })], /PERMISSION|permission/)
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [conv, JSON.stringify({ customer_phone: '01799888777' })])
      const thread = await value<{ customer: unknown; orders: unknown[] }>(db, `select public.inbox_thread($1)`, [conv])
      expect(thread.customer).toBeNull()
      expect(thread.orders).toEqual([])

      // The stock Call role has orders.view but not customers.view: orders yes, profile no.
      await asUser(db, await createStaff(db, 'CALL'))
      const t2 = await value<{ customer: unknown; orders: Array<{ id: string }> }>(db, `select public.inbox_thread($1)`, [conv])
      expect(t2.customer).toBeNull()
      expect(t2.orders.map((o) => o.id)).toContain(order.id)
      expect(await value<string>(db, `select public.inbox_order_message($1, 'STATUS')`, [order.id])).toContain(order.order_number)

      // The owner still sees both.
      await asUser(db, await createStaff(db, 'OWNER'))
      const t3 = await value<{ customer: { id: string } | null }>(db, `select public.inbox_thread($1)`, [conv])
      expect(t3.customer?.id).toBe(order.customer_id)
    }))
})

describe('plan changes after a platform pause', () => {
  async function owner(db: Db) {
    await asSystem(db, null)
    await db.query(`update public.platform_settings set value = value || '{"method":"online_payment"}'::jsonb where key = 'onboarding'`)
    await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
    const id = randomUUID()
    const email = `owner-${id.slice(0, 8)}@shop.example`
    await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Owner"}')`, [id, email])
    await asUser(db, id, email, null)
    const r = await value<Record<string, any>>(db, `select public.merchant_self_onboard($1)`,
      [JSON.stringify({ business_name: 'Pause Shop', full_name: 'Owner', phone: '01712345678', plan_code: 'GROWTH' })])
    await asUser(db, id, email, r.merchant_id)
    return { id, email, merchant: r.merchant_id as string }
  }
  const state = async (db: Db, merchant: string) => {
    await asSystem(db, null)
    return value<Record<string, any>>(db, `select jsonb_build_object('plan', p.code, 'status', s.status)
      from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = $1 and s.ended_at is null`, [merchant])
  }
  const otherPlan = (db: Db) => value<string>(db, `select code from public.plans where status = 'ACTIVE' and is_public and price > 0 and code <> 'GROWTH' order by price desc limit 1`)

  it('pausing voids an open plan-change invoice; checkout of it is refused', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const other = await otherPlan(db)
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await owner(db)
      const inv = await value<Record<string, any>>(db, `select public.billing_choose_plan($1)`, [other])
      await asUser(db, superId, 'staff@platform.example', null)
      await db.query(`select public.platform_subscription_action($1, 'pause', '{"reason":"test pause"}')`, [m.merchant])
      await asSystem(db, null)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [inv.id])).toBe('VOID')
      await asService(db, m.merchant)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id], /already void|can no longer be paid/)
      expect(await state(db, m.merchant)).toMatchObject({ plan: 'GROWTH', status: 'PAUSED' })
    }))

  it('a payment that still arrives while paused is flagged, not applied', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const other = await otherPlan(db)
      const price = Number(await value(db, `select price from public.plans where code = $1`, [other]))
      const m = await owner(db)
      const inv = await value<Record<string, any>>(db, `select public.billing_choose_plan($1)`, [other])
      await asService(db, m.merchant)
      const pay = await value<{ reference: string; payment_id: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id])
      // Paused after checkout started (the attempt was already PENDING).
      await asSystem(db, null)
      await db.query(`update public.subscriptions set status = 'PAUSED', paused_at = now() where merchant_id = $1 and ended_at is null`, [m.merchant])
      await asService(db, m.merchant)
      await db.query(`select public.billing_gateway_confirm($1, 'bkash', 'TRX-RUN3-1', $2, true, '{"source":"IPN","currency":"BDT"}')`, [pay.reference, price])
      expect(await state(db, m.merchant)).toMatchObject({ plan: 'GROWTH', status: 'PAUSED' })
      await asSystem(db, null)
      expect(await value(db, `select needs_review from public.billing_payments where id = $1`, [pay.payment_id])).toBe(true)
    }))

  it('a plan archived after the invoice was raised is not granted', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      const other = await otherPlan(db)
      const m = await owner(db)
      const inv = await value<Record<string, any>>(db, `select public.billing_choose_plan($1)`, [other])
      await asSystem(db, null)
      await db.query(`update public.plans set status = 'ARCHIVED', is_public = false where code = $1`, [other])
      await asService(db, m.merchant)
      await expectError(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [inv.id], /can no longer be paid/)
    }))
})

describe('order RPCs: no costs for the Call role', () => {
  it('status changes and edits return no cost_total to a Call agent; the owner still gets it', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 900, cost: 400, stock: 10 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, await createStaff(db, 'CALL'))
      expect(await value(db, `select (public.admin_update_order($1, '{}'::jsonb)).cost_total`, [order.id])).toBeNull()
      expect(await value(db, `select (public.transition_order_status($1, 'CONFIRMED'::public.order_status, null)).cost_total`, [order.id])).toBeNull()
      await expectError(db, `select public._raw_admin_update_order($1, '{}'::jsonb)`, [order.id], /permission denied/)
      await asUser(db, await createStaff(db, 'OWNER'))
      expect(num(await value(db, `select (public.admin_update_order($1, '{}'::jsonb)).cost_total`, [order.id]))).toBe(400)
    }))

  it('every order-returning function staff can call clears costs (a new one needs the same wrapper)', () =>
    inTx(async (db) => {
      await asSystem(db)
      const unwrapped = await value<string[]>(db, `select coalesce(array_agg(p.oid::regprocedure::text), '{}') from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prorettype = 'public.orders'::regtype
          and has_function_privilege('authenticated', p.oid, 'execute') and p.prosrc not like '%_can_see_costs()%'`)
      expect(unwrapped).toEqual([])
    }))
})

describe('WhatsApp sign-up requests', () => {
  const request = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ business_name: 'Nadia Crafts', full_name: 'Nadia Rahman', phone: '01712345678', ...over })

  it('a second request with the same phone does not overwrite the first; a few per hour per number', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, staff, 'staff@platform.example', null)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'online_payment', whatsapp_number: '+880 1811-000000', reminder_days: [3] })])
      await value(db, `select public.platform_setting_save('signup', $1, 'open WhatsApp sign-up')`, [JSON.stringify({ enabled: true, whatsapp: { enabled: true } })])
      await asAnon(db, null)
      const first = await value<{ id: string }>(db, `select public.public_signup_request($1)`, [request()])
      const second = await value<{ id: string }>(db, `select public.public_signup_request($1)`, [request({ business_name: 'Someone Else' })])
      expect(second.id).not.toBe(first.id)
      await asSystem(db, null)
      expect(await value(db, `select business_name from public.signup_requests where id = $1`, [first.id])).toBe('Nadia Crafts')
      await asAnon(db, null)
      await db.query(`select public.public_signup_request($1)`, [request()])
      await expectError(db, `select public.public_signup_request($1)`, [request()], /RATE_LIMITED/)
    }))
})

describe('open leads (run 3)', () => {
  it('the ad beacon learns only this store\'s addresses and its active products\' prices', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify({ root_domain: 'stores.test', main_site: 'marketing' })])
      await db.query(`update public.merchants set slug = 'nadia' where id = $1`, [MERCHANT_1])
      await db.query(`insert into public.store_domains (merchant_id, domain, status) values ($1, 'nadia.shop', 'ACTIVE'), ($1, 'pending.shop', 'PENDING')`, [MERCHANT_1])
      const p = await createProduct(db, { price: 625, stock: 3 })
      await asService(db)
      const scope = await value<{ hosts: string[]; prices: Record<string, number> }>(db, `select public.ad_track_scope($1::uuid[])`, [[p.productId, randomUUID()]])
      expect(scope.hosts.sort()).toEqual(['nadia.shop', 'nadia.stores.test'])
      expect(Object.keys(scope.prices)).toEqual([p.productId])
      expect(Number(scope.prices[p.productId])).toBe(625)
      await asUser(db, await createStaff(db, 'OWNER'))
      await expectError(db, `select public.ad_track_scope('{}')`, [], /permission denied/)
    }))

  it('sign-up by WhatsApp: a few requests per network address an hour', () =>
    inTx(async (db) => {
      const staff = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, staff, 'staff@platform.example', null)
      await value(db, `select public.platform_onboarding_save($1)`, [JSON.stringify({ method: 'online_payment', whatsapp_number: '+880 1811-000000', reminder_days: [3] })])
      await value(db, `select public.platform_setting_save('signup', $1, 'open WhatsApp sign-up')`, [JSON.stringify({ enabled: true, whatsapp: { enabled: true } })])
      await asAnon(db, null)
      const from = (ip: string) => db.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'cf-connecting-ip': ip })])
      await from('203.0.113.50')
      for (let i = 0; i < 5; i++) {
        await db.query(`select public.public_signup_request($1)`, [JSON.stringify({ business_name: `Shop ${i}`, full_name: 'Some One', phone: `0171200010${i}` })])
      }
      await expectError(db, `select public.public_signup_request($1)`, [JSON.stringify({ business_name: 'Shop X', full_name: 'Some One', phone: '01712000199' })], /from this network/)
      await from('198.51.100.60')
      await db.query(`select public.public_signup_request($1)`, [JSON.stringify({ business_name: 'Real Shop', full_name: 'Real Person', phone: '01812000100' })])
    }))

  it("refuses a store phone pattern with nested repetition", () =>
    inTx(async (db) => {
      await asSystem(db, MERCHANT_1)
      const save = (pattern: string) => db.query(`insert into public.settings (key, value) values ('store', jsonb_build_object('phone_pattern', $1::text))
        on conflict (merchant_id, key) do update set value = public.settings.value || excluded.value`, [pattern])
      await expectError(db, `insert into public.settings (key, value) values ('store', jsonb_build_object('phone_pattern', '^(\\d|\\d)*x$'))
        on conflict (merchant_id, key) do update set value = public.settings.value || excluded.value`, [], /nested repetition/)
      await save('^(\\+?88)?01[3-9]\\d{8}$')
      expect(await value(db, `select public.setting_text('store', array['phone_pattern'], '')`)).toBe('^(\\+?88)?01[3-9]\\d{8}$')
    }))
})

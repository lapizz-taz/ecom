import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

type Entitlement = { state: string; enabled: boolean; limit: number | null }

/** A new merchant through the Super Admin panel (starts on the default plan's trial), with its owner signed in. */
async function newMerchant(db: Db, superId: string): Promise<{ id: string; owner: string }> {
  await as(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Shop ${randomUUID().slice(0, 6)}` })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await as(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, owner }
}

const entitlement = (db: Db, merchant: string, code: string) =>
  value<Entitlement>(db, `select public.merchant_entitlements($1) -> $2`, [merchant, code])

describe('plans: a new merchant', () => {
  it('starts on the default plan as a trial, and sees its own plan, limits and features', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const plan = await value<{ access_mode: string; subscription: { status: string; plan: { code: string }; trial_ends_at: string }; limits: Record<string, number>; features: Record<string, Entitlement> }>(db, `select public.my_plan()`)
      expect(plan.subscription.status).toBe('TRIALING')
      expect(plan.subscription.plan.code).toBe('STARTER')
      expect(new Date(plan.subscription.trial_ends_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000)
      expect(plan.access_mode).toBe('FULL')
      expect(plan.limits).toMatchObject({ staff: 3, stores: 1 })
      expect(plan.features.shopify.state).toBe('ENABLED')
      expect(plan.features.pbx.state).toBe('NOT_IN_PLAN')
      expect(plan.features.orders.state).toBe('CORE')
      await as(db, superId)
      const events = await value<Array<{ event: string }>>(db, `select (public.platform_merchant_billing($1)) -> 'events'`, [m.id])
      expect(events.map((e) => e.event)).toContain('subscription.started')
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      expect(await value(db, `select (public.get_my_access()) ->> 'access_mode'`)).toBe('FULL')
      // Merchant staff read their own billing, never write it.
      await expectError(db, `insert into public.billing_payments (merchant_id, invoice_id, amount, method) values ($1, gen_random_uuid(), 1, 'CASH')`, [m.id], /permission denied/)
      await expectError(db, `select public.platform_plans_list()`, [], /PERMISSION_DENIED/)
    }))

  it('needs subscription rights to start a merchant on a plan other than the default', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superId)
      const role = await value<{ code: string }>(db, `select public.platform_role_save('{"name":"Onboarder","permissions":["merchants.view","merchants.create"]}')`)
      const onboarder = await createPlatformStaff(db, role.code)
      await as(db, onboarder)
      await expectError(db, `select public.platform_merchant_create('{"name":"Free ride","plan_code":"FOUNDER"}')`, [], /PERMISSION_DENIED/)
      const ok = await value<{ id: string }>(db, `select public.platform_merchant_create('{"name":"Normal start","plan_code":"STARTER"}')`)
      await asSystem(db, null)
      expect(await value(db, `select p.code from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = $1`, [ok.id])).toBe('STARTER')
    }))

  it('keeps the original business on the free Founder plan with everything on', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const plan = await value<{ subscription: { plan: { code: string }; status: string }; features: Record<string, Entitlement> }>(db, `select public.my_plan()`)
      expect(plan.subscription).toMatchObject({ status: 'ACTIVE', plan: { code: 'FOUNDER' } })
      expect(Object.values(plan.features).every((f) => f.enabled)).toBe(true)
    }))
})

describe('features: switches change what the backend does', () => {
  it('refuses a feature that is not in the plan, with the reason', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.pbx_issue_my_credential('secret-pass-123', 'test')`, [], /FEATURE_OFF: PBX is not included in your plan/)
      // An exception for this merchant turns it on.
      await as(db, superId)
      const after = await value<Entitlement>(db, `select public.platform_merchant_feature_set($1, 'pbx', true, 'Pilot customer')`, [m.id])
      expect(after.state).toBe('ENABLED')
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      expect(await value(db, `select public.feature_enabled('pbx')`)).toBe(true)
    }))

  it('switches reports off for one merchant but keeps the dashboard working', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      await db.query(`select public.platform_merchant_feature_set($1, 'reports', false, 'Abuse of exports')`, [m.id])
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.report_profit_loss(current_date - 7, current_date)`, [], /FEATURE_OFF: Analytics and reports is switched off for your account/)
      const dash = await value<{ orders: number }>(db, `select public.dashboard_overview(current_date - 1, current_date)`)
      expect(Number(dash.orders)).toBe(0)
      // Back to the plan.
      await as(db, superId)
      await db.query(`select public.platform_merchant_feature_set($1, 'reports', null, 'Resolved')`, [m.id])
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await db.query(`select public.report_profit_loss(current_date - 7, current_date)`)
    }))

  it('turns a feature off for everyone, and stops store connections and cart capture', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await as(db, superId)
      await db.query(`select public.platform_feature_save('woocommerce', '{"globally_enabled": false, "reason": "Provider outage"}')`)
      await db.query(`select public.platform_feature_save('abandoned_carts', '{"globally_enabled": false, "reason": "Load test"}')`)
      expect((await entitlement(db, MERCHANT_1, 'woocommerce')).state).toBe('DISABLED_GLOBALLY')
      await asService(db, MERCHANT_1)
      await expectError(db, `select public.channel_upsert('{"platform":"WOOCOMMERCE","name":"Shop","shop_domain":"https://new-shop.example"}', null)`, [],
        /FEATURE_OFF: WooCommerce integration is switched off for everyone/)
      expect(await value(db, `select public.storefront_cart_sync('visitor-1', 'session-1', '[]', '{}')`)).toBeNull()
      // Core features cannot be switched off.
      await as(db, superId)
      await expectError(db, `select public.platform_feature_save('orders', '{"globally_enabled": false}')`, [], /cannot be switched off/)
      await expectError(db, `select public.platform_merchant_feature_set($1, 'inventory', false, 'test')`, [MERCHANT_1], /core features/)
    }))

  it('keeps beta features to enrolled merchants, and marks a failing connection without blocking it', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      await db.query(`select public.platform_feature_save('stock_sync', '{"release_stage": "BETA"}')`)
      expect((await entitlement(db, m.id, 'stock_sync')).state).toBe('BETA_NOT_ENROLLED')
      await db.query(`select public.platform_merchant_feature_set($1, 'stock_sync', true, 'Beta tester')`, [m.id])
      expect((await entitlement(db, m.id, 'stock_sync')).state).toBe('ENABLED')

      await asSystem(db, m.id)
      await db.query(`insert into public.sales_channels (platform, name, shop_domain, status) values ('SHOPIFY', 'Broken', 'broken.myshopify.com', 'ERROR')`)
      const shopify = await entitlement(db, m.id, 'shopify')
      expect(shopify).toMatchObject({ state: 'UNAVAILABLE', enabled: true })
    }))

  it('previews a bulk change and applies it only with the preview', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const a = await newMerchant(db, superId)
      const b = await newMerchant(db, superId)
      await as(db, superId)
      const preview = await value<{ items: Array<{ id: string; now: string }>; token: string }>(db,
        `select public.platform_feature_bulk_preview($1::uuid[], 'attribution', true)`, [[a.id, b.id]])
      expect(preview.items.map((i) => i.now)).toEqual(['NOT_IN_PLAN', 'NOT_IN_PLAN'])
      await expectError(db, `select public.platform_feature_bulk_apply($1::uuid[], 'attribution', true, 'Campaign', 'wrong')`, [[a.id, b.id]], /review the list/)
      const done = await value<{ changed: number }>(db, `select public.platform_feature_bulk_apply($1::uuid[], 'attribution', true, 'Campaign', $2)`, [[a.id, b.id], preview.token])
      expect(done.changed).toBe(2)
      expect((await entitlement(db, b.id, 'attribution')).state).toBe('ENABLED')
    }))
})

describe('plans: limits', () => {
  it('stops staff and products beyond the plan, and add-ons raise the limit', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      const tiny = await value<{ id: string }>(db, `select public.platform_plan_save('{"name":"Tiny test","price":100,"limits":{"staff":2,"products":1}}')`)
      await db.query(`select public.platform_subscription_action($1, 'change_plan', $2)`, [m.id, JSON.stringify({ plan_id: tiny.id, reason: 'Limit test' })])
      await createStaff(db, 'ORDER_MANAGER', undefined, m.id) // with the owner: 2 of 2
      await asSystem(db, m.id)
      const extra = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, $2)`, [extra, `extra-${extra.slice(0, 6)}@shop.example`])
      await expectError(db, `select public.admin_set_user_role($1, 'ORDER_MANAGER', true)`, [extra], /LIMIT_REACHED: your plan allows 2 staff/)

      await createProduct(db, { price: 100, merchantId: m.id })
      await expectError(db, `select public.admin_save_product('{"name":"Second","price":10,"variants":[{"sku":"S2","title":"Default"}]}')`, [], /LIMIT_REACHED: your plan allows 1 products/)

      await as(db, superId)
      const seat = await value<{ id: string }>(db, `select public.platform_addon_save('{"name":"Extra seat","price":200,"grants":{"staff":1}}')`)
      await db.query(`select public.platform_subscription_action($1, 'add_addon', $2)`, [m.id, JSON.stringify({ addon_id: seat.id, reason: 'Bought a seat' })])
      await asSystem(db, m.id)
      await db.query(`select public.admin_set_user_role($1, 'ORDER_MANAGER', true)`, [extra])
      expect(await value(db, `select (public.merchant_limits()) ->> 'staff'`)).toBe('3')
    }))
})

describe('access rules', () => {
  it('makes a paused account read-only and a suspended one blocked, while the owner can still see why', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      const p = await createProduct(db, { price: 500, merchantId: m.id })
      await as(db, superId)
      await db.query(`select public.platform_subscription_action($1, 'pause', '{"reason":"Asked to pause"}')`, [m.id])
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      expect(await value(db, `select public.merchant_access_mode()`)).toBe('READ_ONLY')
      expect(await value(db, `select public.has_permission('orders.view')`)).toBe(true)
      expect(await value(db, `select public.has_permission('orders.export')`)).toBe(true)
      expect(await value(db, `select public.has_permission('orders.update')`)).toBe(false)
      await expectError(db, `select public.admin_save_product('{"name":"New","price":10,"variants":[{"sku":"RO","title":"Default"}]}')`, [], /PERMISSION_DENIED/)
      // Customers can still order from a read-only account.
      await createOrder(db, { phone: '01711000501', items: [{ variantId: p.variantIds[0], quantity: 1 }], merchantId: m.id })

      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'SUSPENDED' where id = $1`, [m.id])
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      expect(await value(db, `select public.is_staff()`)).toBe(false)
      expect(await value(db, `select public.has_permission('orders.view')`)).toBe(false)
      expect(await value(db, `select (public.my_plan()) ->> 'access_mode'`)).toBe('BLOCKED')
      expect(await value(db, `select count(*)::int from public.orders`)).toBe(0)
      // No new orders from any channel.
      await expect(createOrder(db, { phone: '01711000502', items: [{ variantId: p.variantIds[0], quantity: 1 }], merchantId: m.id })).rejects.toThrow(/ACCOUNT_RESTRICTED/)
    }))

  it('lets Global Settings change what an account state allows, with history and rollback', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await as(db, superId)
      await db.query(`select public.platform_subscription_action($1, 'pause', '{"reason":"Asked to pause"}')`, [m.id])
      const rules = await value<Record<string, string>>(db, `select (public.platform_settings_get()) -> 'access_rules' -> 'value'`)
      await expectError(db, `select public.platform_setting_save('access_rules', $1, 'bad')`, [JSON.stringify({ ...rules, PAUSED: 'MAYBE' })], /FULL, READ_ONLY or BLOCKED/)
      await db.query(`select public.platform_setting_save('access_rules', $1, 'Paused means paused')`, [JSON.stringify({ ...rules, PAUSED: 'BLOCKED' })])
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('BLOCKED')

      const history = await value<Array<{ id: number; kind: string; data: Record<string, string> }>>(db, `select public.platform_config_history('access_rules')`)
      expect(history[0].data.PAUSED).toBe('BLOCKED')
      // Roll back to the rules as they were (recorded before the change, so save the original first).
      await db.query(`select public.platform_setting_save('access_rules', $1, 'Back to read-only')`, [JSON.stringify(rules)])
      const again = await value<Array<{ id: number }>>(db, `select public.platform_config_history('access_rules')`)
      await db.query(`select public.platform_config_rollback($1, 'Undo the undo')`, [again[1].id])
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('BLOCKED')
      await expectError(db, `update public.config_versions set note = 'x' where id = $1`, [again[0].id], /permission denied/)
      await asSystem(db, null)
      await expectError(db, `delete from public.config_versions where id = $1`, [again[0].id], /IMMUTABLE_RECORD/)
    }))
})

describe('billing', () => {
  it('raises one invoice when a trial ends, goes past due, and counts only a payment a second person verified', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      await db.query(`update public.subscriptions set trial_ends_at = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.id])
      const first = await value<{ trials_ended: number; past_due: number }>(db, `select public.billing_run()`)
      expect(first.trials_ended).toBeGreaterThanOrEqual(1)
      await db.query(`select public.billing_run()`)
      const invoices = (await db.query(`select id, total, status from public.billing_invoices where merchant_id = $1`, [m.id])).rows
      expect(invoices).toHaveLength(1)
      expect(invoices[0]).toMatchObject({ total: '990.00', status: 'OPEN' })
      expect(await value(db, `select status from public.subscriptions where merchant_id = $1 and ended_at is null`, [m.id])).toBe('PAST_DUE')
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('FULL') // inside the grace period

      // The billing manager records a bank transfer; it does not count yet.
      await as(db, billing)
      const payment = await value<{ id: string; status: string }>(db, `select public.platform_payment_record($1, '{"amount":990,"method":"BANK","reference":"TRX-1001"}')`, [invoices[0].id])
      expect(payment.status).toBe('PENDING')
      await expectError(db, `select public.platform_payment_record($1, '{"amount":990,"method":"BANK","reference":"TRX-1001"}')`, [invoices[0].id], /duplicate|unique/i)
      await expectError(db, `select public.platform_payment_verify($1, true)`, [payment.id], /PERMISSION_DENIED/)
      // Nobody verifies a payment they recorded themselves, Super Admin included.
      await as(db, superId)
      const own = await value<{ id: string }>(db, `select public.platform_payment_record($1, '{"amount":10,"method":"CASH","reference":"CASH-77"}')`, [invoices[0].id])
      await expectError(db, `select public.platform_payment_verify($1, true)`, [own.id], /a second person must verify/)
      await asSystem(db, null)
      expect(await value(db, `select status from public.billing_invoices where id = $1`, [invoices[0].id])).toBe('OPEN')

      // The Super Admin verifies it against the statement: paid, active, period started.
      await as(db, superId)
      const verified = await value<{ invoice: { status: string } }>(db, `select public.platform_payment_verify($1, true, 'Matched statement')`, [payment.id])
      expect(verified.invoice.status).toBe('PAID')
      await expectError(db, `select public.platform_payment_verify($1, true)`, [payment.id], /already succeeded/)
      await expectError(db, `select public.platform_invoice_void($1, 'Not needed')`, [invoices[0].id], /only an unpaid/)
      await asSystem(db, null)
      const sub = (await db.query(`select status, current_period_end > now() as running from public.subscriptions where merchant_id = $1 and ended_at is null`, [m.id])).rows[0]
      expect(sub).toEqual({ status: 'ACTIVE', running: true })
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action in ('billing.payment_recorded', 'billing.payment_verified') and merchant_id = $1`, [m.id])).toBe(3)
    }))

  it('restricts an unpaid account after the grace period, then expires it', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      await db.query(`update public.subscriptions set trial_ends_at = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.id])
      await db.query(`select public.billing_run()`)
      await db.query(`update public.subscriptions set grace_until = now() - interval '1 day' where merchant_id = $1 and ended_at is null`, [m.id])
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('READ_ONLY')
      await db.query(`update public.subscriptions set grace_until = now() - interval '40 days' where merchant_id = $1 and ended_at is null`, [m.id])
      const run = await value<{ expired: number }>(db, `select public.billing_run()`)
      expect(run.expired).toBeGreaterThanOrEqual(1)
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('BLOCKED')
      expect(await value(db, `select status from public.subscriptions where merchant_id = $1 order by created_at desc limit 1`, [m.id])).toBe('EXPIRED')
    }))

  it('only lets the system run billing; a free plan never raises an invoice; an open invoice can be voided with a reason', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.billing_run()`, [], /permission denied|PERMISSION_DENIED/)

      await asSystem(db, null)
      await db.query(`update public.subscriptions set trial_ends_at = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.id])
      await db.query(`select public.billing_run()`)
      const open = await value<string>(db, `select id from public.billing_invoices where merchant_id = $1 and status = 'OPEN'`, [m.id])
      await as(db, superId)
      await expectError(db, `select public.platform_invoice_void($1, 'no')`, [open], /give a reason/)
      await db.query(`select public.platform_invoice_void($1, 'Agreed to waive the first month')`, [open])

      const zero = await value<{ id: string }>(db, `select public.platform_plan_save('{"name":"Free forever","price":0}')`)
      await db.query(`select public.platform_subscription_action($1, 'cancel', '{"reason":"Moving to free","immediately":true}')`, [m.id])
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('READ_ONLY')
      await db.query(`select public.platform_subscription_action($1, 'change_plan', $2)`, [m.id, JSON.stringify({ plan_id: zero.id, reason: 'Free plan' })])
      await asSystem(db, null)
      expect(await value(db, `select status from public.subscriptions where merchant_id = $1 and ended_at is null`, [m.id])).toBe('ACTIVE')
      await db.query(`update public.subscriptions set current_period_end = now() - interval '1 minute' where merchant_id = $1 and ended_at is null`, [m.id])
      await db.query(`select public.billing_run()`)
      expect(await value(db, `select count(*)::int from public.billing_invoices where merchant_id = $1 and status = 'OPEN'`, [m.id])).toBe(0)
      expect(await value(db, `select public.merchant_access_mode($1)`, [m.id])).toBe('FULL')
    }))
})

describe('plans: who can change them', () => {
  it('lets the viewer look but not change, and records every plan change for rollback', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await as(db, viewer)
      const list = await value<{ plans: Array<{ code: string }> }>(db, `select public.platform_plans_list()`)
      expect(list.plans.map((p) => p.code)).toEqual(expect.arrayContaining(['FOUNDER', 'STARTER', 'GROWTH', 'PRO']))
      await expectError(db, `select public.platform_plan_save('{"name":"Nope"}')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_feature_save('sms', '{"globally_enabled": false}')`, [], /PERMISSION_DENIED/)

      await as(db, superId)
      const starter = await value<string>(db, `select id from public.plans where code = 'STARTER'`)
      await db.query(`select public.platform_plan_save($1)`, [JSON.stringify({ id: starter, price: 1290, note: 'Price rise' })])
      const history = await value<Array<{ id: number; data: { price: number } }>>(db, `select public.platform_config_history('plan', $1)`, [starter])
      expect(Number(history[0].data.price)).toBe(1290)
      await db.query(`select public.platform_plan_save($1)`, [JSON.stringify({ id: starter, price: 1490 })])
      await db.query(`select public.platform_config_rollback($1, 'Too expensive')`, [history[0].id])
      expect(await value(db, `select price::int from public.plans where id = $1`, [starter])).toBe(1290)
    }))
})

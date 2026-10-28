// Security audit run 6 (docs/SECURITY-AUDIT-RUN-6.md): the database fixes, one test per finding.
// Migrations 20261206000100_audit_run6_orders_billing_platform and 20261206000200_audit_run6_messaging.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asService, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff, orderPayload, setSetting, storeZone, transition } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

async function emailService(db: Db, admin: string, limit = 300) {
  await asSystem(db)
  await db.query(`update public.platform_settings set value = jsonb_build_object('enabled', true, 'from_email', 'mail@send.example.test', 'from_name', 'Svc', 'daily_limit', $1::int) where key = 'email_service'`, [limit])
  await db.query(`select public.platform_secret_store('email.resend', '{"api_key": "re_test_key_123456"}'::jsonb, 're_…3456', null)`)
  await asUser(db, admin)
  await db.query(`select public.email_settings_save('{"provider": "fullfilio", "enabled": true}')`)
}

async function storefront(db: Db, payload: Record<string, unknown>) {
  await asService(db)
  const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [
    JSON.stringify({ phone: (payload.customer as { phone: string }).phone, provider: 'internal', provider_counts: {} })])
  return value<Record<string, unknown>>(db, `select public.place_storefront_order($1, $2)`, [JSON.stringify(payload), check.id])
}

describe('orders: a key or a phone never opens someone else\'s order', () => {
  it('admin_create_order: orders.create alone cannot open or confirm an existing order by its key', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 5 })
      const key = 'channel:00000000-0000-4000-8000-0000000000c1:4512'
      const other = await createOrder(db, { phone: '01711000881', name: 'Replay Customer', idempotencyKey: key, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await transition(db, other.id, 'ADVANCE_REQUIRED')
      const mod = await createStaff(db, 'MODERATOR')
      await asUser(db, mod)
      await expectError(db, `select public.admin_create_order($1::jsonb, false)`, [JSON.stringify({ idempotency_key: key })], /PERMISSION_DENIED/)
      await expectError(db, `select public.admin_create_order($1::jsonb, true)`, [JSON.stringify({ idempotency_key: key })], /PERMISSION_DENIED/)
      await asSystem(db)
      expect(await value(db, `select status::text from public.orders where id = $1`, [other.id])).toBe('ADVANCE_REQUIRED')
      // Staff who can see orders still get the order back for a retried key.
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      expect(await value(db, `select (public.admin_create_order($1::jsonb, false)).id`, [JSON.stringify({ idempotency_key: key })])).toBe(other.id)
    }))

  it('admin_create_order: a moderator\'s order that joins an earlier one gets back only its number and status', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 5 })
      const earlier = await createOrder(db, { phone: '01711000882', name: 'Earlier Customer', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const mod = await createStaff(db, 'MODERATOR')
      await asUser(db, mod)
      const r = await value<Record<string, unknown>>(db, `select to_jsonb(public.admin_create_order($1::jsonb, false))`,
        [JSON.stringify(orderPayload({ phone: '01711000882', name: 'Typed Name', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))])
      expect(r.id).toBe(earlier.id)
      expect(r.order_number).toBe(earlier.order_number)
      for (const hidden of ['customer_name', 'customer_phone', 'shipping_address', 'idempotency_key', 'total_amount']) expect(r[hidden]).toBeNull()
    }))

  it('storefront: a checkout key used by another phone is refused, not replayed', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      await setSetting(db, 'orders', { auto_merge_web_enabled: false })
      const key = randomUUID()
      const first = await storefront(db, { ...orderPayload({ phone: '01711000883', name: 'First', items: [{ variantId: p.variantIds[0], quantity: 1 }] }), idempotency_key: key })
      // The same customer retrying gets their own order back.
      const retry = await storefront(db, { ...orderPayload({ phone: '01711000883', name: 'First', items: [{ variantId: p.variantIds[0], quantity: 1 }] }), idempotency_key: key })
      expect(retry.id).toBe(first.id)
      // Someone else sending that key gets nothing.
      await asService(db)
      const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({ phone: '01711000884', provider: 'internal', provider_counts: {} })])
      await expectError(db, `select public.place_storefront_order($1, $2)`,
        [JSON.stringify({ ...orderPayload({ phone: '01711000884', name: 'Other', items: [{ variantId: p.variantIds[0], quantity: 1 }] }), idempotency_key: key }), check.id],
        /already used/)
    }))

  it('admin_quote_order: no product costs for staff who may not see them', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 900, cost: 400, stock: 5 })
      const items = JSON.stringify([{ variant_id: p.variantIds[0], quantity: 2 }])
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const full = await value<Record<string, any>>(db, `select public.admin_quote_order($1::jsonb, 'Dhaka')`, [items])
      expect(Number(full.cost_total)).toBe(800)
      for (const role of ['MODERATOR']) {
        const u = await createStaff(db, role)
        await asUser(db, u)
        const q = await value<Record<string, any>>(db, `select public.admin_quote_order($1::jsonb, 'Dhaka')`, [items])
        expect(q).not.toHaveProperty('cost_total')
        expect(JSON.stringify(q)).not.toContain('unit_cost')
        expect(Number(q.total)).toBe(Number(full.total))
      }
    }))
})

describe('billing: an unpaid plan change does not swallow the one-time setup fee', () => {
  const OFFER = { enabled: true, trial_days: 0, first_price: 99, first_periods: 1, setup_fee: 1000 }
  const openInvoice = (db: Db, merchant: string) => value<{ id: string; total: number; lines: Array<{ kind: string }> }>(db,
    `select to_jsonb(i) from public.billing_invoices i where merchant_id = $1 and kind = 'SUBSCRIPTION' and status = 'OPEN' order by created_at desc, period_start desc limit 1`, [merchant])
  async function pay(db: Db, merchant: string, invoice: string, amount: number) {
    await asService(db, merchant)
    const p = await value<{ reference: string }>(db, `select public.billing_gateway_payment_create($1, 'bkash')`, [invoice])
    return value<string>(db, `select public.billing_gateway_confirm($1, 'bkash', $2, $3, true, '{}') ->> 'status'`, [p.reference, `TXN-${randomUUID().slice(0, 8)}`, amount])
  }

  it('the renewal still carries the fee while a plan-change invoice with it is open and unpaid', () =>
    inTx(async (db) => {
      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = value || '{"method": "online_payment"}' where key = 'onboarding'`)
      await db.query(`update public.platform_settings set value = jsonb_set(value, '{bkash,enabled}', 'true') where key = 'billing_gateways'`)
      await db.query(`insert into public.platform_settings (key, value) values ('signup_offer', '{}') on conflict (key) do nothing`)
      await db.query(`update public.platform_settings set value = value || $1::jsonb where key = 'signup_offer'`, [JSON.stringify(OFFER)])
      const id = randomUUID()
      const email = `r6-${id.slice(0, 8)}@shop.example`
      await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{"full_name": "Dummy Owner"}')`, [id, email])
      await asUser(db, id, email, null)
      const merchant = (await value<{ merchant_id: string }>(db, `select public.merchant_self_onboard($1)`,
        [JSON.stringify({ business_name: 'Dummy Shop', full_name: 'Dummy Owner', phone: '01712345678', plan_code: 'GROWTH' })])).merchant_id
      await asSystem(db, null)
      const first = await openInvoice(db, merchant)
      await pay(db, merchant, first.id, Number(first.total))

      await asSystem(db, null)
      const other = await one<{ code: string }>(db, `select code from public.plans where status = 'ACTIVE' and is_public and price > 0 and code <> 'GROWTH' order by price limit 1`)
      await asUser(db, id, email, merchant)
      const change = await value<{ id: string }>(db, `select public.billing_choose_plan($1)`, [other.code])
      await asSystem(db, null)
      expect(await value<string[]>(db, `select array_agg(l ->> 'kind') from public.billing_invoices i, jsonb_array_elements(i.lines) l where i.id = $1`, [change.id]))
        .toContain('setup_fee')
      // Until it is paid, the plan page still says the fee is to come.
      await asUser(db, id, email, merchant)
      expect(Number((await value<{ subscription: { setup_fee_pending: number | null } }>(db, `select public.my_plan()`)).subscription.setup_fee_pending)).toBe(1000)

      // The offer ends while the plan change is still unpaid: the renewal must ask for the fee.
      await asSystem(db, null)
      await db.query(`update public.subscriptions set current_period_end = now() - interval '5 minutes', intro_until = now() - interval '5 minutes'
                      where merchant_id = $1 and ended_at is null`, [merchant])
      await db.query(`select public.billing_run()`)
      const renewal = await openInvoice(db, merchant)
      expect(renewal.id).not.toBe(change.id)
      expect(renewal.lines.map((l) => l.kind)).toContain('setup_fee')
    }))
})

describe('platform: employees limited to some stores stay inside them on announcements', () => {
  it('get shows only their stores; cancelling an all-store notice or editing its draft is refused', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const sup = await createPlatformStaff(db, 'SUPER_ADMIN')
      const ops = await createPlatformStaff(db, 'OPERATIONS_MANAGER', { scope: 'ASSIGNED', merchants: [m2] })
      await asUser(db, sup, 'super@platform.example', null)
      const prev = await value<{ count: number }>(db, `select public.platform_announcement_preview('{"type":"ALL"}', 'MAINTENANCE')`)
      const sent = await value<{ id: string }>(db, `select public.platform_announcement_save($1)`,
        [JSON.stringify({ kind: 'MAINTENANCE', title: 'Courier API down', body: 'Bookings may fail tonight.', audience: { type: 'ALL' } })])
      await db.query(`select public.platform_announcement_send($1, $2, 'Maintenance')`, [sent.id, prev.count])
      const draft = await value<{ id: string }>(db, `select public.platform_announcement_save($1)`,
        [JSON.stringify({ kind: 'SUBSCRIPTION', title: 'Plan prices', body: 'Prices change next month.', audience: { type: 'ALL' } })])

      await asUser(db, ops, 'ops@platform.example', null)
      const got = await value<{ deliveries: Array<{ merchant: { id: string } }> }>(db, `select public.platform_announcement_get($1)`, [sent.id])
      expect(got.deliveries.length).toBeGreaterThan(0)
      expect(got.deliveries.every((d) => d.merchant.id === m2)).toBe(true)
      await expectError(db, `select public.platform_announcement_cancel($1, 'Withdrawn')`, [sent.id], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_announcement_save($1)`,
        [JSON.stringify({ id: draft.id, kind: 'SUBSCRIPTION', title: 'Edited', body: 'Changed.', audience: { type: 'ALL' } })], /PERMISSION_DENIED/)

      // The all-store notice is still out for MERCHANT_1, and the super admin can still withdraw it.
      await asSystem(db, null)
      expect(await value(db, `select status::text from public.platform_announcements where id = $1`, [sent.id])).not.toBe('CANCELLED')
      await asUser(db, sup, 'super@platform.example', null)
      await db.query(`select public.platform_announcement_cancel($1, 'Withdrawn after the test')`, [sent.id])
    }))
})

describe('messaging', () => {
  it('the notifications setting (template switches, owner summary) cannot be rewritten through admin_update_setting', () =>
    inTx(async (db) => {
      for (const role of ['OWNER', 'ADMIN']) {
        const u = await createStaff(db, role)
        await asUser(db, u)
        await expectError(db, `select public.admin_update_setting('notifications', '{"anything": true}'::jsonb)`, [], /PERMISSION_DENIED|VALIDATION|cannot|not/i)
      }
    }))

  it('the order\'s confirm / cancel token is never kept on the log, and the kept email hides it', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await emailService(db, admin)
      await asSystem(db)
      await db.query(`update public.notifications set is_enabled = (channel = 'EMAIL' and event = 'ORDER_CREATED')`)
      await db.query(`update public.notifications set reply_buttons = true where channel = 'EMAIL' and event = 'ORDER_CREATED'`)
      const p = await createProduct(db, { price: 600, stock: 10 })
      const o = await createOrder(db, { phone: '01711000891', name: 'Token Buyer', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set customer_email = 'buyer@example.com' where id = $1`, [o.id])
      await db.query(`delete from public.notification_logs where order_id = $1`, [o.id])
      await db.query(`select public._enqueue_order_notification($1, 'ORDER_CREATED', null, null)`, [o.id])
      const log = await one<{ id: string; data: Record<string, unknown> }>(db,
        `select id, data from public.notification_logs where order_id = $1 and channel = 'EMAIL'`, [o.id])
      expect(log.data).not.toHaveProperty('reply_token')
      expect(JSON.stringify(log.data)).not.toMatch(/[0-9a-f]{40}/)
      // The sender still gets the token, from the plan made at send time.
      await asService(db)
      const plan = await value<{ reply_token: string }>(db, `select public._notification_send_plan($1)`, [log.id])
      expect(plan.reply_token).toMatch(/^[0-9a-f]{40}$/)
      // The copy kept for the log shows "hidden" where the token was (kept while it is being sent).
      await asSystem(db)
      await db.query(`update public.notification_logs set status = 'SENDING' where id = $1`, [log.id])
      await asService(db)
      const body = `<a href="https://shop.test/order-confirm/${MERCHANT_1}/${plan.reply_token}">Confirm</a>`
      await db.query(`select public._notification_log_rendered($1, 'Subject', $2)`, [log.id, body])
      await asSystem(db)
      const kept = await value<string>(db, `select body from public.notification_logs where id = $1`, [log.id])
      expect(kept).toContain(`/order-confirm/${MERCHANT_1}/hidden`)
      expect(kept).not.toContain(plan.reply_token)
      // A viewer reading the log finds no token.
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      const seen = await value<string>(db, `select coalesce(string_agg(data::text || body, ''), '') from public.notification_logs where order_id = $1`, [o.id])
      expect(seen).not.toContain(plan.reply_token)
    }))

  it('the owner\'s daily summary (profit, ad spend) is readable only with finance access', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.messaging_settings_save('{"summary": {"enabled": true, "hour": 0, "emails": ["owner@shop.com"]}}')`)
      await emailService(db, admin)
      await asSystem(db)
      await db.query(`update public.notifications set is_enabled = false`)
      await asService(db)
      await db.query(`select public.messaging_run_summary()`)
      await asSystem(db)
      expect(Number(await value(db, `select count(*) from public.notification_logs where purpose = 'SUMMARY'`))).toBeGreaterThan(0)
      for (const role of ['CALL', 'VIEWER', 'ORDER_MANAGER']) {
        const u = await createStaff(db, role)
        await asUser(db, u)
        expect(Number(await value(db, `select count(*) from public.notification_logs where purpose = 'SUMMARY'`))).toBe(0)
      }
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      expect(Number(await value(db, `select count(*) from public.notification_logs where purpose = 'SUMMARY'`))).toBeGreaterThan(0)
    }))

  it('"Send again" does not get past the Fullfilio email service\'s daily limit', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await emailService(db, admin, 1)
      await asSystem(db)
      const created = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_CREATED'`)
      await db.query(`update public.notifications set is_enabled = false`)
      const p = await createProduct(db, { price: 600, stock: 10 })
      const ids: string[] = []
      for (const [i, phone] of ['01711000892', '01711000893'].entries()) {
        const o = await createOrder(db, { phone, name: `Buyer ${i}`, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
        await asSystem(db)
        await db.query(`update public.orders set customer_email = $2 where id = $1`, [o.id, `buyer${i}@example.com`])
        await db.query(`update public.notifications set is_enabled = true where id = $1`, [created])
        await db.query(`select public._enqueue_order_notification($1, 'ORDER_CREATED', null, null)`, [o.id])
        await db.query(`update public.notifications set is_enabled = false`)
        ids.push(o.id)
      }
      const skipped = await value<string>(db, `select id from public.notification_logs where channel = 'EMAIL' and status = 'SKIPPED' and order_id = any($1::uuid[]) limit 1`, [ids])
      expect(skipped).toBeTruthy()
      await asUser(db, admin)
      await expectError(db, `select public.retry_notification($1)`, [skipped], /limit/)
      await asSystem(db)
      expect(await value(db, `select status::text from public.notification_logs where id = $1`, [skipped])).toBe('SKIPPED')
    }))

  describe('cart reminders', () => {
    async function smsOn(db: Db) {
      await asSystem(db)
      await db.query(`update public.platform_settings set value = value || '{"connected": true, "provider": "smsnetbd", "sender_id": "FULLFILIO"}' where key = 'sms'`)
      await setSetting(db, 'sms', { enabled: true })
      await db.query(`update public.notifications set is_enabled = (channel = 'SMS' and event = 'CART_REMINDER')`)
    }
    async function cartFor(db: Db, visitor: string, variant: string, phone: string) {
      await asAnon(db)
      await db.query(`select public.storefront_cart_sync($1, null, $2::jsonb, null)`, [visitor, JSON.stringify([{ variant_id: variant, quantity: 1 }])])
      await asService(db)
      await db.query(`select public.capture_checkout_lead($1::jsonb)`, [JSON.stringify({
        visitor_id: visitor, phone, customer_name: 'Shopper', items: [{ variant_id: variant, quantity: 1, name: 'Item', price: 600 }], subtotal: 600, total: 600,
      })])
    }
    async function queueDue(db: Db) {
      await asSystem(db)
      await db.query(`update public.store_carts set last_activity_at = now() - interval '2 hours'`)
      await asService(db)
      const due = await value<Array<{ source: string; id: string; step: number }>>(db, `select public.messaging_due_carts(50)`)
      for (const d of due) await db.query(`select public.messaging_queue_cart($1, $2, $3, $4)`, [d.source, d.id, d.step, `https://store.test/cart?restore=${d.id}`])
      await asSystem(db)
    }

    it('many carts with one phone number queue one reminder a day, not one each', () =>
      inTx(async (db) => {
        const p = await createProduct(db, { price: 600, stock: 10 })
        await smsOn(db)
        await setSetting(db, 'store', { timezone: storeZone(true) })
        for (const v of ['dummyv-0001', 'dummyv-0002', 'dummyv-0003']) await cartFor(db, v, p.variantIds[0], '01711999999')
        await queueDue(db)
        const sms = await value<number>(db, `select count(*)::int from public.notification_logs where event = 'CART_REMINDER' and channel = 'SMS' and recipient = '8801711999999' and status in ('QUEUED', 'SENDING', 'SENT')`)
        expect(sms).toBe(1)
      }))

    it('a reminder email never goes to an address someone typed with this phone on another order', () =>
      inTx(async (db) => {
        const admin = await createStaff(db, 'ADMIN')
        await emailService(db, admin)
        const p = await createProduct(db, { price: 600, stock: 10 })
        // Someone ordered earlier with this phone and their own address.
        const o = await createOrder(db, { phone: '01711888888', name: 'Earlier', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
        await asSystem(db)
        await db.query(`update public.orders set customer_email = 'earlier@example.com' where id = $1`, [o.id])
        await db.query(`update public.customers set email = 'earlier@example.com' where phone = '01711888888'`)
        await db.query(`update public.notifications set is_enabled = (channel = 'EMAIL' and event = 'CART_REMINDER')`)
        await setSetting(db, 'store', { timezone: storeZone(true) })
        await cartFor(db, 'dummyv-0101', p.variantIds[0], '01711888888')
        await queueDue(db)
        expect(await value<number>(db, `select count(*)::int from public.notification_logs where event = 'CART_REMINDER' and channel = 'EMAIL'`)).toBe(0)
      }))
  })
})

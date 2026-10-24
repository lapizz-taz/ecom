import { afterAll, describe, expect, it } from 'vitest'
import {
  EMAIL_DEFAULTS, EMAIL_DEFAULTS_BN, SMS_DEFAULTS, SMS_DEFAULTS_BN, WHATSAPP_DEFAULTS, WHATSAPP_DEFAULTS_BN,
} from '../../functions/_shared/notifications/defaults'
import { asService, asSystem, asUser, closePool, type Db, expectError, inTx, one, value } from '../support/db'
import { createOrder, createProduct, createStaff, setSetting } from '../support/fixtures'

afterAll(closePool)

interface Log {
  id: string; event: string; channel: string; status: string; recipient: string; subject: string | null; body: string; error: string | null
  data: Record<string, any> | null; fallback_of: string | null; delivery_status: string | null; purpose: string; provider_message_id: string | null
}

const NEW_EVENTS = ['DELIVERY_FAILED', 'CART_REMINDER', 'REVIEW_REQUEST']

/** The platform's SMS provider connected and SMS on for the business, with only these SMS automations on. */
async function smsOn(db: Db, events: string[]) {
  await asSystem(db)
  await db.query(`update public.platform_settings set value = value || '{"connected": true, "provider": "smsnetbd", "sender_id": "FULLFILIO"}' where key = 'sms'`)
  await setSetting(db, 'sms', { enabled: true })
  await db.query(`insert into public.platform_settings (key, value) values ('billing_controls', '{}') on conflict (key) do nothing`)
  await db.query(`update public.platform_settings set value = jsonb_set(value, '{pricing}', coalesce(value -> 'pricing', '{}') || '{"SMS": {"unit_poisha": 30}}') where key = 'billing_controls'`)
  await db.query(`update public.notifications set is_enabled = (event::text = any($1)) where channel = 'SMS'`, [events])
}

/** Fullfilio's email service set up by the platform and chosen by the store. */
async function emailOn(db: Db, admin: string) {
  await asSystem(db)
  await db.query(`update public.platform_settings set value = jsonb_build_object('enabled', true, 'from_email', 'mail@send.fullfilio.com', 'from_name', 'Fullfilio', 'daily_limit', 300) where key = 'email_service'`)
  await db.query(`select public.platform_secret_store('email.resend', '{"api_key": "re_test_key_123456"}'::jsonb, 're_…3456', null)`)
  await asUser(db, admin)
  await db.query(`select public.email_settings_save('{"provider": "fullfilio", "enabled": true}')`)
}

/** A connected WhatsApp number, chosen and switched on. */
async function whatsappOn(db: Db, admin: string, smsFallback = false) {
  await asService(db)
  const number = (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform: 'WHATSAPP', external_id: '109876543210', waba_id: '2233445566', display_phone: '+880 1711-000000', name: 'Isolation' })])).id
  await asUser(db, admin)
  await db.query(`select public.whatsapp_settings_save($1::jsonb)`, [JSON.stringify({ channel_id: number, enabled: true, language: 'en', sms_fallback: smsFallback })])
}

/** Meta approved this WhatsApp message (as the messaging function records it). */
async function approve(db: Db, event: string, buttons = false): Promise<string> {
  await asSystem(db)
  const id = await value<string>(db, `update public.notifications set is_enabled = true where channel = 'WHATSAPP' and event = $1 returning id`, [event])
  await asService(db)
  await db.query(`select public._whatsapp_template_record($1, $2::jsonb)`, [id, JSON.stringify({
    name: `ff_${event.toLowerCase()}_v1`, language: 'en', status: 'APPROVED', template_id: '998877', version: 1,
    params: ['customer_first_name', 'order_number'], body: (WHATSAPP_DEFAULTS as Record<string, string>)[event], buttons,
  })])
  return id
}

/** An order (nothing is queued for it: every message is off while it is created). */
async function order(db: Db, phone = '01711000801', email: string | null = null) {
  await asSystem(db)
  await db.query(`update public.notifications set is_enabled = false`)
  const p = await createProduct(db, { price: 600, cost: 250, stock: 10 })
  const o = await createOrder(db, { phone, name: 'Rahim Uddin', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
  await asSystem(db)
  if (email) await db.query(`update public.orders set customer_email = $2 where id = $1`, [o.id, email])
  return o
}

async function logsOf(db: Db, where: string, params: unknown[] = []): Promise<Log[]> {
  await asSystem(db)
  return (await db.query<Log>(`select * from public.notification_logs where ${where} order by created_at, id`, params)).rows
}

const enqueue = async (db: Db, orderId: string, event: string, ref: string | null = null) => {
  await asSystem(db)
  return value<number>(db, `select public._enqueue_order_notification($1, $2::public.notification_event, $3, null)`, [orderId, event, ref])
}

/** A store time zone in which it is day now (reminders and review requests wait for the day). */
async function daytime(db: Db, day = true) {
  await asSystem(db)
  const tz = await value<string>(db, `select tz from (select 'Etc/GMT' || case when n > 0 then '-' || n when n < 0 then '+' || (-n) else '' end as tz
    from generate_series(-12, 14) n) z, extract(hour from now() at time zone tz) h
    -- Well inside or well outside the sending hours (9 am to 8 pm), whatever the time the test runs.
    where case when $1 then h between 10 and 19 else h not between 8 and 21 end limit 1`, [day])
  await setSetting(db, 'store', { timezone: tz })
}

const reply = (db: Db, token: string, action: string, via = 'EMAIL', phone: string | null = null) =>
  asService(db).then(() => value<Record<string, any>>(db, `select public.order_reply_apply($1, $2, $3, $4)`, [token, action, via, phone]))

describe('messages v2: the store\'s new messages', () => {
  it('every store has them, switched off, in English; and the "Customer confirmed" call status', () =>
    inTx(async (db) => {
      await asSystem(db)
      const rows = (await db.query<{ event: string; channel: string; is_enabled: boolean; template: string; subject: string | null }>(
        `select event::text, channel::text, is_enabled, template, subject from public.notifications where event::text = any($1)`, [NEW_EVENTS])).rows
      expect(rows).toHaveLength(9)
      expect(rows.every((r) => !r.is_enabled)).toBe(true)
      for (const e of NEW_EVENTS as Array<keyof typeof SMS_DEFAULTS>) {
        expect(rows.find((r) => r.event === e && r.channel === 'SMS')?.template).toBe(SMS_DEFAULTS[e])
        expect(rows.find((r) => r.event === e && r.channel === 'WHATSAPP')?.template).toBe(WHATSAPP_DEFAULTS[e])
        expect(rows.find((r) => r.event === e && r.channel === 'EMAIL')).toMatchObject({ template: EMAIL_DEFAULTS[e].template, subject: EMAIL_DEFAULTS[e].subject })
      }
      expect(await value(db, `select label from public.order_review_statuses where code = 'CUSTOMER_CONFIRMED'`)).toBe('Customer confirmed')

      // A store's first messages bring the new ones along (a new store is seeded with "Order placed" first).
      await db.query(`delete from public.notifications where event::text = any($1)`, [NEW_EVENTS])
      await db.query(`insert into public.notifications(event, channel, is_enabled, template) values ('ORDER_CREATED', 'SMS', false, 'Hi {{customer_name}}')`)
      expect(await value(db, `select count(*)::int from public.notifications where event::text = any($1)`, [NEW_EVENTS])).toBe(9)
    }))
})

describe('messages v2: Confirm / Cancel', () => {
  it('the email asks the customer to confirm; a tap on the page marks the order, approves it when asked, or cancels it', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await emailOn(db, admin)
      await asSystem(db)
      const created = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_CREATED'`)
      const shipped = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_SHIPPED'`)
      await asUser(db, admin)
      await expectError(db, `select public.notification_message_options($1, '{"reply_buttons": true}')`, [shipped], /only the order confirmation/)
      expect(await value(db, `select reply_buttons from public.notification_message_options($1, '{"reply_buttons": true}')`, [created])).toBe(true)

      const o = await order(db, '01711000801', 'rahim@example.com')
      await db.query(`update public.notifications set is_enabled = true where id = $1`, [created])
      expect(await enqueue(db, o.id, 'ORDER_CREATED')).toBe(1)
      const [log] = await logsOf(db, `order_id = $1 and channel = 'EMAIL'`, [o.id])
      const token = log.data?.reply_token as string
      expect(token).toMatch(/^[0-9a-f]{40}$/)
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public._notification_send_plan($1)`, [log.id])).toMatchObject({ reply_token: token, merchant_id: expect.any(String) })

      const view = await value<Record<string, any>>(db, `select public.order_reply_view($1)`, [token])
      expect(view).toMatchObject({ state: 'OPEN', can_confirm: true, can_cancel: true, language: 'en', order: { number: o.order_number, customer_first_name: 'Rahim' } })
      expect(view.order.items).toHaveLength(1)
      expect(await value(db, `select public.order_reply_view($1)`, ['f'.repeat(40)])).toBeNull()

      // Only the server answers for the customer.
      await asUser(db, admin)
      await expectError(db, `select public.order_reply_apply($1, 'confirm', 'EMAIL', null)`, [token], /permission/i)

      expect(await reply(db, token, 'confirm')).toMatchObject({ result: 'confirmed', order_number: o.order_number })
      await asSystem(db)
      expect(await one(db, `select status::text, review_status from public.orders where id = $1`, [o.id])).toEqual({ status: 'PENDING', review_status: 'CUSTOMER_CONFIRMED' })
      expect(await value(db, `select count(*)::int from public.order_status_history where order_id = $1 and message = 'Customer confirmed by email'`, [o.id])).toBe(1)
      expect(await reply(db, token, 'confirm')).toMatchObject({ result: 'confirmed' })
      expect(await value(db, `select count(*)::int from public.order_status_history where order_id = $1 and message = 'Customer confirmed by email'`, [o.id])).toBe(1)
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.order_reply_view($1)`, [token])).toMatchObject({ state: 'CONFIRMED', can_confirm: false, can_cancel: true })

      // The store approves confirmed orders by itself.
      await asUser(db, admin)
      await db.query(`select public.messaging_settings_save('{"confirm": {"auto_approve": true}}')`)
      const o2 = await order(db, '01711000802')
      await asService(db)
      const t2 = await value<string>(db, `select public._order_reply_token($1)`, [o2.id])
      expect(await reply(db, t2, 'confirm')).toMatchObject({ result: 'confirmed' })
      await asSystem(db)
      expect(await one(db, `select status::text, confirmed_at is not null as approved from public.orders where id = $1`, [o2.id])).toEqual({ status: 'CONFIRMED', approved: true })
      // After approval a cancel is a request for the team.
      expect(await reply(db, t2, 'cancel')).toMatchObject({ result: 'cancel_requested' })
      await asSystem(db)
      expect(await value(db, `select status::text from public.orders where id = $1`, [o2.id])).toBe('CONFIRMED')
      expect(await value(db, `select count(*)::int from public.order_status_history where order_id = $1 and event = 'CUSTOMER_REQUEST'`, [o2.id])).toBe(1)

      // Before approval a cancel cancels; nothing confirms it afterwards.
      const o3 = await order(db, '01711000803')
      await asService(db)
      const t3 = await value<string>(db, `select public._order_reply_token($1)`, [o3.id])
      expect(await reply(db, t3, 'cancel')).toMatchObject({ result: 'cancelled' })
      await asSystem(db)
      expect(await one(db, `select status::text, review_status from public.orders where id = $1`, [o3.id])).toEqual({ status: 'CANCELLED', review_status: 'CANCELLED' })
      expect(await reply(db, t3, 'confirm')).toMatchObject({ result: 'cancelled' })

      // A WhatsApp answer must come from the order's own number; an unknown token does nothing.
      const o4 = await order(db, '01711000804')
      await asService(db)
      const t4 = await value<string>(db, `select public._order_reply_token($1)`, [o4.id])
      expect(await reply(db, t4, 'cancel', 'WHATSAPP', '8801999999999')).toMatchObject({ result: 'ignored' })
      expect(await reply(db, t4, 'confirm', 'WHATSAPP', '8801711000804')).toMatchObject({ result: 'confirmed' })
      expect(await reply(db, 'a'.repeat(40), 'confirm')).toEqual({ result: 'not_found' })
    }))

  it('WhatsApp: the approved template carries Confirm / Cancel with the order\'s token; a tap without it is found by the message', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await whatsappOn(db, admin)
      await asSystem(db)
      const id = await value<string>(db, `select id from public.notifications where channel = 'WHATSAPP' and event = 'ORDER_CREATED'`)
      await asUser(db, admin)
      await db.query(`select public.notification_message_options($1, '{"reply_buttons": true}')`, [id])
      const o = await order(db, '01711000811')
      await approve(db, 'ORDER_CREATED', true)
      expect(await enqueue(db, o.id, 'ORDER_CREATED')).toBe(1)
      const [log] = await logsOf(db, `order_id = $1 and channel = 'WHATSAPP'`, [o.id])
      const token = log.data?.reply_token as string
      expect(token).toMatch(/^[0-9a-f]{40}$/)
      await asService(db)
      const plan = await value<Record<string, any>>(db, `select public._notification_send_plan($1)`, [log.id])
      expect(plan.buttons).toEqual([`ffo:confirm:${token}`, `ffo:cancel:${token}`])

      await asSystem(db)
      await db.query(`update public.notification_logs set status = 'SENT', provider_message_id = 'wamid.order' where id = $1`, [log.id])
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.order_reply_by_message('wamid.order', 'confirm', '8801711000811')`)).toMatchObject({ result: 'confirmed', reply_in_chat: true })
      expect(await value<Record<string, any>>(db, `select public.order_reply_by_message('wamid.other', 'confirm', '8801711000811')`)).toEqual({ result: 'not_found' })
    }))
})

describe('messages v2: the courier could not reach the customer', () => {
  it('after pickup only, at most once a day per parcel', () =>
    inTx(async (db) => {
      await smsOn(db, ['DELIVERY_FAILED'])
      const o = await order(db, '01711000821')
      await smsOn(db, ['DELIVERY_FAILED'])
      const courier = await value<string>(db, `select id from public.couriers order by created_at limit 1`)
      const ship = await value<string>(db, `insert into public.shipments(order_id, courier_id, tracking_number, status) values ($1, $2, 'TRK-1', 'BOOKED') returning id`, [o.id, courier])
      const setStatus = (s: string) => db.query(`update public.shipments set status = $2::public.shipment_status where id = $1`, [ship, s])
      await setStatus('ON_HOLD') // pickup failed: not the customer's doing
      expect(await logsOf(db, `order_id = $1 and event = 'DELIVERY_FAILED'`, [o.id])).toHaveLength(0)
      await setStatus('IN_TRANSIT')
      await setStatus('ON_HOLD')
      const [sms, ...rest] = await logsOf(db, `order_id = $1 and event = 'DELIVERY_FAILED'`, [o.id])
      expect(rest).toHaveLength(0)
      expect(sms).toMatchObject({ channel: 'SMS', status: 'QUEUED', recipient: '8801711000821' })
      expect(sms.body).toContain(`could not reach you with order ${o.order_number}`)
      await setStatus('OUT_FOR_DELIVERY')
      await setStatus('FAILED')
      expect(await logsOf(db, `order_id = $1 and event = 'DELIVERY_FAILED'`, [o.id])).toHaveLength(1)
    }))
})

describe('messages v2: WhatsApp → SMS', () => {
  it('not approved, failed to send, or reported failed by Meta: the SMS of the same step goes instead, once', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await whatsappOn(db, admin, true)
      const o = await order(db, '01711000831')
      await smsOn(db, [])
      await db.query(`update public.notifications set is_enabled = true where channel = 'WHATSAPP' and event = 'ORDER_CONFIRMED'`)
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED')).toBe(0)
      const [wa] = await logsOf(db, `order_id = $1 and channel = 'WHATSAPP'`, [o.id])
      expect(wa.status).toBe('SKIPPED')
      const [sms, ...more] = await logsOf(db, `order_id = $1 and channel = 'SMS'`, [o.id])
      expect(more).toHaveLength(0)
      expect(sms).toMatchObject({ status: 'QUEUED', fallback_of: wa.id, recipient: '8801711000831', event: 'ORDER_CONFIRMED' })
      expect(sms.body).toContain(`Your order ${o.order_number} is confirmed`)
      expect(sms.body).toContain('Tk ')

      // The SMS automation of that step does not send a second one.
      await db.query(`update public.notifications set is_enabled = true where channel = 'SMS' and event = 'ORDER_CONFIRMED'`)
      await enqueue(db, o.id, 'ORDER_CONFIRMED')
      expect(await logsOf(db, `order_id = $1 and channel = 'SMS'`, [o.id])).toHaveLength(1)
      await db.query(`update public.notifications set is_enabled = false where channel = 'SMS'`)

      // Approved, but the send fails for good.
      await approve(db, 'ORDER_SHIPPED')
      expect(await enqueue(db, o.id, 'ORDER_SHIPPED')).toBe(1)
      await asService(db)
      await db.query(`select id from public.claim_notifications(50)`)
      const [shippedWa] = await logsOf(db, `order_id = $1 and channel = 'WHATSAPP' and event = 'ORDER_SHIPPED'`, [o.id])
      await asService(db)
      expect(await value(db, `select public.complete_notification($1, false, 'meta', null, 'This number is not on WhatsApp', null, true)`, [shippedWa.id])).toBe('FAILED')
      expect(await logsOf(db, `fallback_of = $1`, [shippedWa.id])).toHaveLength(1)

      // Sent, then Meta's receipts: delivered, read (kept), or failed (then the SMS).
      await approve(db, 'ORDER_DELIVERED')
      await approve(db, 'ORDER_RETURNED')
      await enqueue(db, o.id, 'ORDER_DELIVERED')
      await enqueue(db, o.id, 'ORDER_RETURNED')
      await asService(db)
      const claimed = (await db.query<{ id: string; event: string }>(`select id, event::text from public.claim_notifications(50)`)).rows
      for (const c of claimed) await db.query(`select public.complete_notification($1, true, 'meta', $2, null)`, [c.id, `wamid.${c.event}`])
      const receipt = (id: string, s: string) => value(db, `select public.notification_whatsapp_status($1, $2, 'Undeliverable')`, [id, s])
      expect(await receipt('wamid.ORDER_DELIVERED', 'DELIVERED')).toBe(true)
      expect(await receipt('wamid.ORDER_DELIVERED', 'READ')).toBe(true)
      expect(await receipt('wamid.ORDER_DELIVERED', 'DELIVERED')).toBe(true)
      expect(await receipt('wamid.unknown', 'READ')).toBe(false)
      const [delivered] = await logsOf(db, `provider_message_id = 'wamid.ORDER_DELIVERED'`)
      expect(delivered.delivery_status).toBe('READ')
      await asService(db)
      await receipt('wamid.ORDER_RETURNED', 'FAILED')
      const [returned] = await logsOf(db, `provider_message_id = 'wamid.ORDER_RETURNED'`)
      expect(returned).toMatchObject({ delivery_status: 'FAILED', error: 'Undeliverable' })
      expect(await logsOf(db, `fallback_of = $1`, [returned.id])).toHaveLength(1)

      // Switched off: no SMS.
      await asUser(db, admin)
      await db.query(`select public.whatsapp_settings_save('{"sms_fallback": false}')`)
      await asSystem(db)
      await db.query(`update public.notifications set is_enabled = true where channel = 'WHATSAPP' and event = 'ORDER_CANCELLED'`)
      await enqueue(db, o.id, 'ORDER_CANCELLED')
      expect(await logsOf(db, `order_id = $1 and channel = 'SMS' and event = 'ORDER_CANCELLED'`, [o.id])).toHaveLength(0)
    }))
})

describe('messages v2: abandoned cart reminders', () => {
  it('the first after the chosen time, the second a day later, never twice, in the day only; carts bought after a reminder count as recovered', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await emailOn(db, admin)
      const o = await order(db, '01711000841')
      await smsOn(db, ['CART_REMINDER'])
      await db.query(`update public.notifications set is_enabled = true where channel = 'EMAIL' and event = 'CART_REMINDER'`)
      await db.query(`update public.customers set email = 'karim@example.com' where phone = (select customer_phone from public.orders where id = $1)`, [o.id])
      const cart = await value<string>(db, `insert into public.store_carts(visitor_id, status, reached_checkout, items, item_count, subtotal, phone, customer_name, last_activity_at)
        values ('visitor-0001', 'ACTIVE', true, $1::jsonb, 2, 1200, (select customer_phone from public.orders where id = $2), 'Karim Ahmed', now() - interval '2 hours')
        returning id`, [JSON.stringify([{ variant_id: '00000000-0000-4000-8000-0000000000c1', name: 'Cotton panjabi', variant: 'L', quantity: 2, unit_price: 600, image: null }]), o.id])

      await daytime(db, false)
      await asService(db)
      expect(await value(db, `select public.messaging_due_carts(50)`)).toEqual([])
      await daytime(db)
      await asService(db)
      expect(await value(db, `select public.messaging_due_carts(50)`)).toEqual([{ source: 'own', id: cart, step: 1, url: null }])
      const url = `https://isolation.test/cart?restore=${cart}`
      expect(await value(db, `select public.messaging_queue_cart('own', $1, 1, $2)`, [cart, url])).toBe(2)
      const [sms, email] = await logsOf(db, `event = 'CART_REMINDER' order by channel desc`.replace(' order by channel desc', ''), [])
        .then((l) => [l.find((x) => x.channel === 'SMS')!, l.find((x) => x.channel === 'EMAIL')!])
      expect(sms.body).toBe(`You left items in your cart (Tk 1,200). Finish your order: ${url} - My Store`)
      expect(email).toMatchObject({ recipient: 'karim@example.com', subject: EMAIL_DEFAULTS.CART_REMINDER.subject })
      expect(email.data?.vars.cart).toMatchObject({ url, total: 1200, item_count: 2 })
      expect(email.data?.vars.cart.line_items[0]).toMatchObject({ title: 'Cotton panjabi', quantity: 2, line_price: 1200 })
      expect(email.data?.vars.customer.first_name).toBe('Karim')
      await asService(db)
      expect(await value(db, `select public.messaging_due_carts(50)`)).toEqual([])
      expect(await value(db, `select public.messaging_queue_cart('own', $1, 1, $2)`, [cart, url])).toBe(0)

      // A day later, nothing happened: the second reminder.
      await asSystem(db)
      await db.query(`update public.notification_logs set created_at = now() - interval '25 hours' where event = 'CART_REMINDER'`)
      await db.query(`update public.store_carts set last_activity_at = now() - interval '27 hours' where id = $1`, [cart])
      await asService(db)
      expect(await value(db, `select public.messaging_due_carts(50)`)).toEqual([{ source: 'own', id: cart, step: 2, url: null }])
      expect(await value(db, `select public.messaging_queue_cart('own', $1, 2, $2)`, [cart, url])).toBe(2)
      expect(await value(db, `select public.messaging_due_carts(50)`)).toEqual([])

      // Bought: recovered.
      await asSystem(db)
      await db.query(`update public.notification_logs set status = 'SENT' where event = 'CART_REMINDER'`)
      await db.query(`update public.store_carts set status = 'CONVERTED', order_id = $2, recovered = true where id = $1`, [cart, o.id])
      expect(await value<Record<string, any>>(db, `select public._cart_recovery_stats(30)`)).toMatchObject({ reminded: 1, recovered: 1 })
      await asService(db)
      await expectError(db, `select public.messaging_queue_cart('own', $1, 3, $2)`, [cart, url], /unknown cart/)
    }))
})

describe('messages v2: review requests', () => {
  it('the chosen days after delivery, with the review link, once; nothing without a link', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      const o = await order(db, '01711000851')
      await smsOn(db, ['REVIEW_REQUEST'])
      await daytime(db)
      await db.query(`update public.orders set status = 'DELIVERED', delivered_at = now() - interval '4 days' where id = $1`, [o.id])
      await asService(db)
      expect(await value(db, `select public.messaging_run_reviews(100)`)).toBe(0) // no review link yet
      await asUser(db, admin)
      await expectError(db, `select public.messaging_settings_save('{"review": {"days": 3, "url": "facebook.com/x"}}')`, [], /https/)
      await db.query(`select public.messaging_settings_save('{"review": {"days": 3, "url": "https://www.facebook.com/isolation/reviews"}}')`)
      await asService(db)
      expect(await value(db, `select public.messaging_run_reviews(100)`)).toBe(1)
      expect(await value(db, `select public.messaging_run_reviews(100)`)).toBe(0)
      const [sms] = await logsOf(db, `order_id = $1 and event = 'REVIEW_REQUEST'`, [o.id])
      expect(sms.body).toBe(`How was your order ${o.order_number}? Please leave a quick review: https://www.facebook.com/isolation/reviews - My Store`)
    }))
})

describe('messages v2: the owner\'s daily summary', () => {
  it('yesterday in numbers, once a day from the chosen hour, to the chosen addresses', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.messaging_settings_save('{"summary": {"enabled": true, "emails": []}}')`, [], /email address the summary goes to/)
      await expectError(db, `select public.messaging_settings_save('{"summary": {"enabled": true, "emails": ["nope"]}}')`, [], /not valid/)
      await expectError(db, `select public.messaging_settings_save($1::jsonb)`, [JSON.stringify({ summary: { emails: ['a@b.co', 'b@b.co', 'c@b.co', 'd@b.co', 'e@b.co', 'f@b.co'] } })], /at most 5/)
      await db.query(`select public.messaging_settings_save('{"summary": {"enabled": true, "hour": 0, "emails": ["Owner@Shop.com", "owner@shop.com"]}}')`)
      await asService(db)
      expect(await value(db, `select public.messaging_run_summary()`)).toEqual({ sent: 0, reason: 'email_not_set_up' })

      await emailOn(db, admin)
      const o = await order(db, '01711000861')
      await db.query(`update public.orders set created_at = (date_trunc('day', now() at time zone public.store_timezone()) - interval '12 hours') at time zone public.store_timezone() where id = $1`, [o.id])
      await asService(db)
      expect(await value(db, `select public.messaging_run_summary()`)).toEqual({ sent: 1 })
      expect(await value(db, `select public.messaging_run_summary()`)).toEqual({ sent: 0, reason: 'not_due' })
      const [mail] = await logsOf(db, `event = 'DAILY_SUMMARY'`)
      expect(mail).toMatchObject({ channel: 'EMAIL', purpose: 'SUMMARY', recipient: 'owner@shop.com', status: 'QUEUED' })
      expect(mail.data?.vars.summary).toMatchObject({ orders: 1, orders_value: expect.anything(), waiting: expect.any(Number) })
      expect(mail.data?.liquid).toBe(true)
    }))
})

describe('messages v2: English and Bangla', () => {
  it('switches the texts nobody changed, keeps the store\'s own, and resets to the store\'s language', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      const manager = await createStaff(db, 'MANAGER')
      await asSystem(db)
      const cancelled = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_CANCELLED'`)
      await asUser(db, admin)
      await db.query(`select public.notification_message_save($1, 'Sorry', '<p>Our own words</p>')`, [cancelled])
      const r = await value<Record<string, any>>(db, `select public.messaging_language_set('bn', true)`)
      expect(r.changed).toBeGreaterThan(30)
      expect(r.custom).toBe(1)
      await asSystem(db)
      expect(await value(db, `select template from public.notifications where channel = 'WHATSAPP' and event = 'ORDER_SHIPPED'`)).toBe(WHATSAPP_DEFAULTS_BN.ORDER_SHIPPED)
      expect(await value(db, `select template from public.notifications where channel = 'SMS' and event = 'ORDER_CONFIRMED'`)).toBe(SMS_DEFAULTS_BN.ORDER_CONFIRMED)
      expect(await value(db, `select template from public.notifications where channel = 'EMAIL' and event = 'ORDER_CANCELLED'`)).toBe('<p>Our own words</p>')
      await asUser(db, admin)
      expect((await value<Record<string, any>>(db, `select public.whatsapp_settings()`)).language).toBe('bn')
      expect(await value(db, `select template from public.notification_message_reset($1)`, [cancelled])).toBe(EMAIL_DEFAULTS_BN.ORDER_CANCELLED.template)
      await db.query(`select public.messaging_language_set('en', true)`)
      await asSystem(db)
      expect(await value(db, `select template from public.notifications where channel = 'SMS' and event = 'ORDER_CONFIRMED'`)).toBe(SMS_DEFAULTS.ORDER_CONFIRMED)
      expect(await value(db, `select template from public.notifications where channel = 'EMAIL' and event = 'ORDER_CANCELLED'`)).toBe(EMAIL_DEFAULTS.ORDER_CANCELLED.template)

      await asUser(db, manager)
      expect((await value<Record<string, any>>(db, `select public.messaging_settings()`)).language).toBe('en')
      await expectError(db, `select public.messaging_language_set('bn', true)`, [], /permission/i)
      await expectError(db, `select public.messaging_settings_save('{"cart": {"first_minutes": 30}}')`, [], /permission/i)
      await asUser(db, admin)
      await expectError(db, `select public.messaging_settings_save('{"cart": {"first_minutes": 5}}')`, [], /15 minutes/)
      expect((await value<Record<string, any>>(db, `select public.messaging_settings_save('{"cart": {"first_minutes": 30, "second": false}}')`)).cart)
        .toEqual({ first_minutes: 30, second: false, second_hours: 24 })
    }))
})

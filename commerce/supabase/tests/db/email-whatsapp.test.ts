import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { EMAIL_DEFAULTS, LANGUAGES, MESSAGE_EVENTS, messageDefaults, SUMMARY_EMAIL, WHATSAPP_DEFAULTS } from '../../functions/_shared/notifications/defaults'
import { asService, asSystem, asUser, closePool, type Db, expectError, inTx, one, value } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

interface Log { id: string; status: string; provider: string | null; recipient: string; subject: string | null; body: string; error: string | null; data: Record<string, any> | null }

async function logs(db: Db, channel: 'EMAIL' | 'WHATSAPP', orderId: string): Promise<Log[]> {
  await asSystem(db)
  const { rows } = await db.query<Log>(`select * from public.notification_logs where channel = $1 and order_id = $2 order by created_at, id`, [channel, orderId])
  return rows
}

async function order(db: Db, phone = '01711000801', email: string | null = 'rahim@example.com') {
  const p = await createProduct(db, { price: 600, cost: 250, stock: 5 })
  const o = await createOrder(db, { phone, name: 'Rahim Uddin', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
  return o.id ? { ...o, email } : o
}

/** An order whose customer gave an email (the order is created first, so nothing is queued for it yet). */
async function orderWithEmail(db: Db, email = 'rahim@example.com', phone = '01711000801') {
  await asSystem(db)
  await db.query(`update public.notifications set is_enabled = false where channel in ('EMAIL', 'WHATSAPP')`)
  const o = await order(db, phone)
  await asSystem(db)
  await db.query(`update public.orders set customer_email = $2 where id = $1`, [o.id, email])
  return o
}

/** Fullfilio's email service set up by the platform (switched on, sender address, API key saved). */
async function emailService(db: Db, dailyLimit = 300) {
  await asSystem(db)
  await db.query(`update public.platform_settings set value = jsonb_build_object('enabled', true, 'from_email', 'mail@send.fullfilio.com', 'from_name', 'Fullfilio', 'daily_limit', $1::int) where key = 'email_service'`, [dailyLimit])
  await db.query(`select public.platform_secret_store('email.resend', '{"api_key": "re_test_key_123456"}'::jsonb, 're_…3456', null)`)
}

async function whatsappNumber(db: Db): Promise<string> {
  await asService(db)
  const row = await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform: 'WHATSAPP', external_id: '109876543210', waba_id: '2233445566', display_phone: '+880 1711-000000', name: 'Isolation' })])
  return row.id
}

const enqueue = async (db: Db, orderId: string, event: string, ref: string | null = null) => {
  await asSystem(db)
  return value<number>(db, `select public._enqueue_order_notification($1, $2::public.notification_event, $3, null)`, [orderId, event, ref])
}

describe('email & WhatsApp: defaults', () => {
  it('stores the same defaults as the code, and every store starts from them', () =>
    inTx(async (db) => {
      await asSystem(db)
      const { rows } = await db.query<{ channel: string; event: string; language: string; subject: string | null; template: string }>(`select * from public.notification_defaults`)
      // Every event's email, WhatsApp text and SMS in English and Bangla, and the daily summary email in both.
      expect(rows).toHaveLength(LANGUAGES.length * (MESSAGE_EVENTS.length * 3 + 1))
      for (const lang of LANGUAGES) {
        const d = messageDefaults(lang)
        const find = (channel: string, e: string) => rows.find((r) => r.channel === channel && r.event === e && r.language === lang)
        for (const e of MESSAGE_EVENTS) {
          expect(find('EMAIL', e)).toMatchObject({ subject: d.email[e].subject, template: d.email[e].template })
          expect(find('WHATSAPP', e)?.template).toBe(d.whatsapp[e])
          expect(find('SMS', e)?.template).toBe(d.sms[e])
        }
        expect(find('EMAIL', 'DAILY_SUMMARY')).toMatchObject(SUMMARY_EMAIL[lang])
      }
      const email = await one<{ subject: string; template: string }>(db, `select subject, template from public.notifications where channel = 'EMAIL' and event = 'ORDER_SHIPPED'`)
      expect(email).toEqual({ subject: EMAIL_DEFAULTS.ORDER_SHIPPED.subject, template: EMAIL_DEFAULTS.ORDER_SHIPPED.template })
      expect(await value(db, `select template from public.notifications where channel = 'WHATSAPP' and event = 'ORDER_SHIPPED'`)).toBe(WHATSAPP_DEFAULTS.ORDER_SHIPPED)

      // A new store's notifications are seeded with the old plain wording: they get the designs instead.
      const n = await one<{ template: string; subject: string }>(db, `insert into public.notifications(event, channel, is_enabled, subject, template)
        values ('ORDER_DELIVERED', 'EMAIL', false, 'Old', 'Your order {{order_number}} was delivered. - {{store_name}}') returning template, subject`)
      expect(n).toEqual({ template: EMAIL_DEFAULTS.ORDER_DELIVERED.template, subject: EMAIL_DEFAULTS.ORDER_DELIVERED.subject })

      // The migration file holds exactly what scripts/gen-notification-defaults.mjs prints.
      const sql = readFileSync(new URL('../../migrations/20261126000200_messaging_v2.sql', import.meta.url), 'utf8')
      for (const e of MESSAGE_EVENTS) expect(sql).toContain(`$t$${EMAIL_DEFAULTS[e].template}$t$`)
    }))
})

describe('email & WhatsApp: who may do what', () => {
  it('admins edit and switch on; managers and order managers only look; others see nothing', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      const manager = await createStaff(db, 'MANAGER')
      const viewer = await createStaff(db, 'VIEWER')
      await asSystem(db)
      const id = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_CREATED'`)

      await asUser(db, admin)
      expect((await value<Record<string, unknown>>(db, `select public.email_settings()`)).provider).toBe('none')
      await db.query(`select public.notification_message_enable($1, true)`, [id])
      expect(await value(db, `select count(*)::int from public.notifications where channel in ('EMAIL', 'WHATSAPP')`)).toBeGreaterThanOrEqual(24)
      // Not even an admin writes the table directly: Meta's review stays as Meta reported it.
      const { rowCount } = await db.query(`update public.notifications set wa_status = 'APPROVED', wa_name = 'ff_x_v1' where channel = 'WHATSAPP'`)
      expect(rowCount).toBe(0)

      await asUser(db, manager)
      expect(await value(db, `select count(*)::int from public.notifications where channel = 'EMAIL'`)).toBeGreaterThanOrEqual(12)
      await expectError(db, `select public.notification_message_enable($1, false)`, [id], /permission/i)
      await expectError(db, `select public.email_settings_save('{"from_name": "x"}')`, [], /permission/i)

      await asUser(db, viewer)
      expect(await value(db, `select count(*)::int from public.notifications where channel = 'EMAIL'`)).toBe(0)
      await expectError(db, `select public.email_settings()`, [], /permission/i)
      await expectError(db, `select public._notification_data(gen_random_uuid(), null)`, [], /permission denied/i)
    }))

  it('validates the sender, the design and the switch', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.email_settings_save('{"enabled": true}')`, [], /choose how emails are sent/)
      await expectError(db, `select public.email_settings_save('{"provider": "fullfilio"}')`, [], /not available/)
      await expectError(db, `select public.email_settings_save('{"provider": "smtp"}')`, [], /connect your mailbox/)
      await expectError(db, `select public.email_settings_save('{"reply_to": "not an email"}')`, [], /not an email/)
      await expectError(db, `select public.email_settings_save('{"design": {"logo_url": "javascript:alert(1)"}}')`, [], /https/)
      await expectError(db, `select public.email_settings_save('{"design": {"accent_color": "red"}}')`, [], /hex/)
      await expectError(db, `select public.email_settings_save('{"from_name": "<b>x</b>"}')`, [], /sender name/)

      await emailService(db)
      await asUser(db, admin)
      const s = await value<Record<string, any>>(db, `select public.email_settings_save('{"provider": "fullfilio", "enabled": true, "from_name": "Isolation", "reply_to": "Hello@Isolation.com", "design": {"accent_color": "#2142E7"}}')`)
      expect(s).toMatchObject({ provider: 'fullfilio', enabled: true, ready: true, from_name: 'Isolation', reply_to: 'hello@isolation.com' })
      expect(s.design.accent_color).toBe('#2142e7')
      expect(s.service).toMatchObject({ available: true, daily_limit: 300, sent_today: 0 })
    }))
})

describe('email: queued with the order and rendered by the sender', () => {
  it('queues the template and the order data for customers with an email, never twice', () =>
    inTx(async (db) => {
      await emailService(db)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.email_settings_save('{"provider": "fullfilio", "enabled": true}')`)
      const o = await orderWithEmail(db, 'Rahim@Example.com')
      await asSystem(db)
      await db.query(`update public.notifications set is_enabled = true where channel = 'EMAIL' and event = 'ORDER_CREATED'`)

      expect(await enqueue(db, o.id, 'ORDER_CREATED')).toBe(1)
      expect(await enqueue(db, o.id, 'ORDER_CREATED')).toBe(0)
      const [log, ...rest] = await logs(db, 'EMAIL', o.id)
      expect(rest).toHaveLength(0)
      expect(log).toMatchObject({ status: 'QUEUED', provider: 'fullfilio', recipient: 'rahim@example.com', subject: EMAIL_DEFAULTS.ORDER_CREATED.subject })
      expect(log.body).toBe(EMAIL_DEFAULTS.ORDER_CREATED.template)
      expect(log.data?.liquid).toBe(true)
      expect(log.data?.vars.order).toMatchObject({ name: o.order_number, item_count: 2, payment_method: 'Cash on delivery' })
      expect(log.data?.vars.order.line_items).toHaveLength(1)
      expect(log.data?.vars.order.line_items[0]).toMatchObject({ quantity: 2 })
      expect(log.data?.vars.customer).toMatchObject({ first_name: 'Rahim', email: 'Rahim@Example.com' })
      expect(log.data?.vars.shop.accent_color).toBe('#111827')

      // The sender learns how to send it, then keeps what it rendered.
      await asService(db)
      const plan = await value<Record<string, any>>(db, `select public._notification_send_plan($1)`, [log.id])
      expect(plan).toMatchObject({ channel: 'EMAIL', provider: 'fullfilio', liquid: true, rendered: false })
      expect(plan.service.from_email).toBe('mail@send.fullfilio.com')
      await db.query(`select id from public.claim_notifications(50)`)
      await db.query(`select public._notification_log_rendered($1, 'Order received', '<p>Hi Rahim</p>')`, [log.id])
      await asSystem(db)
      const after = await one<Log>(db, `select * from public.notification_logs where id = $1`, [log.id])
      expect(after).toMatchObject({ subject: 'Order received', body: '<p>Hi Rahim</p>', status: 'SENDING' })
      expect(after.data?.rendered).toBe(true)

      // No email on the order: nothing to send, nothing logged.
      const noEmail = await orderWithEmail(db, '')
      await asSystem(db)
      await db.query(`update public.orders set customer_email = null where id = $1`, [noEmail.id])
      await db.query(`update public.notifications set is_enabled = true where channel = 'EMAIL' and event = 'ORDER_CREATED'`)
      expect(await enqueue(db, noEmail.id, 'ORDER_CREATED')).toBe(0)
      expect(await logs(db, 'EMAIL', noEmail.id)).toHaveLength(0)
    }))

  it('sends nothing while email is off or not set up, and stops at the daily limit of the Fullfilio service', () =>
    inTx(async (db) => {
      const o = await orderWithEmail(db)
      await asSystem(db)
      await db.query(`update public.notifications set is_enabled = true where channel = 'EMAIL' and event = 'ORDER_CONFIRMED'`)
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED')).toBe(0) // not set up

      await emailService(db, 1)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.email_settings_save('{"provider": "fullfilio", "enabled": true}')`)
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED')).toBe(1)
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED', 'second')).toBe(0)
      const limited = (await logs(db, 'EMAIL', o.id)).find((l) => l.status !== 'QUEUED')!
      expect(limited).toMatchObject({ status: 'SKIPPED' })
      expect(limited.error).toMatch(/limit of 1 emails/)

      await asUser(db, admin)
      await db.query(`select public.email_settings_save('{"enabled": false}')`)
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED', 'third')).toBe(0)
      expect(await logs(db, 'EMAIL', o.id)).toHaveLength(2)
    }))

  it('editing, resetting and retrying', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asSystem(db)
      const id = await value<string>(db, `select id from public.notifications where channel = 'EMAIL' and event = 'ORDER_CANCELLED'`)
      await asUser(db, admin)
      await expectError(db, `select public.notification_message_save($1, '', '<p>x</p>')`, [id], /subject/)
      await expectError(db, `select public.notification_message_save($1, 'Hi', '   ')`, [id], /write the message/)
      const saved = await one<{ subject: string; template: string }>(db, `select subject, template from public.notification_message_save($1, ' Cancelled {{ order.name }} ', '<p>Sorry {{ customer.first_name }}</p>')`, [id])
      expect(saved).toEqual({ subject: 'Cancelled {{ order.name }}', template: '<p>Sorry {{ customer.first_name }}</p>' })
      const reset = await one<{ subject: string; template: string }>(db, `select subject, template from public.notification_message_reset($1)`, [id])
      expect(reset).toEqual({ subject: EMAIL_DEFAULTS.ORDER_CANCELLED.subject, template: EMAIL_DEFAULTS.ORDER_CANCELLED.template })

      await asSystem(db)
      const logId = await value<string>(db, `insert into public.notification_logs(event, channel, recipient, subject, body, status, error, provider)
        values ('ORDER_CANCELLED', 'EMAIL', 'a@b.co', 's', 'b', 'FAILED', 'mailbox said no', 'smtp') returning id`)
      await asUser(db, admin)
      await db.query(`select public.retry_notification($1)`, [logId])
      await asSystem(db)
      expect(await value(db, `select status::text from public.notification_logs where id = $1`, [logId])).toBe('QUEUED')
    }))
})

describe('WhatsApp: approved templates only', () => {
  it('needs a connected number, skips until Meta approves, then queues the approved text with its values', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.whatsapp_settings_save('{"enabled": true}')`, [], /WhatsApp number/)
      await expectError(db, `select public.whatsapp_settings_save($1::jsonb)`, [JSON.stringify({ channel_id: '00000000-0000-4000-8000-0000000000aa' })], /connected in Messaging/)
      const number = await whatsappNumber(db)
      await asUser(db, admin)
      const s = await value<Record<string, any>>(db, `select public.whatsapp_settings_save($1::jsonb)`, [JSON.stringify({ channel_id: number, enabled: true, language: 'en' })])
      expect(s).toMatchObject({ enabled: true, provider: 'meta', channel_id: number, ready: true })
      expect(s.numbers).toHaveLength(1)

      const o = await orderWithEmail(db, 'x@y.co', '01711000802')
      await asSystem(db)
      const tpl = await value<string>(db, `update public.notifications set is_enabled = true where channel = 'WHATSAPP' and event = 'ORDER_CONFIRMED' returning id`)
      await enqueue(db, o.id, 'ORDER_CONFIRMED')
      const [skipped] = await logs(db, 'WHATSAPP', o.id)
      expect(skipped).toMatchObject({ status: 'SKIPPED', recipient: '8801711000802' })
      expect(skipped.error).toMatch(/not approved by Meta/)

      // Approved by Meta (recorded by the messaging function).
      await asService(db)
      await db.query(`select public._whatsapp_template_record($1, $2::jsonb)`, [tpl, JSON.stringify({
        name: 'ff_order_confirmed_v1', language: 'en', status: 'approved', template_id: '998877', version: 1,
        params: ['customer_first_name', 'order_number', 'cod_amount', 'store_name'], body: WHATSAPP_DEFAULTS.ORDER_CONFIRMED,
      })])
      // Edited afterwards: the approved text keeps going out until the new one is submitted.
      await asUser(db, admin)
      await db.query(`select public.notification_message_save($1, null, 'Hello {{customer_first_name}}, a new text for your order today.')`, [tpl])
      expect(await enqueue(db, o.id, 'ORDER_CONFIRMED', 'again')).toBe(1)
      const queued = (await logs(db, 'WHATSAPP', o.id)).find((l) => l.status === 'QUEUED')!
      expect(queued).toMatchObject({ status: 'QUEUED', provider: 'meta', recipient: '8801711000802' })
      expect(queued.body).toContain(`your order ${o.order_number} is confirmed`)
      expect(queued.body).toContain('Amount to pay on delivery: ৳')

      await asService(db)
      const plan = await value<Record<string, any>>(db, `select public._notification_send_plan($1)`, [queued.id])
      expect(plan).toMatchObject({ channel: 'WHATSAPP', approved: true, template: 'ff_order_confirmed_v1', language: 'en',
        phone_number_id: '109876543210', waba_id: '2233445566', connected: true })
      expect(plan.params).toHaveLength(4)
      expect(plan.params[0]).toBe('Rahim')
      expect(plan.params[1]).toBe(o.order_number)
      expect(plan.params[2]).toMatch(/^৳[0-9,]+$/)
    }))

  it('staff with order access get the texts filled in for "Send on WhatsApp"', () =>
    inTx(async (db) => {
      const o = await order(db, '01711000803')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      const r = await value<{ phone: string; messages: Array<{ event: string; name: string; text: string }> }>(db, `select public.whatsapp_order_messages($1)`, [o.id])
      expect(r.phone).toBe('8801711000803')
      // Every order message (not the cart reminder), in the order an order lives through them.
      expect(r.messages.map((m) => m.event)).toEqual(['ORDER_CREATED', 'ORDER_CONFIRMED', 'PRE_ORDER_CONFIRMED', 'ADVANCE_REQUIRED', 'PAYMENT_RECEIVED',
        'PAYMENT_FAILED', 'ORDER_SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'ORDER_DELIVERED', 'REVIEW_REQUEST', 'ORDER_CANCELLED',
        'RETURN_INITIATED', 'ORDER_RETURNED'])
      expect(r.messages[0].text).toContain(`Hi Rahim, thank you for your order ${o.order_number} of ৳`)
      const viewer = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, viewer)
      expect(await value(db, `select (public.whatsapp_order_messages($1) -> 'phone')::text`, [o.id])).toBe('"8801711000803"')
    }))
})

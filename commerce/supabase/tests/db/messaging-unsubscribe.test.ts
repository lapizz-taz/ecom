import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, type Db, expectError, inTx, value } from '../support/db'
import { createOrder, createProduct, createStaff, setSetting, storeZone } from '../support/fixtures'

afterAll(closePool)

interface Log { id: string; event: string; channel: string; status: string; recipient: string; error: string | null }

/** Fullfilio's email service set up by the platform and chosen by the store. */
async function emailOn(db: Db, admin: string) {
  await asSystem(db)
  await db.query(`update public.platform_settings set value = jsonb_build_object('enabled', true, 'from_email', 'mail@send.fullfilio.com', 'from_name', 'Fullfilio', 'daily_limit', 300) where key = 'email_service'`)
  await db.query(`select public.platform_secret_store('email.resend', '{"api_key": "re_test_key_123456"}'::jsonb, 're_…3456', null)`)
  await asUser(db, admin)
  await db.query(`select public.email_settings_save('{"provider": "fullfilio", "enabled": true}')`)
}

/** A store time zone in which it is day now (reminders wait for the day). */
async function daytime(db: Db) {
  await asSystem(db)
  await setSetting(db, 'store', { timezone: storeZone() })
}

/** An order for karim@example.com and his abandoned cart; only the email cart reminder and order confirmation are on. */
async function shopper(db: Db) {
  await asSystem(db)
  await db.query(`update public.notifications set is_enabled = false`)
  const p = await createProduct(db, { price: 600, cost: 250, stock: 10 })
  const o = await createOrder(db, { phone: '01711000871', name: 'Karim Ahmed', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await asSystem(db)
  await db.query(`update public.orders set customer_email = 'Karim@Example.com' where id = $1`, [o.id])
  await db.query(`update public.customers set email = 'Karim@Example.com' where phone = (select customer_phone from public.orders where id = $1)`, [o.id])
  await db.query(`update public.notifications set is_enabled = true where channel = 'EMAIL' and event in ('CART_REMINDER', 'ORDER_CREATED')`)
  const cart = await value<string>(db, `insert into public.store_carts(visitor_id, status, reached_checkout, items, item_count, subtotal, phone, customer_name, last_activity_at)
    values ('visitor-0871', 'ACTIVE', true, $1::jsonb, 1, 600, (select customer_phone from public.orders where id = $2), 'Karim Ahmed', now() - interval '2 hours')
    returning id`, [JSON.stringify([{ variant_id: p.variantIds[0], name: 'Cotton panjabi', variant: 'L', quantity: 1, unit_price: 600, image: null }]), o.id])
  await daytime(db)
  return { order: o, cart }
}

async function emailLogs(db: Db, event: string): Promise<Log[]> {
  await asSystem(db)
  return (await db.query<Log>(`select * from public.notification_logs where channel = 'EMAIL' and event = $1 order by created_at, id`, [event])).rows
}

const plan = async (db: Db, logId: string) => {
  await asService(db)
  return value<Record<string, any>>(db, `select public._notification_send_plan($1)`, [logId])
}

describe('messaging: unsubscribe from cart reminders and review requests', () => {
  it('a cart reminder carries the address\'s private link; once unsubscribed, the next is not sent, order emails still are', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await emailOn(db, admin)
      const { order, cart } = await shopper(db)
      await asService(db)
      expect(await value(db, `select public.messaging_queue_cart('own', $1, 1, 'https://isolation.test/cart')`, [cart])).toBe(1)
      const [first] = await emailLogs(db, 'CART_REMINDER')
      expect(first).toMatchObject({ status: 'QUEUED', recipient: 'karim@example.com' })

      // The sender asks for the plan: the token is made once per address and stays the same.
      const p1 = await plan(db, first.id)
      expect(p1).toMatchObject({ unsubscribe_token: expect.stringMatching(/^[0-9a-f]{40}$/), language: 'en', merchant_id: expect.any(String) })
      expect((await plan(db, first.id)).unsubscribe_token).toBe(p1.unsubscribe_token)
      const token = p1.unsubscribe_token as string
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.email_preferences`)).toBe(1)

      // Order emails have no unsubscribe link: the customer needs them.
      await asSystem(db)
      await db.query(`select public._enqueue_order_notification($1, 'ORDER_CREATED', null, null)`, [order.id])
      const [created] = await emailLogs(db, 'ORDER_CREATED')
      expect((await plan(db, created.id)).unsubscribe_token).toBeNull()

      // The page: the store and the address, half hidden; nothing changes by opening it.
      await asService(db)
      const view = await value<Record<string, any>>(db, `select public.email_unsubscribe_view($1)`, [token])
      expect(view).toMatchObject({ email: 'k••••@example.com', unsubscribed: false, language: 'en', store: { name: expect.any(String) } })
      expect(view.store).not.toHaveProperty('email')
      expect(view.store).not.toHaveProperty('address')
      expect(await value(db, `select public.email_unsubscribe_view($1)`, ['f'.repeat(40)])).toBeNull()
      expect(await value(db, `select public.email_unsubscribe_view($1)`, ['not-a-token'])).toBeNull()
      expect(await value(db, `select public.email_unsubscribe_apply($1, false, 'LINK')`, ['f'.repeat(40)])).toBeNull()

      // The mail app's own button (one click); a second tap on the page keeps the first time and way.
      expect(await value<Record<string, any>>(db, `select public.email_unsubscribe_apply($1, false, 'ONE_CLICK')`, [token])).toMatchObject({ unsubscribed: true })
      await asSystem(db)
      const at = await value<string>(db, `select unsubscribed_at::text from public.email_preferences where token = $1`, [token])
      await asService(db)
      await db.query(`select public.email_unsubscribe_apply($1, false, 'LINK')`, [token])
      await asSystem(db)
      expect(await value(db, `select unsubscribed_at::text || ' ' || unsubscribed_via from public.email_preferences where token = $1`, [token])).toBe(`${at} ONE_CLICK`)

      // A day later, the second reminder is logged as not sent; so is "Send again" on the first.
      await db.query(`update public.notification_logs set created_at = now() - interval '25 hours', status = 'SENT' where event = 'CART_REMINDER'`)
      await db.query(`update public.store_carts set last_activity_at = now() - interval '27 hours' where id = $1`, [cart])
      await asService(db)
      expect(await value(db, `select public.messaging_queue_cart('own', $1, 2, 'https://isolation.test/cart')`, [cart])).toBe(1)
      const second = (await emailLogs(db, 'CART_REMINDER'))[1]
      expect(second).toMatchObject({ status: 'SKIPPED', error: 'The customer unsubscribed from these emails' })
      await asSystem(db)
      await db.query(`update public.notification_logs set status = 'QUEUED' where id = $1`, [first.id])
      expect((await emailLogs(db, 'CART_REMINDER'))[0].status).toBe('SKIPPED')

      // The order email goes as before.
      await db.query(`update public.notification_logs set status = 'SENT' where id = $1`, [created.id])
      await db.query(`select public._enqueue_order_notification($1, 'ORDER_CREATED', 'again', null)`, [order.id])
      expect((await emailLogs(db, 'ORDER_CREATED')).map((l) => l.status).sort()).toEqual(['QUEUED', 'SENT'])

      // Subscribed again from the page: reminders go again.
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.email_unsubscribe_apply($1, true, 'LINK')`, [token])).toMatchObject({ unsubscribed: false })
      await asSystem(db)
      expect(await value(db, `select unsubscribed_via from public.email_preferences where token = $1`, [token])).toBeNull()
      await db.query(`update public.notification_logs set status = 'QUEUED', error = null where id = $1`, [first.id])
      expect((await emailLogs(db, 'CART_REMINDER'))[0].status).toBe('QUEUED')
    }))

  it('only the messaging function reads or changes the preferences; one store never sees another\'s', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asSystem(db)
      const token = await value<string>(db, `select public._email_preference_token('Rahim@Example.com')`)
      expect(token).toMatch(/^[0-9a-f]{40}$/)
      expect(await value(db, `select public._email_preference_token('not an email')`)).toBeNull()

      for (const as of [() => asUser(db, admin), () => asAnon(db)]) {
        await as()
        await expectError(db, `select public.email_unsubscribe_view($1)`, [token], /permission denied/i)
        await expectError(db, `select public.email_unsubscribe_apply($1, false, 'LINK')`, [token], /permission denied/i)
        await expectError(db, `select public._email_preference_token('x@example.com')`, [], /permission denied/i)
        await expectError(db, `select count(*) from public.email_preferences`, [], /permission denied/i)
      }

      await asSystem(db, null)
      const other = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
      await asService(db, other)
      expect(await value(db, `select public.email_unsubscribe_view($1)`, [token])).toBeNull()
      expect(await value(db, `select public.email_unsubscribe_apply($1, false, 'LINK')`, [token])).toBeNull()
      await asSystem(db)
      expect(await value(db, `select unsubscribed_at from public.email_preferences where token = $1`, [token])).toBeNull()
      // The same address in another store is its own entry.
      await asSystem(db, other)
      const otherToken = await value<string>(db, `select public._email_preference_token('rahim@example.com')`)
      expect(otherToken).toMatch(/^[0-9a-f]{40}$/)
      expect(otherToken).not.toBe(token)
    }))
})

describe('messaging: what the Email and WhatsApp pages show', () => {
  it('the last 30 days of customer messages: sent, reached, read, failed, answers and unsubscribes; tests and the summary left out', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      const manager = await createStaff(db, 'MANAGER')
      const viewer = await createStaff(db, 'VIEWER')
      await asSystem(db)
      const insert = (channel: string, event: string, status: string, delivery: string | null, purpose = 'AUTOMATION', age = '1 day') =>
        db.query(`insert into public.notification_logs (channel, event, status, delivery_status, purpose, recipient, body, created_at, sent_at)
          values ($1::public.notification_channel, $2::public.notification_event, $3::public.notification_status, $4::text, $5::text, '01711000881', 'x', now() - $6::interval,
                  case when $3::text = 'SENT' then now() - $6::interval end)`, [channel, event, status, delivery, purpose, age])
      await insert('WHATSAPP', 'ORDER_CREATED', 'SENT', 'READ')
      await insert('WHATSAPP', 'ORDER_CREATED', 'SENT', 'DELIVERED')
      await insert('WHATSAPP', 'ORDER_SHIPPED', 'SENT', 'FAILED')
      await insert('WHATSAPP', 'ORDER_SHIPPED', 'SENT', null)
      await insert('WHATSAPP', 'ORDER_SHIPPED', 'FAILED', null)
      await insert('WHATSAPP', 'CART_REMINDER', 'SKIPPED', null)
      await insert('WHATSAPP', 'ORDER_CREATED', 'QUEUED', null)
      await insert('WHATSAPP', 'ORDER_CREATED', 'SENT', 'READ', 'AUTOMATION', '40 days') // too old
      await insert('WHATSAPP', 'ORDER_CREATED', 'SENT', 'READ', 'TEST')
      await insert('EMAIL', 'ORDER_CREATED', 'SENT', null)
      await db.query(`insert into public.email_preferences (email, token, unsubscribed_at, unsubscribed_via) values ('a@example.com', $1, now(), 'LINK')`, ['a'.repeat(40)])

      await asUser(db, manager)
      const wa = await value<Record<string, any>>(db, `select public.messaging_channel_stats('WHATSAPP')`)
      expect(wa).toMatchObject({
        days: 30, sent: 4, delivered: 2, read: 1, failed: 2, skipped: 1, waiting: 1, unsubscribed: 0, tested: true,
        by_event: { ORDER_CREATED: 2, ORDER_SHIPPED: 2 }, by_sms: 0, confirmed: 0, cancelled: 0,
      })
      expect(wa.last_sent_at).not.toBeNull()
      expect(await value<Record<string, any>>(db, `select public.messaging_channel_stats('EMAIL', 7)`))
        .toMatchObject({ days: 7, sent: 1, delivered: 0, unsubscribed: 1, tested: false, by_event: { ORDER_CREATED: 1 } })
      await asUser(db, admin)
      await expectError(db, `select public.messaging_channel_stats('SMS')`, [], /choose email or WhatsApp/)
      await asUser(db, viewer)
      await expectError(db, `select public.messaging_channel_stats('EMAIL')`, [], /permission/i)
      await asAnon(db)
      await expectError(db, `select public.messaging_channel_stats('EMAIL')`, [], /permission denied/i)
    }))
})

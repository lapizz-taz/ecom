import { afterAll, describe, expect, it } from 'vitest'
import { asService, asUser, closePool, type Db, expectError, inTx, num, one, value } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function channel(db: Db, platform = 'FACEBOOK', externalId = '4440001'): Promise<string> {
  await asService(db)
  return (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform, external_id: externalId, name: 'Isolation Page' })])).id
}

type Ingested = { conversation_id: string; message_id: string; duplicate: boolean; needs_post: boolean }
const ingest = async (db: Db, p: Record<string, unknown>) => {
  await asService(db)
  return value<Ingested>(db, `select public.inbox_ingest($1::jsonb)`, [JSON.stringify(p)])
}
const comment = (ch: string, id: string, post: string, body: string, who = { external_id: `u-${id}`, name: `User ${id}` }) =>
  ({ channel_id: ch, kind: 'COMMENT', thread_key: id, customer: who, post: { id: post, title: `Post ${post}` }, message: { external_id: id, body, sender_name: who.name } })
const plan = async (db: Db, r: Ingested) => {
  await asService(db)
  return value<{ replies: Array<{ rule_id: string; name: string; reply_text: string | null; private_text: string | null }>; moderate?: { reason: string } }>(
    db, `select public.inbox_automation_plan($1, $2)`, [r.conversation_id, r.message_id])
}

describe('inbox v2: comments by post', () => {
  it('groups comments by post, counts who waits, and follows replies, likes, hides and deletes', () =>
    inTx(async (db) => {
      const ch = await channel(db)
      const a1 = await ingest(db, comment(ch, 'c1', 'post_A', 'price?'))
      expect(a1.needs_post).toBe(true)
      await ingest(db, comment(ch, 'c2', 'post_A', 'how much for 4mm'))
      await ingest(db, comment(ch, 'c3', 'post_B', 'nice'))
      await asService(db)
      await db.query(`select public.inbox_post_save($1::jsonb)`, [JSON.stringify({ channel_id: ch, external_id: 'post_A', caption: 'Magnetic earrings', image_url: 'https://x/a.jpg', likes: 492, shares: 95 })])
      expect((await ingest(db, comment(ch, 'c4', 'post_A', 'more'))).needs_post).toBe(false)

      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const o = await value<{ counts: { all: number; awaiting: number }; posts: Array<{ post_id: string; caption: string; awaiting: number; total: number; likes: number }> }>(
        db, `select public.inbox_comments_overview('{"state":"awaiting"}')`)
      expect(o.counts).toMatchObject({ all: 4, awaiting: 4 })
      const postA = o.posts.find((p) => p.post_id === 'post_A')!
      expect(postA).toMatchObject({ caption: 'Magnetic earrings', awaiting: 3, total: 3, likes: 492 })

      const list = await value<{ total: number; items: Array<{ id: string; comment: { body: string } }> }>(db,
        `select public.inbox_comments($1::jsonb)`, [JSON.stringify({ channel_id: ch, post_id: 'post_A' })])
      expect(list.total).toBe(3)

      // A public reply answers it; "no reply needed" takes another off the list; a like and a delete are remembered.
      await asService(db)
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: a1.conversation_id, external_id: 'r1', body: 'Inbox korchi' }), staff])
      const c2 = list.items.find((i) => i.comment.body === 'how much for 4mm')!
      await asUser(db, staff)
      await db.query(`select public.inbox_bulk($1, '{"no_reply_needed": true, "read": true}')`, [[c2.id]])
      await asService(db)
      await db.query(`select public.inbox_message_flags($1, '{"liked": true, "detail": "Liked"}', $2)`, [a1.message_id, staff])
      const c3 = await value<string>(db, `select id from public.inbox_messages where external_id = 'c3'`)
      await db.query(`select public.inbox_message_flags($1, '{"removed": true, "detail": "Deleted"}', $2)`, [c3, staff])

      await asUser(db, staff)
      const states = async (state: string) => (await value<{ total: number }>(db, `select public.inbox_comments($1::jsonb)`, [JSON.stringify({ state })])).total
      expect(await states('awaiting')).toBe(1) // c4
      expect(await states('replied')).toBe(1)
      expect(await states('no_reply')).toBe(1)
      expect(await states('liked')).toBe(1)
      expect(await states('deleted')).toBe(1)
      const t = await value<{ history: Array<{ detail: string }>; post_detail: { caption: string } }>(db, `select public.inbox_thread($1)`, [a1.conversation_id])
      expect(t.post_detail.caption).toBe('Magnetic earrings')
      expect(t.history.map((h) => h.detail)).toContain('Liked')
    }))
})

describe('inbox v2: auto replies and moderation', () => {
  it('answers keywords on switched-on channels, greets first-time customers once, and hides spam comments', () =>
    inTx(async (db) => {
      const ch = await channel(db, 'FACEBOOK', '4440002')
      const owner = await createStaff(db, 'ADMIN')
      await asUser(db, owner)
      const price = await value<string>(db, `select public.inbox_auto_reply_save($1::jsonb)`, [JSON.stringify({
        name: 'Price', keywords: ['price', 'দাম'], applies_to: 'BOTH', reply_text: 'Inbox e janano hoyeche', private_text: 'Price: ৳580' })])
      await db.query(`select public.inbox_auto_reply_save($1::jsonb)`, [JSON.stringify({ name: 'Welcome', is_default: true, applies_to: 'MESSAGE', reply_text: 'Welcome to Isolation!' })])
      await expectError(db, `select public.inbox_auto_reply_save($1::jsonb)`, [JSON.stringify({ name: 'Second default', is_default: true, reply_text: 'x' })], /already a default/)
      await expectError(db, `select public.inbox_auto_reply_save($1::jsonb)`, [JSON.stringify({ name: 'No words', reply_text: 'x' })], /keyword/)

      // Not switched on for any channel yet: nothing runs.
      const m1 = await ingest(db, { channel_id: ch, thread_key: 'psid-a', message: { external_id: 'a1', body: 'Price koto?' } })
      expect((await plan(db, m1)).replies).toEqual([])

      await asUser(db, owner)
      await db.query(`select public.inbox_settings_save($1::jsonb)`, [JSON.stringify({ auto_reply_channels: [ch], moderation: { enabled: true, keywords: ['scam'] } })])
      const p1 = await plan(db, m1)
      expect(p1.replies).toMatchObject([{ rule_id: price, reply_text: 'Inbox e janano hoyeche', private_text: null }])
      await asService(db)
      await db.query(`select public.inbox_automation_record($1::jsonb)`, [JSON.stringify({ kind: 'AUTO_REPLY', status: 'SENT', rule_id: price, conversation_id: m1.conversation_id, message_id: m1.message_id })])
      // Once per customer.
      const m2 = await ingest(db, { channel_id: ch, thread_key: 'psid-a', message: { external_id: 'a2', body: 'price again' } })
      expect((await plan(db, m2)).replies).toEqual([])
      expect(await value(db, `select sent_count from public.inbox_auto_replies where id = $1`, [price])).toBe(1)

      // A brand-new customer with no keyword gets the default first reply; their second message does not.
      const n1 = await ingest(db, { channel_id: ch, thread_key: 'psid-b', message: { external_id: 'b1', body: 'hello' } })
      expect((await plan(db, n1)).replies).toMatchObject([{ name: 'Welcome' }])
      const n2 = await ingest(db, { channel_id: ch, thread_key: 'psid-b', message: { external_id: 'b2', body: 'hello?' } })
      expect((await plan(db, n2)).replies).toEqual([])

      // Comments: the keyword rule answers in public and in private; replies inside the thread are left alone.
      const k1 = await ingest(db, comment(ch, 'k1', 'post_X', 'দাম কত?'))
      expect((await plan(db, k1)).replies).toMatchObject([{ reply_text: 'Inbox e janano hoyeche', private_text: 'Price: ৳580' }])
      const k2 = await ingest(db, { ...comment(ch, 'k1', 'post_X', 'price pls'), message: { external_id: 'k1_reply', body: 'price pls', reply_to_external_id: 'k1' } })
      expect((await plan(db, k2)).replies).toEqual([])

      // Moderation: phone numbers, links and chosen words are hidden instead of answered.
      for (const [id, body, reason] of [['s1', 'call me 01712-345678', 'Phone number'], ['s2', 'visit www.cheap.xyz', 'Link'], ['s3', 'this is a SCAM', 'Word: scam']]) {
        const s = await ingest(db, comment(ch, id, 'post_X', body))
        expect((await plan(db, s)).moderate?.reason).toBe(reason)
      }
      expect((await plan(db, await ingest(db, comment(ch, 's4', 'post_X', 'love it')))).moderate).toBeUndefined()

      await asUser(db, owner)
      const tried = await value<{ rule: { name: string } | null; moderation: { reason: string } | null }>(db, `select public.inbox_auto_reply_try('what is the price', 'COMMENT', null, true)`)
      expect(tried.rule?.name).toBe('Price')
      const spam = await value<{ moderation: { reason: string } | null }>(db, `select public.inbox_auto_reply_try('wa.me/8801', 'COMMENT', null, true)`)
      expect(spam.moderation?.reason).toBe('Link')

      const viewer = await createStaff(db, 'MANAGER')
      await asUser(db, viewer)
      await expectError(db, `select public.inbox_auto_reply_save('{"name":"x","keywords":["a"],"reply_text":"b"}')`, [], /permission/i)
      expect(await value<{ rules: unknown[] }>(db, `select public.inbox_automation()`)).toMatchObject({ rules: expect.any(Array) })
    }))
})

describe('inbox v2: follow-ups, reminders, typed phone numbers, order messages', () => {
  it('schedules a follow-up after a reply, cancels it when the customer answers, and sends only inside 24 hours', () =>
    inTx(async (db) => {
      const ch = await channel(db, 'INSTAGRAM', '4440003')
      const owner = await createStaff(db, 'ADMIN')
      await asUser(db, owner)
      await db.query(`select public.inbox_settings_save('{"follow_up": {"enabled": true, "after_minutes": 60, "text": "Order korben?"}}')`)
      const m = await ingest(db, { channel_id: ch, thread_key: 'igsid-1', message: { external_id: 'f1', body: 'amar number 01812 345 678' } })
      await asService(db)
      expect(await value(db, `select customer_phone from public.inbox_conversations where id = $1`, [m.conversation_id])).toBe('01812345678')

      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: m.conversation_id, external_id: 'o1', body: 'Ji available' }), owner])
      const c = await one<{ auto_follow_up_text: string; awaiting_since: string | null; mins: number }>(db,
        `select auto_follow_up_text, awaiting_since, extract(epoch from auto_follow_up_at - now()) / 60 as mins from public.inbox_conversations where id = $1`, [m.conversation_id])
      expect(c.auto_follow_up_text).toBe('Order korben?')
      expect(c.awaiting_since).toBeNull()
      expect(Math.round(Number(c.mins))).toBe(60)

      // Due now: claimed once, then gone.
      await db.query(`update public.inbox_conversations set auto_follow_up_at = now() - interval '1 minute' where id = $1`, [m.conversation_id])
      expect(await value(db, `select public.inbox_automation_due()`)).toBe(true)
      expect(await value(db, `select public.inbox_follow_ups_claim(10)`)).toEqual([{ conversation_id: m.conversation_id, text: 'Order korben?' }])
      expect(await value(db, `select public.inbox_follow_ups_claim(10)`)).toEqual([])

      // The customer answering cancels a pending one.
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: m.conversation_id, external_id: 'o2', body: 'Kichu lagbe?' }), owner])
      await ingest(db, { channel_id: ch, thread_key: 'igsid-1', message: { external_id: 'f2', body: 'yes' } })
      expect(await value(db, `select auto_follow_up_at from public.inbox_conversations where id = $1`, [m.conversation_id])).toBeNull()

      // A manual follow-up must land inside Meta's 24 hours.
      await asUser(db, owner)
      await db.query(`select public.inbox_follow_up_set($1, 120, 'Still interested?')`, [m.conversation_id])
      await expectError(db, `select public.inbox_follow_up_set($1, 1440, 'Too late')`, [m.conversation_id], /24 hours/)
      await db.query(`select public.inbox_follow_up_set($1, null)`, [m.conversation_id])
      await db.query(`select public.inbox_reminder_set($1, now() + interval '2 hours', 'Call back')`, [m.conversation_id])
      await asService(db)
      const row = await one<{ status: string; remind_note: string; auto_follow_up_at: string | null }>(db,
        `select status, remind_note, auto_follow_up_at from public.inbox_conversations where id = $1`, [m.conversation_id])
      expect(row).toMatchObject({ status: 'FOLLOW_UP', remind_note: 'Call back', auto_follow_up_at: null })

      // A follow-up the customer already answered is skipped and logged.
      await asService(db)
      await db.query(`update public.inbox_conversations set auto_follow_up_at = now() - interval '1 minute', auto_follow_up_text = 'x' where id = $1`, [m.conversation_id])
      expect(await value(db, `select public.inbox_follow_ups_claim(10)`)).toEqual([])
      expect(num(await value(db, `select count(*) from public.inbox_automation_log where conversation_id = $1 and kind = 'FOLLOW_UP' and status = 'SKIPPED'`, [m.conversation_id]))).toBe(1)

      // Filters: awaiting chats, chats with an order.
      await asUser(db, owner)
      const awaiting = await value<{ items: Array<{ id: string; awaiting_since: string | null }> }>(db, `select public.inbox_list('{"awaiting": true, "kind": "MESSAGE"}')`)
      expect(awaiting.items.map((i) => i.id)).toContain(m.conversation_id)
    }))

  it('writes the order status and the invoice for the chat', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { name: 'Magnetic Earring', price: 450, stock: 5 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }], phone: '01712000999', name: 'Nirjhora' })
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const status = await value<string>(db, `select public.inbox_order_message($1, 'STATUS')`, [order.id])
      expect(status).toContain(`Your order ${order.order_number} is`)
      expect(status).toContain('Magnetic Earring')
      const invoice = await value<string>(db, `select public.inbox_order_message($1, 'INVOICE')`, [order.id])
      expect(invoice).toContain('Invoice: order')
      expect(invoice).toMatch(/× 2 = ৳900/)
      expect(invoice).toContain('To pay on delivery:')
    }))
})

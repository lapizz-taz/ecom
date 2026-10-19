import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asService, asSystem, asUser, closePool, type Db, expectError, inTx, num, one, value } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

async function channel(db: Db, platform = 'FACEBOOK', externalId = '1234567890'): Promise<string> {
  await asService(db)
  const row = await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform, external_id: externalId, name: 'Isolation Page' })])
  return row.id
}

const ingest = (db: Db, p: Record<string, unknown>) =>
  value<{ conversation_id: string; message_id: string; duplicate: boolean }>(db, `select public.inbox_ingest($1::jsonb)`, [JSON.stringify(p)])

describe('inbox: messages arrive once', () => {
  it('creates the conversation, counts unread and ignores a webhook retry', () =>
    inTx(async (db) => {
      const ch = await channel(db)
      const msg = { channel_id: ch, thread_key: 'psid-1', customer: { external_id: 'psid-1', name: 'Nirjhora' },
        message: { external_id: 'm_1', body: 'Is the earring available?' } }
      const first = await ingest(db, msg)
      const again = await ingest(db, msg)
      expect(first.duplicate).toBe(false)
      expect(again).toMatchObject({ duplicate: true, conversation_id: first.conversation_id, message_id: first.message_id })
      await ingest(db, { ...msg, message: { external_id: 'm_2', body: '', attachments: [{ type: 'image', url: 'https://x/y.jpg' }] } })
      const conv = await one<{ unread_count: number; last_message_preview: string; status: string }>(db,
        `select unread_count, last_message_preview, status from public.inbox_conversations where id = $1`, [first.conversation_id])
      expect(conv).toMatchObject({ unread_count: 2, last_message_preview: 'Photo', status: 'OPEN' })
      expect(num(await value(db, `select count(*) from public.inbox_messages where conversation_id = $1`, [first.conversation_id]))).toBe(2)
    }))

  it('a customer writing again reopens a closed conversation; comments are their own threads', () =>
    inTx(async (db) => {
      const ch = await channel(db, 'INSTAGRAM', '178414000')
      const a = await ingest(db, { channel_id: ch, thread_key: 'igsid-9', message: { external_id: 'x1', body: 'hi' } })
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await db.query(`select public.inbox_update($1, '{"status":"DONE"}')`, [a.conversation_id])
      await asService(db)
      await ingest(db, { channel_id: ch, thread_key: 'igsid-9', message: { external_id: 'x2', body: 'still there?' } })
      const c = await ingest(db, { channel_id: ch, kind: 'COMMENT', thread_key: 'comment-1', post: { id: 'p1', title: 'Reel' },
        message: { external_id: 'comment-1', body: 'price?' } })
      expect(c.conversation_id).not.toBe(a.conversation_id)
      expect(await value(db, `select status from public.inbox_conversations where id = $1`, [a.conversation_id])).toBe('OPEN')
    }))

  it('links a WhatsApp number to the store customer with that number', () =>
    inTx(async (db) => {
      await asService(db)
      const customer = await value<string>(db, `insert into public.customers (full_name, phone) values ('Rahim', '01711000111') returning id`)
      const ch = await channel(db, 'WHATSAPP', '109876543210')
      const r = await ingest(db, { channel_id: ch, thread_key: '8801711000111', customer: { external_id: '8801711000111', phone: '8801711000111' },
        message: { external_id: 'wamid.1', body: 'order korte chai' } })
      expect(await value(db, `select customer_id from public.inbox_conversations where id = $1`, [r.conversation_id])).toBe(customer)
    }))
})

describe('inbox: staff', () => {
  it('lists, filters, reads, labels, pins and notes; order history comes with the thread', () =>
    inTx(async (db) => {
      const ch = await channel(db)
      const r = await ingest(db, { channel_id: ch, thread_key: 'psid-2', customer: { name: 'Karim' }, message: { external_id: 'k1', body: 'Need 2 rings' } })
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const list = await value<{ total: number; items: Array<{ id: string; platform: string; unread_count: number }> }>(db,
        `select public.inbox_list('{"status":"OPEN","platform":"FACEBOOK","unread":true}')`)
      expect(list.items.map((i) => i.id)).toContain(r.conversation_id)
      expect(list.items.find((i) => i.id === r.conversation_id)?.unread_count).toBe(1)

      const found = await value<{ total: number }>(db, `select public.inbox_list('{"q":"2 rings"}')`)
      expect(found.total).toBeGreaterThanOrEqual(1)

      await db.query(`select public.inbox_mark_read($1)`, [r.conversation_id])
      await db.query(`select public.inbox_update($1, $2::jsonb)`, [r.conversation_id,
        JSON.stringify({ labels: ['VIP', ' VIP ', 'Ring'], pinned_message_id: r.message_id, starred: true, assigned_to: staff, customer_phone: '01811-222333' })])
      await db.query(`select public.inbox_note_add($1, 'Wants delivery on Friday')`, [r.conversation_id])
      const t = await value<{ conversation: { labels: string[]; unread_count: number; starred: boolean; customer_phone: string }; pinned: { id: string }; notes: unknown[] }>(db,
        `select public.inbox_thread($1)`, [r.conversation_id])
      expect(t.conversation).toMatchObject({ unread_count: 0, starred: true, customer_phone: '01811222333' })
      expect([...t.conversation.labels].sort()).toEqual(['Ring', 'VIP'])
      expect(t.pinned.id).toBe(r.message_id)
      expect(t.notes).toHaveLength(1)

      const mine = await value<{ total: number }>(db, `select public.inbox_list('{"assigned":"me"}')`)
      expect(mine.total).toBe(1)
    }))

  it('only staff with inbox permissions get in; system functions stay closed', () =>
    inTx(async (db) => {
      const ch = await channel(db)
      const r = await ingest(db, { channel_id: ch, thread_key: 'psid-3', message: { external_id: 'z1', body: 'hello' } })
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.inbox_list('{}')`, [], /permission/i)
      const manager = await createStaff(db, 'MANAGER')
      await asUser(db, manager)
      await expectError(db, `select public.inbox_saved_reply_save('{"title":"Hi","body":"Hello"}')`, [], /permission/i)
      await expectError(db, `select public.inbox_ingest('{}')`, [], /permission/i)
      await expectError(db, `select * from public.inbox_channels`, [], /permission/i)
      await asAnon(db)
      await expectError(db, `select public.inbox_thread($1)`, [r.conversation_id], /permission/i)
    }))

  it('saved replies and outgoing messages', () =>
    inTx(async (db) => {
      const ch = await channel(db)
      const r = await ingest(db, { channel_id: ch, thread_key: 'psid-4', message: { external_id: 'q1', body: 'price?' } })
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.inbox_saved_reply_save('{"title":"Price","body":"৳580 with delivery"}')`)
      expect(await value<unknown[]>(db, `select public.inbox_saved_replies()`)).toHaveLength(1)
      await asService(db)
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: r.conversation_id, external_id: 'out1', body: '৳580 with delivery', reply_to_id: r.message_id }), admin])
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: r.conversation_id, body: 'second', error: 'outside the 24-hour window' }), admin])
      await db.query(`select public.inbox_message_status($1, 'out1', 'READ')`, [ch])
      const rows = await db.query(`select status, error from public.inbox_messages where conversation_id = $1 and direction = 'OUT' order by created_at`, [r.conversation_id])
      expect(rows.rows.map((x) => x.status).sort()).toEqual(['FAILED', 'READ'])
      expect(await value(db, `select unread_count from public.inbox_conversations where id = $1`, [r.conversation_id])).toBe(0)
    }))
})

describe('inbox: one Meta app for every store', () => {
  /** A second merchant with the same defaults a new business starts with. */
  async function createMerchant(db: Db): Promise<string> {
    await asSystem(db, null)
    const id = await value<string>(db, `insert into public.merchants (name) values ('Second shop') returning id`)
    await asSystem(db, id)
    await db.query(`select public._merchant_seed_defaults($1)`, [id])
    return id
  }
  const owner = async (db: Db, key: string) => {
    await asService(db, null)
    return value<string | null>(db, `select public.merchant_for('inbox_account', $1)`, [key])
  }
  const save = (db: Db, p: Record<string, unknown>) => db.query(`select public.inbox_channel_save($1::jsonb, null)`, [JSON.stringify(p)])

  it('sends each Page, Instagram account and number to the store that connected it', () =>
    inTx(async (db) => {
      await channel(db, 'FACEBOOK', '7770001')
      await asService(db)
      await save(db, { platform: 'INSTAGRAM', external_id: '1784000111', page_id: '7770001', name: '@isolation.pvt' })
      await save(db, { platform: 'WHATSAPP', external_id: '5550001', waba_id: '6660001', name: 'Isolation' })

      expect(await owner(db, 'FACEBOOK:7770001')).toBe(MERCHANT_1)
      expect(await owner(db, 'INSTAGRAM:1784000111')).toBe(MERCHANT_1)
      // Instagram messaging events can name the Page instead of the Instagram account.
      expect(await owner(db, 'INSTAGRAM:7770001')).toBe(MERCHANT_1)
      expect(await owner(db, 'WHATSAPP:5550001')).toBe(MERCHANT_1)
      expect(await owner(db, 'FACEBOOK:999')).toBeNull()
      expect(await owner(db, 'nonsense')).toBeNull()
    }))

  it('connects a Page to one store at a time', () =>
    inTx(async (db) => {
      const fb = await channel(db, 'FACEBOOK', '7770002')
      const other = await createMerchant(db)
      await asService(db, other)
      await expectError(db, `select public.inbox_channel_save($1::jsonb, null)`,
        [JSON.stringify({ platform: 'FACEBOOK', external_id: '7770002', name: 'Isolation Page' })], /already connected to another Fullfilio store/)

      // Disconnected in the first store: the second can have it, and events follow.
      await asService(db)
      await db.query(`select public.inbox_channel_status($1, 'DISCONNECTED', null)`, [fb])
      await asService(db, other)
      await save(db, { platform: 'FACEBOOK', external_id: '7770002', name: 'Isolation Page' })
      expect(await owner(db, 'FACEBOOK:7770002')).toBe(other)

      // And merchant_for stays closed to signed-in users.
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.merchant_for('inbox_account', 'FACEBOOK:7770002')`, [], /permission denied|PERMISSION_DENIED/i)
    }))

  it('removes a channel with its conversations, only from the system side, and frees the Page', () =>
    inTx(async (db) => {
      const fb = await channel(db, 'FACEBOOK', '7770031')
      const r = await ingest(db, { channel_id: fb, thread_key: 'psid-31', message: { external_id: 'rm_1', body: 'hello' } })
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.inbox_channel_remove($1, null)`, [fb], /permission denied|PERMISSION_DENIED/i)

      await asService(db)
      expect(await value(db, `select public.inbox_channel_remove($1, null)`, [fb])).toEqual({ removed: true, conversations: 1 })
      expect(num(await value(db, `select count(*) from public.inbox_conversations where id = $1`, [r.conversation_id]))).toBe(0)
      expect(num(await value(db, `select count(*) from public.inbox_messages where conversation_id = $1`, [r.conversation_id]))).toBe(0)
      expect(num(await value(db, `select count(*) from public.audit_logs where entity_id = $1 and action = 'inbox_channel.removed'`, [fb]))).toBe(1)
      expect(await owner(db, 'FACEBOOK:7770031')).toBeNull()
      await asService(db)
      await expectError(db, `select public.inbox_channel_remove($1, null)`, [fb], /NOT_FOUND/)
    }))
})

describe('inbox: menu badges', () => {
  it('counts unread messages and unread comments apart, and nothing without inbox access', () =>
    inTx(async (db) => {
      const ch = await channel(db, 'INSTAGRAM', '178414777')
      await ingest(db, { channel_id: ch, kind: 'COMMENT', thread_key: 'c-1', message: { external_id: 'c1', body: 'price?' } })
      await ingest(db, { channel_id: ch, kind: 'COMMENT', thread_key: 'c-2', message: { external_id: 'c2', body: 'size?' } })
      const dm = await ingest(db, { channel_id: ch, thread_key: 'igsid-5', message: { external_id: 'd1', body: 'hello' } })
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      expect(await value(db, `select public.inbox_unread_counts()`)).toEqual({ messages: 1, comments: 2 })
      await db.query(`select public.inbox_update($1, '{"status":"DONE"}')`, [dm.conversation_id])
      expect(await value(db, `select public.inbox_unread_counts()`)).toEqual({ messages: 0, comments: 2 })
      await asAnon(db)
      await expectError(db, `select public.inbox_unread_counts()`, [], /permission denied/)
    }))
})

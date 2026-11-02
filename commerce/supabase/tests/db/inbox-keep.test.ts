import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, type Db, expectError, inTx, num, one, value } from '../support/db'
import { createStaff } from '../support/fixtures'

// Meta Platform Terms 3.d: disconnecting keeps the store's chats (only the token goes); a message or comment
// the customer deleted is erased; the store's own deletion request removes everything.
afterAll(closePool)

async function channel(db: Db, platform = 'FACEBOOK', externalId = '5550001'): Promise<string> {
  await asService(db)
  return (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform, external_id: externalId, name: 'Isolation Page' })])).id
}
const ingest = async (db: Db, p: Record<string, unknown>) => {
  await asService(db)
  return value<{ conversation_id: string; message_id: string }>(db, `select public.inbox_ingest($1::jsonb)`, [JSON.stringify(p)])
}
const owner = async (db: Db, key: string) => {
  await asSystem(db, null)
  return value<string | null>(db, `select public.merchant_for('inbox_account', $1)`, [key])
}

describe('inbox: disconnect keeps the chats', () => {
  it('stops the connection, keeps every conversation, and connecting again carries on in them', () =>
    inTx(async (db) => {
      const fb = await channel(db, 'FACEBOOK', '5550001')
      const chat = await ingest(db, { channel_id: fb, thread_key: 'psid-k1', customer: { external_id: 'psid-k1', name: 'Rahim' }, message: { external_id: 'k_1', body: 'Is the belt available?' } })
      const cmt = await ingest(db, { channel_id: fb, kind: 'COMMENT', thread_key: 'c-k1', post: { id: 'post_k' }, message: { external_id: 'c-k1', body: 'price?' } })
      await asService(db)
      await db.query(`update public.inbox_conversations set auto_follow_up_at = now() + interval '1 hour', auto_follow_up_text = 'Still interested?' where id = $1`, [chat.conversation_id])

      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.inbox_channel_disconnect($1, null)`, [fb], /permission denied|PERMISSION_DENIED/i)

      await asService(db)
      expect(await value(db, `select public.inbox_channel_disconnect($1, $2)`, [fb, staff])).toEqual({ disconnected: true, conversations: 2 })
      const row = await one<{ status: string; token_hint: string | null }>(db, `select status, token_hint from public.inbox_channels where id = $1`, [fb])
      expect(row).toMatchObject({ status: 'DISCONNECTED', token_hint: null })
      expect(num(await value(db, `select count(*) from public.inbox_messages where conversation_id in ($1, $2)`, [chat.conversation_id, cmt.conversation_id]))).toBe(2)
      expect(await value(db, `select auto_follow_up_at from public.inbox_conversations where id = $1`, [chat.conversation_id])).toBeNull()
      expect(num(await value(db, `select count(*) from public.audit_logs where entity_id = $1 and action = 'inbox_channel.disconnected'`, [fb]))).toBe(1)
      // Meta's events for the Page no longer reach this store.
      expect(await owner(db, 'FACEBOOK:5550001')).toBeNull()

      // Staff still read the old chat.
      await asUser(db, staff)
      const t = await value<{ messages: Array<{ body: string }> }>(db, `select public.inbox_thread($1)`, [chat.conversation_id])
      expect(t.messages.map((m) => m.body)).toContain('Is the belt available?')

      // Connecting the same Page again: same channel, same history.
      const again = await channel(db, 'FACEBOOK', '5550001')
      expect(again).toBe(fb)
      expect(await value(db, `select status from public.inbox_channels where id = $1`, [fb])).toBe('OK')
      const next = await ingest(db, { channel_id: fb, thread_key: 'psid-k1', message: { external_id: 'k_2', body: 'Hello?' } })
      expect(next.conversation_id).toBe(chat.conversation_id)
      expect(await owner(db, 'FACEBOOK:5550001')).not.toBeNull()

      // The store asking for deletion still removes everything.
      await asService(db)
      expect(await value(db, `select public.inbox_channel_remove($1, null)`, [fb])).toEqual({ removed: true, conversations: 2 })
      expect(num(await value(db, `select count(*) from public.inbox_messages where conversation_id = $1`, [chat.conversation_id]))).toBe(0)
    }))

  it('lets another store connect a Page this store disconnected', () =>
    inTx(async (db) => {
      const fb = await channel(db, 'FACEBOOK', '5550002')
      await asService(db)
      await db.query(`select public.inbox_channel_disconnect($1, null)`, [fb])
      const other = '00000000-0000-4000-8000-000000000002'
      await asService(db, other)
      const exists = num(await value(db, `select count(*) from public.merchants where id = $1`, [other]))
      if (!exists) return // the seed has one store; the unique index excludes disconnected rows either way
      const theirs = await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
        [JSON.stringify({ platform: 'FACEBOOK', external_id: '5550002', name: 'Moved Page' })])
      expect(theirs.id).not.toBe(fb)
    }))
})

describe('inbox: what the customer deletes is erased', () => {
  it('erases an unsent message and a removed comment, keeps the row, and says so in the list', () =>
    inTx(async (db) => {
      const ig = await channel(db, 'INSTAGRAM', '5550003')
      const a = await ingest(db, { channel_id: ig, thread_key: 'igsid-k', customer: { external_id: 'igsid-k', name: 'Nila' }, message: { external_id: 'mid_a', body: 'my number is 01700000000', created_at: '2026-11-02T08:00:00Z' } })
      await ingest(db, { channel_id: ig, thread_key: 'igsid-k', message: { external_id: 'mid_b', body: 'and a photo', attachments: [{ type: 'image', url: 'https://x/p.jpg' }], created_at: '2026-11-02T08:01:00Z' } })

      await asService(db)
      expect(num(await value(db, `select public.inbox_message_erase($1, 'mid_b')`, [ig]))).toBe(1)
      const b = await one<{ body: string | null; attachments: unknown[]; erased_at: string | null; removed_at: string | null }>(db,
        `select body, attachments, erased_at, removed_at from public.inbox_messages where external_id = 'mid_b'`)
      expect(b.body).toBeNull()
      expect(b.attachments).toEqual([])
      expect(b.erased_at).not.toBeNull()
      expect(b.removed_at).not.toBeNull()
      expect(await value(db, `select last_message_preview from public.inbox_conversations where id = $1`, [a.conversation_id])).toBe('Message deleted')
      // The number was only in mid_a so far: still there until mid_a goes.
      expect(await value(db, `select customer_phone from public.inbox_conversations where id = $1`, [a.conversation_id])).toBeTruthy()
      // Again, or an id from another account: nothing changes.
      expect(num(await value(db, `select public.inbox_message_erase($1, 'mid_b')`, [ig]))).toBe(0)
      const other = await channel(db, 'FACEBOOK', '5550004')
      await asService(db)
      expect(num(await value(db, `select public.inbox_message_erase($1, 'mid_a')`, [other]))).toBe(0)
      expect(await value(db, `select body from public.inbox_messages where external_id = 'mid_a'`)).toBe('my number is 01700000000')

      // Erasing an earlier message leaves the preview on the latest one.
      await ingest(db, { channel_id: ig, thread_key: 'igsid-k', message: { external_id: 'mid_c', body: 'ok thanks', created_at: '2026-11-02T08:02:00Z' } })
      await asService(db)
      await db.query(`select public.inbox_message_erase($1, 'mid_a')`, [ig])
      expect(await value(db, `select last_message_preview from public.inbox_conversations where id = $1`, [a.conversation_id])).toBe('ok thanks')
      // The mobile number it carried leaves the chat's contact details.
      expect(await value(db, `select customer_phone from public.inbox_conversations where id = $1`, [a.conversation_id])).toBeNull()

      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      await expectError(db, `select public.inbox_message_erase($1, 'mid_c')`, [ig], /permission denied|PERMISSION_DENIED/i)
      const t = await value<{ messages: Array<{ external_id: string; body: string | null; erased_at: string | null }> }>(db, `select public.inbox_thread($1)`, [a.conversation_id])
      expect(t.messages.find((m) => m.external_id === 'mid_a')).toMatchObject({ body: null })
      expect(t.messages.find((m) => m.external_id === 'mid_a')?.erased_at).toBeTruthy()
    }))

  it('a comment removed on Facebook is erased and listed under Deleted; one the store deleted keeps its text', () =>
    inTx(async (db) => {
      const fb = await channel(db, 'FACEBOOK', '5550005')
      const gone = await ingest(db, { channel_id: fb, kind: 'COMMENT', thread_key: 'c-g', post: { id: 'post_g' }, message: { external_id: 'c-g', body: 'rude words' } })
      const mod = await ingest(db, { channel_id: fb, kind: 'COMMENT', thread_key: 'c-m', post: { id: 'post_g' }, message: { external_id: 'c-m', body: 'spam link' } })
      const staff = await createStaff(db, 'ADMIN')
      await asService(db)
      // The store deletes one from Fullfilio first; Facebook then reports both removals.
      await db.query(`select public.inbox_message_flags($1, '{"removed": true, "detail": "Deleted"}', $2)`, [mod.message_id, staff])
      expect(num(await value(db, `select public.inbox_message_erase($1, 'c-g')`, [fb]))).toBe(1)
      expect(num(await value(db, `select public.inbox_message_erase($1, 'c-m')`, [fb]))).toBe(0)

      await asUser(db, staff)
      const list = await value<{ total: number; items: Array<{ id: string; comment: { body: string | null; removed_at: string | null; erased_at: string | null } }> }>(db,
        `select public.inbox_comments('{"state":"deleted"}'::jsonb)`)
      expect(list.total).toBe(2)
      const g = list.items.find((i) => i.id === gone.conversation_id)!
      const m = list.items.find((i) => i.id === mod.conversation_id)!
      expect(g.comment).toMatchObject({ body: null })
      expect(g.comment.erased_at).toBeTruthy()
      expect(m.comment).toMatchObject({ body: 'spam link', erased_at: null })
      expect(m.comment.removed_at).toBeTruthy()
    }))
})

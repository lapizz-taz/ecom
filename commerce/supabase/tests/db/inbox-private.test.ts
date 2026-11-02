import { afterAll, describe, expect, it } from 'vitest'
import { asService, asUser, closePool, type Db, inTx, one, value } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

async function channel(db: Db, platform = 'INSTAGRAM', externalId = '5550006'): Promise<string> {
  await asService(db)
  return (await one<{ id: string }>(db, `select * from public.inbox_channel_save($1::jsonb, null)`,
    [JSON.stringify({ platform, external_id: externalId, name: 'Isolation Page' })])).id
}
const ingest = async (db: Db, p: Record<string, unknown>) => {
  await asService(db)
  return value<{ conversation_id: string; message_id: string }>(db, `select public.inbox_ingest($1::jsonb)`, [JSON.stringify(p)])
}

describe('inbox: one private message per comment', () => {
  it('says when the private message Meta allows was already sent (a failed one does not count)', () =>
    inTx(async (db) => {
      const ig = await channel(db)
      const c = await ingest(db, { channel_id: ig, kind: 'COMMENT', thread_key: 'c-p', post: { id: 'post_p' }, message: { external_id: 'c-p', body: 'price?' } })
      const staff = await createStaff(db, 'ADMIN')
      const sent = async () => {
        await asUser(db, staff)
        const l = await value<{ items: Array<{ id: string; private_sent: boolean }> }>(db, `select public.inbox_comments('{}'::jsonb)`)
        return l.items.find((i) => i.id === c.conversation_id)!.private_sent
      }
      expect(await sent()).toBe(false)
      await asService(db)
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: c.conversation_id, body: 'try', private_reply: true, error: 'Meta: failed' }), staff])
      expect(await sent()).toBe(false)
      await asService(db)
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: c.conversation_id, body: 'public answer' }), staff])
      expect(await sent()).toBe(false)
      await asService(db)
      await db.query(`select public.inbox_record_outgoing($1::jsonb, $2)`, [JSON.stringify({ conversation_id: c.conversation_id, external_id: 'pm1', body: 'Check your inbox', private_reply: true }), staff])
      expect(await sent()).toBe(true)
    }))
})

import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const msg = (over: Record<string, unknown> = {}) => JSON.stringify({ name: 'Rafi Ahmed', email: 'rafi@shop.example', message: 'We ship 300 parcels a month. Can we try it?', topic: 'sales', ...over })

describe('website contact form', () => {
  it('anyone can send a message; it needs a way to reply and enough text', () =>
    inTx(async (db) => {
      await asAnon(db, null)
      const r = await value<Record<string, any>>(db, `select public.platform_contact_submit($1)`, [msg()])
      expect(r.id).toBeGreaterThan(0)
      await expectError(db, `select public.platform_contact_submit($1)`, [msg({ email: '', phone: '' })], /e-mail address or a phone number/)
      await expectError(db, `select public.platform_contact_submit($1)`, [msg({ message: 'hi' })], /a little more/)
      await expectError(db, `select public.platform_contact_submit($1)`, [msg({ email: 'not-an-email' })], /does not look right/)
      // Visitors cannot read messages directly: they see none.
      expect(await value(db, `select count(*)::int from public.platform_contact_messages`)).toBe(0)
    }))

  it('limits how many messages one address can send', () =>
    inTx(async (db) => {
      await asAnon(db, null)
      for (let i = 0; i < 3; i++) await db.query(`select public.platform_contact_submit($1)`, [msg({ email: 'busy@shop.example' })])
      await expectError(db, `select public.platform_contact_submit($1)`, [msg({ email: 'busy@shop.example' })], /RATE_LIMITED/)
      await db.query(`select public.platform_contact_submit($1)`, [msg({ email: 'other@shop.example' })])
    }))

  it('only Super Admin staff with the support module read and handle messages', () =>
    inTx(async (db) => {
      await asAnon(db, null)
      const { id } = await value<Record<string, any>>(db, `select public.platform_contact_submit($1)`, [msg({ phone: '01712345678', email: '' })])
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.platform_contact_messages_list()`, [], /PERMISSION_DENIED|permission/i)

      const boss = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, boss, 'boss@platform.example', null)
      const list = await value<Record<string, any>>(db, `select public.platform_contact_messages_list('NEW')`)
      expect(list.items.some((m: any) => m.id === id && m.phone === '01712345678')).toBe(true)
      expect(await value(db, `select public.platform_contact_message_update($1, 'REPLIED', 'Called back') ->> 'status'`, [id])).toBe('REPLIED')
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'contact.update'`)).toBeGreaterThan(0)
    }))
})

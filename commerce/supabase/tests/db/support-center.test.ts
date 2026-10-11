import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

// Platform staff sign in to the panel; their browser sends no merchant.
const asPlatform = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
const asMerchantStaff = (db: Db, id: string) => asUser(db, id, 'staff@shop.example', MERCHANT_1)

type TicketJson = { id: string; number: number; status: string; priority: string; due_at: string; overdue: boolean; escalation_level: number
  assigned: { user_id: string } | null; first_response_at: string | null; last_reply_from: string | null }

async function merchantTicket(db: Db, reporter: string, priority = 'NORMAL'): Promise<{ id: string; number: number; created_at: string; due_at: string }> {
  await asMerchantStaff(db, reporter)
  return value(db, `select to_jsonb(public.support_ticket_create($1))`, [JSON.stringify({
    kind: 'BUG', category: 'ORDERS', subject: 'Orders page is blank', body: 'Nothing loads on the orders page since this morning', priority })])
}

const unread = (db: Db, user: string) =>
  value<number>(db, `select count(*)::int from public.platform_notifications where user_id = $1 and read_at is null`, [user])

describe('support: tickets for the platform team', () => {
  it('times tickets by priority, routes replies both ways and keeps notes internal', () =>
    inTx(async (db) => {
      const agent = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const reporter = await createStaff(db, 'ORDER_MANAGER')
      const owner = await createStaff(db, 'OWNER')

      const t = await merchantTicket(db, reporter, 'URGENT')
      // 4 hours to resolve an urgent ticket (the default policy).
      expect(new Date(t.due_at).getTime() - new Date(t.created_at).getTime()).toBe(4 * 3600_000)
      await asSystem(db, null)
      // Urgent: everyone who works on support tickets is told; billing staff are not.
      expect(await unread(db, agent)).toBe(1)
      expect(await unread(db, tech)).toBe(1)
      expect(await unread(db, billing)).toBe(0)

      await asPlatform(db, agent)
      const list = await value<{ total: number; rows: TicketJson[]; summary: Record<string, number> }>(db,
        `select public.platform_tickets_list('{"view":"unassigned"}')`)
      expect(list.rows.map((r) => r.id)).toContain(t.id)
      expect(list.summary.unassigned).toBeGreaterThanOrEqual(1)

      // Technical support may take a ticket, but not hand it to someone else.
      await asPlatform(db, tech)
      await expectError(db, `select public.platform_ticket_update($1, $2)`, [t.id, JSON.stringify({ assigned_to: agent })], /PERMISSION_DENIED/)
      const taken = await value<TicketJson>(db, `select public.platform_ticket_update($1, $2)`, [t.id, JSON.stringify({ assigned_to: tech })])
      expect(taken.assigned?.user_id).toBe(tech)
      // Billing staff cannot be given support tickets.
      await asPlatform(db, agent)
      await expectError(db, `select public.platform_ticket_update($1, $2)`, [t.id, JSON.stringify({ assigned_to: billing })], /cannot work on/)
      const given = await value<TicketJson>(db, `select public.platform_ticket_update($1, $2)`, [t.id, JSON.stringify({ assigned_to: agent })])
      expect(given.assigned?.user_id).toBe(agent)

      const replied = await value<TicketJson>(db, `select public.platform_ticket_reply($1, 'Thanks — we are looking at it now.')`, [t.id])
      expect(replied.status).toBe('IN_PROGRESS')
      expect(replied.first_response_at).not.toBeNull()
      expect(replied.last_reply_from).toBe('PLATFORM')
      await db.query(`select public.platform_ticket_note($1, 'Probably the Shopify import job; checking logs')`, [t.id])

      // The merchant sees the reply under the team's name, never the note.
      await asMerchantStaff(db, reporter)
      const msgs = (await db.query(`select body, author_id, author_label, is_support from public.support_ticket_messages where ticket_id = $1`, [t.id])).rows
      expect(msgs).toHaveLength(1)
      expect(msgs[0]).toMatchObject({ author_id: null, is_support: true })
      expect(msgs[0].author_label).toMatch(/· Support$/)
      await expectError(db, `select count(*) from public.support_ticket_events`, [], /permission denied/)

      // The merchant answering alerts the assignee only.
      await asSystem(db, null)
      await db.query(`update public.platform_notifications set read_at = now()`)
      await asMerchantStaff(db, reporter)
      await db.query(`select public.support_ticket_reply($1, 'It is still blank after a refresh')`, [t.id])
      await asSystem(db, null)
      expect(await unread(db, agent)).toBe(1)
      expect(await unread(db, tech)).toBe(0)
      expect(await value(db, `select last_reply_from from public.support_tickets where id = $1`, [t.id])).toBe('MERCHANT')

      // Escalation raises the priority one step and alerts managers.
      await asPlatform(db, agent)
      await expectError(db, `select public.platform_ticket_escalate($1, 'no')`, [t.id], /why/)
      const normal = await merchantTicket(db, reporter, 'NORMAL')
      await asPlatform(db, agent)
      const esc = await value<TicketJson>(db, `select public.platform_ticket_escalate($1, 'Merchant cannot take orders')`, [normal.id])
      expect(esc).toMatchObject({ escalation_level: 1, priority: 'HIGH' })
      // Due time follows the new priority (8 hours from opening).
      expect(new Date(esc.due_at).getTime() - new Date(normal.created_at).getTime()).toBe(8 * 3600_000)

      const resolved = await value<TicketJson>(db, `select public.platform_ticket_update($1, '{"status":"RESOLVED","reason":"Import job fixed"}')`, [t.id])
      expect(resolved.status).toBe('RESOLVED')

      const t1 = await value<{ events: Array<{ kind: string }>; messages: Array<{ from: string }>; assignable: Array<{ user_id: string }> }>(db,
        `select public.platform_ticket_get($1)`, [t.id])
      expect(t1.events.map((e) => e.kind)).toEqual(['CREATED', 'ASSIGNED', 'ASSIGNED', 'REPLY', 'NOTE', 'MERCHANT_REPLY', 'STATUS'])
      expect(t1.messages.map((m) => m.from)).toEqual(['PLATFORM', 'MERCHANT'])
      expect(t1.assignable.map((a) => a.user_id)).toEqual(expect.arrayContaining([agent, tech]))
      expect(t1.assignable.map((a) => a.user_id)).not.toContain(billing)

      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where entity_id = $1 and action = 'support.ticket_updated'`, [t.id])).toBe(3)
      await expectError(db, `delete from public.support_ticket_events where ticket_id = $1`, [t.id], /IMMUTABLE_RECORD/)

      // Internal tickets: the platform team's own, invisible to the merchant.
      await asPlatform(db, agent)
      const internal = await value<TicketJson>(db, `select public.platform_ticket_create($1)`, [JSON.stringify({
        merchant: MERCHANT_1, subject: 'Webhook failures after DNS change', body: 'Investigate repeated Shopify webhook 401s', internal: true })])
      await expectError(db, `select public.platform_ticket_reply($1, 'hello')`, [internal.id], /internal ticket/)
      const visible = await value<TicketJson>(db, `select public.platform_ticket_create($1)`, [JSON.stringify({
        merchant: MERCHANT_1, subject: 'Courier account needs re-connecting', body: 'Pathao token expired; please reconnect', priority: 'HIGH' })])
      await asMerchantStaff(db, owner)
      const ids = (await db.query(`select id from public.support_tickets`)).rows.map((r) => r.id)
      expect(ids).toContain(visible.id)
      expect(ids).not.toContain(internal.id)
      await expectError(db, `select public.support_ticket_reply($1, 'hi')`, [internal.id], /NOT_FOUND/)
    }))

  it('keeps staff to the merchants assigned to them', () =>
    inTx(async (db) => {
      const reporter = await createStaff(db, 'ORDER_MANAGER')
      const t = await merchantTicket(db, reporter)
      await asSystem(db, null)
      const other = await value<string>(db, `insert into public.merchants (name, status) values ('Other shop', 'ACTIVE') returning id`)
      const limited = await createPlatformStaff(db, 'SUPPORT_AGENT', { scope: 'ASSIGNED', merchants: [other] })
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await asPlatform(db, limited)
      await expectError(db, `select public.platform_ticket_get($1)`, [t.id], /NOT_FOUND/)
      await expectError(db, `select public.platform_ticket_reply($1, 'hello')`, [t.id], /NOT_FOUND/)
      const list = await value<{ rows: Array<{ id: string }> }>(db, `select public.platform_tickets_list('{"view":"all"}')`)
      expect(list.rows.map((r) => r.id)).not.toContain(t.id)
      await expectError(db, `select public.platform_support_session_start($1, 'Checking the orders screen for them', 30)`, [MERCHANT_1], /PERMISSION_DENIED|NOT_FOUND/)
      // Viewers read tickets but change nothing.
      await asPlatform(db, viewer)
      expect((await value<{ id: string }>(db, `select public.platform_ticket_get($1)`, [t.id])).id).toBe(t.id)
      await expectError(db, `select public.platform_ticket_note($1, 'a note')`, [t.id], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_ticket_create($1)`, [JSON.stringify({ merchant: MERCHANT_1, subject: 'x x x', body: 'y y y y y' })], /PERMISSION_DENIED/)
      // Merchant staff cannot use any of it.
      await asMerchantStaff(db, reporter)
      await expectError(db, `select public.platform_tickets_list()`, [], /PERMISSION_DENIED|permission denied/)
    }))

  it('validates the support settings and versions them', () =>
    inTx(async (db) => {
      const agent = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      await asPlatform(db, tech)
      await expectError(db, `select public.platform_support_settings_save('{"team_name":"Help"}')`, [], /PERMISSION_DENIED/)
      await asPlatform(db, agent)
      await expectError(db, `select public.platform_support_settings_save('{"response_hours":{"URGENT":10,"HIGH":2,"NORMAL":8,"LOW":24}}')`, [], /first reply/)
      await expectError(db, `select public.platform_support_settings_save('{"session_max_minutes":600}')`, [], /5 minutes to 4 hours/)
      const saved = await value<{ team_name: string; sla_hours: Record<string, number> }>(db,
        `select public.platform_setting_save('support', '{"team_name":"Fullfilio Care","sla_hours":{"URGENT":2,"HIGH":8,"NORMAL":24,"LOW":72}}', 'Faster urgent replies')`)
      expect(saved.team_name).toBe('Fullfilio Care')
      expect(saved.sla_hours.URGENT).toBe(2)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.config_versions where ref = 'support'`)).toBeGreaterThanOrEqual(1)
    }))
})

describe('support: customer-view sessions', () => {
  it('shows the merchant read-only, for a limited time, logged and visible to the merchant', () =>
    inTx(async (db) => {
      const agent = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const owner = await createStaff(db, 'OWNER')
      const reporter = await createStaff(db, 'ORDER_MANAGER')
      const t = await merchantTicket(db, reporter)
      await asSystem(db)
      const orders = await value<number>(db, `select count(*)::int from public.orders where merchant_id = $1`, [MERCHANT_1])

      await asPlatform(db, viewer)
      await expectError(db, `select public.platform_support_session_start($1, 'Looking at the orders screen', 30)`, [MERCHANT_1], /PERMISSION_DENIED/)
      await asPlatform(db, agent)
      expect(await value(db, `select public.get_my_access()`)).toBeNull()
      await expectError(db, `select public.platform_support_session_start($1, 'look', 30)`, [MERCHANT_1], /say why/)
      await expectError(db, `select public.platform_support_session_start($1, 'Looking at the orders screen', 500)`, [MERCHANT_1], /5 to 120 minutes/)
      const s = await value<{ id: string; status: string; expires_at: string; started_at: string }>(db,
        `select public.platform_support_session_start($1, 'Looking at the orders screen', 30, $2)`, [MERCHANT_1, t.id])
      expect(s.status).toBe('ACTIVE')
      expect(new Date(s.expires_at).getTime() - new Date(s.started_at).getTime()).toBe(30 * 60_000)

      // The panel employee now sees the merchant as a read-only viewer.
      const access = await value<{ role: string; merchant_id: string; permissions: string[]; support_session: { id: string } }>(db, `select public.get_my_access()`)
      expect(access).toMatchObject({ role: 'SUPPORT_VIEW', merchant_id: MERCHANT_1 })
      expect(access.support_session.id).toBe(s.id)
      expect(access.permissions.length).toBeGreaterThan(5)
      expect(access.permissions.every((p) => p.endsWith('.view'))).toBe(true)
      expect(await value(db, `select count(*)::int from public.orders`)).toBe(orders)
      await expectError(db, `select public.admin_update_setting('store', '{"name":"Hacked"}')`, [], /PERMISSION_DENIED|permission/)
      // Tables staff may edit directly are frozen too.
      await expectError(db, `insert into public.categories (name, slug) values ('Support test', 'support-test')`, [], /row-level security/)
      expect((await db.query(`update public.categories set name = name || ' x'`)).rowCount).toBe(0)
      const me = await value<{ support_session: { id: string } | null }>(db, `select public.platform_me()`)
      expect(me.support_session?.id).toBe(s.id)

      // Ending it ends the access at once.
      const ended = await value<{ status: string; minutes: number }>(db, `select public.platform_support_session_end()`)
      expect(ended.status).toBe('ENDED')
      expect(await value(db, `select public.get_my_access()`)).toBeNull()

      // A session that ran out stops working, and is recorded as expired.
      const s2 = await value<{ id: string }>(db, `select public.platform_support_session_start($1, 'Checking a courier booking', 15)`, [MERCHANT_1])
      await asSystem(db, null)
      await db.query(`update public.support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '105 minutes' where id = $1`, [s2.id])
      await asPlatform(db, agent)
      expect(await value(db, `select public.get_my_access()`)).toBeNull()
      const list = await value<{ mine: unknown; rows: Array<{ id: string; status: string; minutes: number }> }>(db,
        `select public.platform_support_sessions($1)`, [JSON.stringify({ merchant: MERCHANT_1 })])
      expect(list.mine).toBeNull()
      expect(list.rows.find((r) => r.id === s2.id)).toMatchObject({ status: 'EXPIRED', minutes: 15 })

      // One open session per person: a new one replaces the old.
      const a = await value<{ id: string }>(db, `select public.platform_support_session_start($1, 'First look at the products page', 20)`, [MERCHANT_1])
      const b = await value<{ id: string }>(db, `select public.platform_support_session_start($1, 'Second look at the products page', 20)`, [MERCHANT_1])
      await asSystem(db, null)
      expect(await value(db, `select end_reason from public.support_sessions where id = $1`, [a.id])).toBe('Replaced by a new session')
      expect(await value(db, `select ended_at is null from public.support_sessions where id = $1`, [b.id])).toBe(true)

      const actions = (await db.query(`select action from public.platform_audit_logs where entity_type = 'support_session' and actor_id = $1 order by id`, [agent])).rows.map((r) => r.action)
      expect(actions).toEqual(['support.session_started', 'support.session_ended', 'support.session_started', 'support.session_expired',
        'support.session_started', 'support.session_ended', 'support.session_started'])
      expect(await value(db, `select count(*)::int from public.support_ticket_events where ticket_id = $1 and kind = 'SESSION'`, [t.id])).toBe(1)

      // The merchant sees who looked, when and why.
      await asMerchantStaff(db, owner)
      const log = await value<Array<{ reason: string; staff: string; active: boolean }>>(db, `select public.support_access_log()`)
      expect(log).toHaveLength(4)
      expect(log.map((l) => l.reason)).toContain('Looking at the orders screen')
      expect(log.filter((l) => l.active)).toHaveLength(1)
      // First name only.
      expect(log.every((l) => l.staff === 'Platform')).toBe(true)
    }))
})

describe('platform notifications', () => {
  it('belong to one person, can be marked read, and are never duplicated', () =>
    inTx(async (db) => {
      const a = await createPlatformStaff(db, 'SUPER_ADMIN')
      const b = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asSystem(db, null)
      const key = randomUUID()
      expect(await value(db, `select public._platform_notify('health', 'view', null, 'health.test', 'WARN', 'Queue backlog', null, '/super-admin/health', $1, $2)`,
        [key, [a]])).toBe(1)
      expect(await value(db, `select public._platform_notify('health', 'view', null, 'health.test', 'WARN', 'Queue backlog', null, '/super-admin/health', $1, $2)`,
        [key, [a]])).toBe(0)
      await asPlatform(db, a)
      const mine = await value<{ unread: number; items: Array<{ id: number; title: string }> }>(db, `select public.platform_notifications_list()`)
      expect(mine.unread).toBeGreaterThanOrEqual(1)
      expect(mine.items.some((i) => i.title === 'Queue backlog')).toBe(true)
      await asPlatform(db, b)
      const theirs = await value<{ items: Array<{ title: string }> }>(db, `select public.platform_notifications_list()`)
      expect(theirs.items.some((i) => i.title === 'Queue backlog')).toBe(false)
      await asPlatform(db, a)
      expect(await value(db, `select public.platform_notifications_read(null)`)).toBeGreaterThanOrEqual(1)
      expect((await value<{ unread: number }>(db, `select public.platform_notifications_list()`)).unread).toBe(0)
      expect(((await value<{ unread_notifications: number }>(db, `select public.platform_me()`)).unread_notifications)).toBe(0)
    }))
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

/** Signed in as a user with a given sign-in session (the session_id claim in the access token). */
async function asSession(db: Db, userId: string, sessionId: string) {
  await db.query('set local role authenticated')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated', session_id: sessionId }),
  ])
}
const token = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')

describe('device approvals', () => {
  it('blocks staff on unapproved devices once switched on — in permissions, RLS and get_my_access — but never the owner', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const admin = await createStaff(db, 'ADMIN')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      const [sOwner, sAdmin, sA, sB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
      const [tAdmin, tA, tB] = [token(), token(), token()]

      // Off: devices are only recorded. The first device is approved automatically.
      await asSession(db, admin, sAdmin)
      expect(await value<Record<string, any>>(db, `select public.device_register($1, 'Admin laptop')`, [tAdmin])).toMatchObject({ status: 'APPROVED', required: false })
      await asSession(db, agent, sA)
      expect(await value<Record<string, any>>(db, `select public.device_register($1, 'Chrome on Windows')`, [tA])).toMatchObject({ status: 'APPROVED' })
      await asSession(db, agent, sB)
      const b = await value<Record<string, any>>(db, `select public.device_register($1, 'Phone')`, [tB])
      expect(b.status).toBe('PENDING')
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(true) // not enforced yet

      // An admin can't switch it on from a device that isn't approved.
      await asSession(db, admin, randomUUID())
      await expectError(db, `select public.device_settings_save('{"enabled":true}')`, [], /lock yourself out/)
      await asSession(db, admin, sAdmin)
      await db.query(`select public.device_settings_save('{"enabled":true}')`)

      // Session B (pending device): no permissions, no rows, a clear flag for the app.
      await asSession(db, agent, sB)
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(false)
      expect(await value<boolean>(db, `select public.is_staff()`)).toBe(false)
      const blocked = await value<Record<string, any>>(db, `select public.get_my_access()`)
      expect(blocked).toMatchObject({ device_blocked: true, permissions: [], device: { required: true, status: 'PENDING' } })
      expect(await value<number>(db, `select count(*)::int from public.order_sources`)).toBe(0)
      // A brand-new session without registering is blocked too.
      await asSession(db, agent, randomUUID())
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(false)

      // Session A (approved device) works; a new sign-in on the same browser links to it.
      await asSession(db, agent, sA)
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(true)
      const again = randomUUID()
      await asSession(db, agent, again)
      expect(await value<Record<string, any>>(db, `select public.device_register($1)`, [tA])).toMatchObject({ status: 'APPROVED' })
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(true)

      // The owner is never locked out, even with no device at all.
      await asSession(db, owner, sOwner)
      expect(await value<Record<string, any>>(db, `select public.get_my_access()`)).toMatchObject({ device_blocked: false, role: 'OWNER' })
      // Owner devices never wait in the queue, even after the first one.
      await db.query(`select public.device_register($1)`, [token()])
      expect(await value<Record<string, any>>(db, `select public.device_register($1)`, [token()])).toMatchObject({ status: 'APPROVED' })

      // Admin approves B, revokes A; the agent can't manage devices.
      await asSession(db, agent, sA)
      await expectError(db, `select public.device_list()`, [], /devices.manage/)
      await asSession(db, admin, sAdmin)
      const list = await value<Record<string, any>>(db, `select public.device_list()`)
      expect(list.devices.find((d: any) => d.id === b.id)).toMatchObject({ status: 'PENDING', label: 'Phone', name: expect.any(String) })
      expect(list.devices.every((d: any) => !('token_hash' in d))).toBe(true)
      await db.query(`select public.device_decide($1, 'approve')`, [b.id])
      const aId = list.devices.find((d: any) => d.profile_id === agent && d.label === 'Chrome on Windows').id
      await db.query(`select public.device_decide($1, 'revoke', 'Lost laptop')`, [aId])
      const own = list.devices.find((d: any) => d.is_current).id
      await expectError(db, `select public.device_decide($1, 'revoke')`, [own], /device you are using/)

      await asSession(db, agent, sB)
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(true)
      await asSession(db, agent, sA)
      expect(await value<boolean>(db, `select public.has_permission('orders.view')`)).toBe(false)

      // Device approval has its own screen: the generic setter refuses it.
      await asSession(db, owner, sOwner)
      await expectError(db, `select public.admin_update_setting('device_approval', '{"enabled":false}')`, [], /own screen/)
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.audit_logs where action in ('device.approved', 'device.revoked')`)).toBeGreaterThanOrEqual(2)
    }))
})

describe('order sources', () => {
  it('admins add sources staff can pick; inactive ones are refused; stats split manual, tracked and unattributed', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const viewer = await createStaff(db, 'VIEWER')
      const p = await createProduct(db, { price: 400, stock: 10 })
      const o1 = await createOrder(db, { phone: '01711000101', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const o2 = await createOrder(db, { phone: '01711000102', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, viewer)
      await expectError(db, `select public.order_source_save('{"label":"TikTok Live"}')`, [], /settings.manage/)
      await asUser(db, owner)
      const s = await value<Record<string, any>>(db, `select to_jsonb(public.order_source_save('{"label":"TikTok Live","channel":"organic_social"}'))`)
      expect(s).toMatchObject({ code: 'TIKTOK_LIVE', label: 'TikTok Live', is_active: true })
      await expectError(db, `select public.order_source_save('{"label":"TikTok live"}')`, [], /already exists/)
      const a = await value<Record<string, any>>(db, `select to_jsonb(public.admin_set_order_source($1, 'TIKTOK_LIVE'))`, [o1.id])
      expect(a).toMatchObject({ source: 'TikTok Live', channel: 'organic_social', recorded_by: 'STAFF' })
      await db.query(`select public.order_source_save('{"code":"TIKTOK_LIVE","is_active":false}')`)
      await expectError(db, `select public.admin_set_order_source($1, 'TIKTOK_LIVE')`, [o2.id], /choose where/)
      await db.query(`select public.admin_set_order_source($1, 'PHONE')`, [o2.id]) // seeded sources still work

      const stats = await value<any[]>(db, `select public.order_source_stats(30)`)
      expect(stats.find((r) => r.label === 'TikTok Live')).toMatchObject({ kind: 'manual', orders: 1 })
      expect(stats.find((r) => r.label === 'Phone call')).toMatchObject({ kind: 'manual', orders: 1 })
    }))
})

describe('support tickets', () => {
  it('staff see only their own; support answers; the reporter reopens by replying and cannot set priority', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      const other = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      await expectError(db, `select public.support_ticket_create('{"kind":"FEEDBACK","subject":"Hi","body":"x"}')`, [], /short title/)
      const t = await value<Record<string, any>>(db, `select to_jsonb(public.support_ticket_create($1))`, [JSON.stringify({
        kind: 'FEEDBACK', category: 'FEATURE', subject: 'Bulk SMS from orders', body: 'Let us send SMS to selected orders', rating: 4 })])
      expect(t).toMatchObject({ kind: 'FEEDBACK', status: 'OPEN', rating: 4, category: 'FEATURE' })
      await expectError(db, `select public.support_ticket_update($1, '{"priority":"HIGH"}')`, [t.id], /support.manage/)

      await asUser(db, other)
      expect(await value<number>(db, `select count(*)::int from public.support_tickets where id = $1`, [t.id])).toBe(0)
      await expectError(db, `select public.support_ticket_reply($1, 'me too')`, [t.id], /not found/)

      await asUser(db, admin)
      await db.query(`select public.support_ticket_reply($1, 'Planned for next month')`, [t.id])
      const resolved = await value<Record<string, any>>(db, `select to_jsonb(public.support_ticket_update($1, '{"status":"RESOLVED","priority":"HIGH"}'))`, [t.id])
      expect(resolved).toMatchObject({ status: 'RESOLVED', priority: 'HIGH' })
      expect(resolved.resolved_at).not.toBeNull()

      await asUser(db, agent)
      const msgs = await value<any[]>(db, `select jsonb_agg(to_jsonb(m) order by created_at) from public.support_ticket_messages m where ticket_id = $1`, [t.id])
      expect(msgs[0]).toMatchObject({ is_support: true, body: 'Planned for next month' })
      await db.query(`select public.support_ticket_reply($1, 'Still need it for COD orders')`, [t.id])
      expect(await value<Record<string, any>>(db, `select to_jsonb(t) from public.support_tickets t where id = $1`, [t.id])).toMatchObject({ status: 'OPEN', replies: 2, resolved_at: null })
      await db.query(`select public.support_ticket_update($1, '{"status":"CLOSED"}')`, [t.id])
    }))
})

describe('PBX call log and status pages', () => {
  it('records each call once (repeat events update it), links the customer and the agent by extension', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      const p = await createProduct(db, { price: 300, stock: 5 })
      const o = await createOrder(db, { phone: '01722000303', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, owner)
      await expectError(db, `select public.pbx_settings_save('{"api_url_template":"http://pbx.local/call"}')`, [], /https/)
      await expectError(db, `select public.pbx_settings_save($1)`, [JSON.stringify({ extensions: [{ profile_id: agent, extension: '101' }, { profile_id: owner, extension: '101' }] })], /one staff member/)
      await db.query(`select public.pbx_settings_save($1)`, [JSON.stringify({ enabled: true, extensions: [{ profile_id: agent, extension: '101' }],
        click_mode: 'api', api_url_template: 'https://pbx.example.com/originate?ext={extension}&to={number}&key={secret}' })])
      await expectError(db, `select public.pbx_record_call('{"call_id":"x"}')`, [], /permission denied|PERMISSION_DENIED/i)

      await asSystem(db)
      const ring = { call_id: 'abc-1', direction: 'INBOUND', from: '+8801722000303', to: '09610000000', extension: '101', status: 'RINGING', started_at: new Date().toISOString() }
      await db.query(`select public.pbx_record_call($1)`, [JSON.stringify(ring)])
      await db.query(`select public.pbx_record_call($1)`, [JSON.stringify({ ...ring, status: 'ANSWERED', duration: 95 })])
      await db.query(`select public.pbx_record_call($1)`, [JSON.stringify({ ...ring, status: 'RINGING' })]) // late duplicate
      const calls = await value<any[]>(db, `select jsonb_agg(to_jsonb(c)) from public.pbx_calls c where call_id = 'abc-1'`)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ status: 'ANSWERED', duration_seconds: 95, events: 3, profile_id: agent, order_id: o.id, customer_id: o.customer_id })

      await asUser(db, owner)
      const overview = await value<Record<string, any>>(db, `select public.integrations_overview()`)
      expect(overview.pbx).toMatchObject({ enabled: true, calls_7d: 1 })
      const status = await value<Record<string, any>>(db, `select public.system_status()`)
      expect(status.components.map((c: any) => c.key)).toEqual(expect.arrayContaining(['database', 'store_sync', 'courier_webhooks', 'messages', 'errors']))
      await expectError(db, `select public.admin_update_setting('pbx', '{}')`, [], /own screen/)
    }))
})

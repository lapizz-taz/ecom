import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff } from '../support/fixtures'

afterAll(closePool)

const asPlatform = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

/** Signed in with a real session row (as Supabase does): the token carries its session id. */
async function asPlatformSession(db: Db, id: string, sessionId: string) {
  await asPlatform(db, id)
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated', email: 'staff@platform.example', session_id: sessionId })])
}

async function session(db: Db, user: string, hoursAgo = 0): Promise<string> {
  await asSystem(db, null)
  return value<string>(db, `insert into auth.sessions (user_id, created_at) values ($1, now() - make_interval(hours => $2)) returning id`, [user, hoursAgo])
}

async function newMerchant(db: Db, superId: string): Promise<{ id: string; name: string; owner: string }> {
  await asPlatform(db, superId)
  const name = `Erase Shop ${randomUUID().slice(0, 6)}`
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await asPlatform(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, name, owner }
}

describe('security: administrative sessions', () => {
  it('ends old or signed-out sessions on every platform check, and lets a security manager sign staff out', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const superB = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')

      // 24 hours by default: a 30-hour-old sign-in is refused, with a clear reason.
      const old = await session(db, superA, 30)
      await asPlatformSession(db, superA, old)
      expect(await value(db, `select public.platform_can('overview', 'view')`)).toBe(false)
      await expectError(db, `select public.platform_health()`, [], /SESSION_EXPIRED/)
      expect(await value(db, `select public.platform_me()`)).toMatchObject({ session_expired: true })

      const fresh = await session(db, superA, 1)
      await asPlatformSession(db, superA, fresh)
      expect(await value(db, `select public.platform_can('overview', 'view')`)).toBe(true)
      const me = await value<{ session: { expires_at: string } }>(db, `select public.platform_me()`)
      expect(new Date(me.session.expires_at).getTime()).toBeGreaterThan(Date.now())

      // Only security managers change the limit; it is validated.
      await expectError(db, `select public.platform_setting_save('security', '{"staff_session_hours": 0}')`, [], /1 to 720 hours/)
      await asPlatform(db, viewer)
      await expectError(db, `select public.platform_setting_save('security', '{"staff_session_hours": 48}')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_staff_sign_out($1, 'Lost laptop')`, [superB], /PERMISSION_DENIED/)

      // Signing B out removes every session; B's token stops working for the panel at once.
      const b = await session(db, superB, 0)
      await session(db, superB, 2)
      await asPlatformSession(db, superA, fresh)
      await expectError(db, `select public.platform_staff_sign_out($1, 'x')`, [superB], /say why/)
      expect(await value(db, `select public.platform_staff_sign_out($1, 'Lost laptop reported')`, [superB])).toEqual({ sessions_ended: 2 })
      await asPlatformSession(db, superB, b)
      expect(await value(db, `select public.platform_can('overview', 'view')`)).toBe(false)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'security.staff_signed_out' and entity_id = $1`, [superB])).toBe(1)

      // The access review shows sessions and second factors, and never credential values.
      await asPlatform(db, viewer)
      const o = await value<{ staff: Array<{ user_id: string; sessions: number; second_factors: number; privileged: boolean }>; credentials: unknown[] }>(db,
        `select public.platform_security_overview()`)
      const a = o.staff.find((s) => s.user_id === superA)!
      expect(a).toMatchObject({ sessions: 2, second_factors: 0, privileged: true })
      expect(o.staff.find((s) => s.user_id === viewer)!.privileged).toBe(false)
      expect(JSON.stringify(o.credentials)).not.toMatch(/secret_id/)
    }))
})

describe('settings: validated paths and rollback', () => {
  it('routes every setting through its own checks and restores automation rules from history', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asPlatform(db, superId)
      await expectError(db, `select public.platform_setting_save('cost_assumptions', '{"payment_fee_percent": 50}')`, [], /positive number/)
      await expectError(db, `select public.platform_setting_save('integration_health', '{"failing": ["sms"]}')`, [], /kept by the platform/)
      await expectError(db, `select public.platform_setting_save('retention', '{"system_logs_days": 1, "notifications_days": 90, "deletion_cooling_days": 14}')`, [], /7 to 3650/)
      await db.query(`select public.platform_setting_save('retention', '{"system_logs_days": 30, "notifications_days": 60, "deletion_cooling_days": 7}', 'Shorter')`)

      const rule = await value<{ id: string }>(db, `select public.platform_automation_rule_save($1)`, [JSON.stringify({
        name: 'Failing stores v1', trigger: 'integration_failures', actions: [{ type: 'notify_staff', module: 'integrations', action: 'edit' }] })])
      await db.query(`select public.platform_automation_rule_save($1, 'Renamed')`, [JSON.stringify({
        id: rule.id, name: 'Failing stores v2', trigger: 'integration_failures', actions: [{ type: 'notify_staff', module: 'integrations', action: 'edit' }] })])
      await asSystem(db, null)
      const first = await value<string>(db, `select min(id) from public.config_versions where kind = 'automation_rule' and ref = $1`, [rule.id])
      await asPlatform(db, superId)
      await db.query(`select public.platform_config_rollback($1, 'Back to the first name')`, [first])
      await asSystem(db, null)
      expect(await value(db, `select name from public.platform_automation_rules where id = $1`, [rule.id])).toBe('Failing stores v1')
      await asPlatform(db, superId)

      const g = await value<{ settings: Record<string, { last_change: { note: string } | null }>; releases: unknown[] }>(db, `select public.platform_global_settings()`)
      expect(g.settings.retention.last_change?.note).toBe('Shorter')
    }))
})

describe('data management', () => {
  it('records exports, keeps resolved logs only as long as the policy says, and lists import errors', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const m = await newMerchant(db, superId)

      await asPlatform(db, viewer)
      await expectError(db, `select public.platform_merchant_export($1, 'Portability request')`, [m.id], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_export_record('MERCHANTS', '{"rows": 3}')`, [], /PERMISSION_DENIED/)
      await asPlatform(db, billing)
      await db.query(`select public.platform_export_record('MERCHANTS', '{"rows": 3}')`)
      await asPlatform(db, superId)
      await expectError(db, `select public.platform_merchant_export($1, 'x')`, [m.id], /say why/)
      const exp = await value<{ rows: Record<string, number>; data: { merchant: { id: string } } }>(db,
        `select public.platform_merchant_export($1, 'Owner asked for a copy')`, [m.id])
      expect(exp.data.merchant.id).toBe(m.id)
      expect(exp.rows).toMatchObject({ orders: 0, customers: 0 })
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_data_exports where merchant_id = $1 and kind = 'MERCHANT_DATA'`, [m.id])).toBe(1)
      await expectError(db, `delete from public.platform_data_exports`, [], /IMMUTABLE_RECORD/)

      // Retention: resolved entries past the policy go; unresolved ones stay however old.
      await db.query(`insert into public.system_logs (merchant_id, level, category, source, message, resolved_at, last_seen_at)
        values ($1, 'ERROR', 'FUNCTION', 'retention-test', 'old resolved', now() - interval '200 days', now() - interval '200 days'),
               ($1, 'ERROR', 'FUNCTION', 'retention-test', 'old open', null, now() - interval '200 days')`, [m.id])
      await asPlatform(db, viewer)
      await expectError(db, `select public.platform_retention_run_now('test')`, [], /PERMISSION_DENIED/)
      const d = await value<{ retention: { due: { system_logs: number } } }>(db, `select public.platform_data_overview()`)
      expect(d.retention.due.system_logs).toBeGreaterThanOrEqual(1)
      await asPlatform(db, superId)
      await db.query(`select public.platform_retention_run_now('Monthly clean-up')`)
      await asSystem(db, null)
      expect((await db.query(`select message from public.system_logs where source = 'retention-test'`)).rows.map((r) => r.message)).toEqual(['old open'])

      // Failed store imports show up for staff who can see the merchant.
      const channel = await value<string>(db, `insert into public.sales_channels (merchant_id, platform, name, shop_domain, status) values ($1, 'SHOPIFY', 'Shop', $2, 'CONNECTED') returning id`,
        [m.id, `imp-${randomUUID().slice(0, 6)}.myshopify.com`])
      await db.query(`insert into public.channel_order_imports (merchant_id, channel_id, external_id, external_number, status, payload, error, received_via)
        values ($1, $2, 'ext-1', '#1001', 'FAILED', '{}', 'Unknown product SKU-9', 'WEBHOOK')`, [m.id, channel])
      await asPlatform(db, viewer)
      const o = await value<{ imports: { rows: Array<{ error: string; merchant: { id: string } }> } }>(db, `select public.platform_data_overview()`)
      expect(o.imports.rows.find((r) => r.merchant.id === m.id)?.error).toBe('Unknown product SKU-9')
    }))

  it('erases a closed merchant\'s personal data only after a second person approved it and the wait is over', () =>
    inTx(async (db) => {
      const superA = await createPlatformStaff(db, 'SUPER_ADMIN')
      const superB = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superA)
      await asSystem(db, m.id)
      const customer = await value<string>(db, `insert into public.customers (merchant_id, full_name, phone, email, address)
        values ($1, 'Rahim Uddin', '01711000111', 'rahim@example.com', 'House 4, Road 2') returning id`, [m.id])
      await db.query(`insert into public.contact_messages (merchant_id, name, phone, message) values ($1, 'Karim', '01811000222', 'Do you ship to Sylhet?')`, [m.id])

      // Only the owner asks, once.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const req = await value<{ id: string; status: string }>(db, `select public.merchant_data_deletion_request('We are closing the business')`)
      expect(req.status).toBe('REQUESTED')
      await expectError(db, `select public.merchant_data_deletion_request('Again please')`, [], /already open/)
      expect(await value(db, `select public.my_data_deletion_request() ->> 'status'`)).toBe('REQUESTED')

      await asPlatform(db, superA)
      const approved = await value<{ status: string; erase_after: string; ready: boolean }>(db,
        `select public.platform_deletion_request_decide($1, true, 'Confirmed by phone with the owner')`, [req.id])
      expect(approved).toMatchObject({ status: 'APPROVED', ready: false })
      expect(new Date(approved.erase_after).getTime() - Date.now()).toBeGreaterThan(13 * 86400_000)

      // Not before the wait is over, never by the approver, only for a closed account, with the name typed.
      await asPlatform(db, superB)
      await expectError(db, `select public.platform_deletion_request_execute($1, $2)`, [req.id, m.name], /waiting period/)
      await asSystem(db, null)
      await db.query(`update public.merchant_deletion_requests set erase_after = now() - interval '1 minute' where id = $1`, [req.id])
      await asPlatform(db, superA)
      await expectError(db, `select public.platform_deletion_request_execute($1, $2)`, [req.id, m.name], /approved it cannot/)
      await asPlatform(db, superB)
      await expectError(db, `select public.platform_deletion_request_execute($1, $2)`, [req.id, m.name], /close the merchant/)
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'CLOSED' where id = $1`, [m.id])

      // The bypass for immutable records never works for a signed-in user.
      await asPlatform(db, superB)
      await db.query(`select set_config('app.erasure_request', $1, true)`, [req.id])
      expect(await value(db, `select public._erasure_active($1)`, [m.id])).toBe(false)
      await db.query(`select set_config('app.erasure_request', '', true)`)

      await expectError(db, `select public.platform_deletion_request_execute($1, 'erase shop')`, [req.id], /type the merchant/)
      const done = await value<{ status: string; result: Record<string, number> }>(db, `select public.platform_deletion_request_execute($1, $2)`, [req.id, m.name])
      expect(done.status).toBe('COMPLETED')
      expect(done.result).toMatchObject({ customers: 1, contact_messages: 1, staff_deactivated: 1 })

      await asSystem(db, null)
      const c = (await db.query(`select full_name, phone, email, address from public.customers where id = $1`, [customer])).rows[0]
      expect(c).toEqual({ full_name: 'Erased customer', phone: '0000000000001', email: null, address: null })
      expect(await value(db, `select count(*)::int from public.contact_messages where merchant_id = $1 and phone is null and message = 'Erased'`, [m.id])).toBe(1)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'data.erased' and merchant_id = $1`, [m.id])).toBe(1)
      // Done once: it cannot run again.
      await asPlatform(db, superB)
      await expectError(db, `select public.platform_deletion_request_execute($1, $2)`, [req.id, m.name], /only an approved/)
    }))
})

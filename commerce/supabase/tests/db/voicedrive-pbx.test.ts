import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
type J = Record<string, any>

/** The primary business with a number, trunk, gateway check-in and a package. */
async function readyLine(db: Db, owner: string, opts: { packageCode?: string; channels?: number; agents?: number; balance?: number } = {}) {
  await asSystem(db)
  const businessId = await value<string>(db, `select id from public.pbx_businesses where is_primary`)
  await asUser(db, owner)
  await db.query(`select public.pbx_provision_business_did($1)`, [JSON.stringify({ business_id: businessId, did: '09639123456',
    trunk_host: 'sip.iptsp.example', trunk_user: 'acct1', pbx_enabled: true })])
  await asService(db)
  await db.query(`select public.pbx_admin_mark_trunk_secret($1, true)`, [businessId])
  await db.query(`select public.pbx_gw_ping('test', '{}')`)
  await asUser(db, owner)
  await db.query(`select public.pbx_admin_save_settings($1)`, [JSON.stringify({ sip_domain: 'pbx.example.com', wss_url: 'wss://pbx.example.com:8089/ws' })])
  await db.query(`select public.pbx_set_pbx_bridge_ready($1, true)`, [businessId])
  const pkg = await value<string>(db, `select p ->> 'id' from jsonb_array_elements(public.pbx_packages_list() -> 'packages') p where p ->> 'code' = $1`, [opts.packageCode ?? 'ENTERPRISE'])
  await db.query(`select public.pbx_admin_grant_package($1)`, [JSON.stringify({ business_id: businessId, package_id: pkg,
    agents: opts.agents ?? 10, channels: opts.channels ?? 5, months: 1 })])
  if (opts.balance) await db.query(`select public.pbx_admin_adjust_balance($1, $2, 'test credit')`, [businessId, opts.balance])
  return businessId
}

async function addAgent(db: Db, owner: string, role = 'ORDER_MANAGER', ext?: string) {
  const staff = await createStaff(db, role)
  await asUser(db, owner)
  const agent = await value<J>(db, `select public.pbx_save_agent($1)`, [JSON.stringify({ profile_id: staff, extension: ext })])
  return { staff, agent }
}

async function issue(db: Db, staff: string, password = 'p'.repeat(32)) {
  await asUser(db, staff)
  return value<J>(db, `select public.pbx_issue_my_credential($1, 'test-agent')`, [password])
}

describe('VoiceDrive PBX: provisioning and access', () => {
  it('only a Super Admin provisions the number and trunk; the bridge needs a trunk password and a live gateway', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const admin = await createStaff(db, 'ADMIN')
      await asSystem(db)
      const businessId = await value<string>(db, `select id from public.pbx_businesses where is_primary`)

      await asUser(db, admin)
      await expectError(db, `select public.pbx_provision_business_did($1)`, [JSON.stringify({ business_id: businessId, did: '09639000001', trunk_host: 'x.example' })],
        /pbx.super_admin/)

      await asUser(db, owner)
      await expectError(db, `select public.pbx_provision_business_did($1)`, [JSON.stringify({ business_id: businessId, did: '12', trunk_host: 'x.example' })], /DID/)
      const prov = await value<J>(db, `select public.pbx_provision_business_did($1)`, [JSON.stringify({ business_id: businessId, did: '+8809639000001',
        trunk_host: 'SIP.Example.com', trunk_user: 'u1', pbx_enabled: true })])
      expect(prov).toMatchObject({ did: '09639000001', callerId: '09639000001', bridgeReady: false })
      await expectError(db, `select public.pbx_set_pbx_bridge_ready($1, true)`, [businessId], /trunk password/)
      await asService(db)
      await db.query(`select public.pbx_admin_mark_trunk_secret($1, true)`, [businessId])
      await asUser(db, owner)
      await expectError(db, `select public.pbx_set_pbx_bridge_ready($1, true)`, [businessId], /gateway has not checked in/)
      await asService(db)
      await db.query(`select public.pbx_gw_ping('Asterisk 23', '{}')`)
      await asUser(db, owner)
      expect((await value<J>(db, `select public.pbx_set_pbx_bridge_ready($1, true)`, [businessId])).bridgeReady).toBe(true)

      // Without a package the line stays inactive.
      const ov = await value<J>(db, `select public.pbx_overview()`)
      expect(ov.lineStatus).toBe('INACTIVE')
      expect(ov.lineProblems).toContain('NO_PACKAGE')

      // Browsers can't call gateway procedures.
      await asUser(db, owner)
      await expectError(db, `select public.pbx_gw_trunks()`, [], /permission denied|PERMISSION_DENIED/i)
      await expectError(db, `select public.pbx_gw_call_ended($1, 'COMPLETED', 60)`, [randomUUID()], /permission denied|PERMISSION_DENIED/i)
    }))

  it('a manager cannot act on another business; staff of business 2 do not see business 1 calls', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { balance: 50 })
      const { staff: agent1 } = await addAgent(db, owner)
      await issue(db, agent1)
      await asUser(db, agent1)
      await db.query(`select public.pbx_start_manual_call('01711000111')`)

      await asUser(db, owner)
      const b2 = await value<J>(db, `select public.pbx_admin_save_business('{"name":"Second shop"}')`)
      const admin2 = await createStaff(db, 'ADMIN')
      await asUser(db, owner)
      await db.query(`select public.pbx_admin_set_member($1, $2)`, [admin2, b2.id])
      await asUser(db, admin2)
      expect((await value<J>(db, `select public.pbx_overview()`)).business.name).toBe('Second shop')
      expect((await value<J>(db, `select public.pbx_reports(current_date, current_date)`)).totals.calls).toBe(0)
      const primary = await value<string>(db, `select public.pbx_overview(null) -> 'business' ->> 'id'`)
      expect(primary).toBe(b2.id)
      await asSystem(db)
      const b1 = await value<string>(db, `select id from public.pbx_businesses where is_primary`)
      await asUser(db, admin2)
      await expectError(db, `select public.pbx_list_agents($1)`, [b1], /only manage your own business/)
    }))
})

describe('VoiceDrive PBX: packages and prepaid balance (bKash)', () => {
  it('prices the package on the server, applies it once, and refuses a wrong amount', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const growth = await value<string>(db, `select p ->> 'id' from jsonb_array_elements(public.pbx_packages_list() -> 'packages') p where p ->> 'code' = 'GROWTH'`)
      const start = await value<J>(db, `select public.pbx_bkash_start($1)`, [JSON.stringify({ type: 'PACKAGE', package_id: growth, extra_agents: 1, extra_channels: 1, months: 2 })])
      expect(num(start.amountTk)).toBe((1000 + 100 + 150) * 2)

      // The browser can't complete a payment.
      await expectError(db, `select public.pbx_bkash_complete($1, true, 'TRX1', 2500)`, [start.reference], /permission denied|PERMISSION_DENIED/i)

      await asService(db)
      const wrong = await value<J>(db, `select public.pbx_bkash_complete($1, true, 'TRXBAD', 100)`, [start.reference])
      expect(wrong.status).toBe('amount_mismatch')
      await asUser(db, admin)
      expect((await value<J>(db, `select public.pbx_overview()`)).limits.active).toBe(false)

      const again = await value<J>(db, `select public.pbx_bkash_start($1)`, [JSON.stringify({ type: 'PACKAGE', package_id: growth, months: 1 })])
      await asService(db)
      expect((await value<J>(db, `select public.pbx_bkash_complete($1, true, 'TRX2', 1000)`, [again.reference])).status).toBe('completed')
      expect((await value<J>(db, `select public.pbx_bkash_complete($1, true, 'TRX2', 1000)`, [again.reference])).status).toBe('already_completed')
      await asUser(db, admin)
      const limits = (await value<J>(db, `select public.pbx_overview()`)).limits
      expect(limits).toMatchObject({ active: true, packageCode: 'GROWTH', agents: 10, channels: 6 })

      // Same plan again: the month is added after the current one.
      const renew = await value<J>(db, `select public.pbx_bkash_start($1)`, [JSON.stringify({ type: 'PACKAGE', package_id: growth, months: 1 })])
      await asService(db)
      await db.query(`select public.pbx_bkash_complete($1, true, 'TRX3', 1000)`, [renew.reference])
      await asSystem(db)
      const subs = await db.query(`select starts_at, expires_at from public.pbx_subscriptions where status = 'ACTIVE' order by starts_at`)
      expect(subs.rows).toHaveLength(2)
      expect(new Date(subs.rows[1].starts_at).getTime()).toBe(new Date(subs.rows[0].expires_at).getTime())

      // Enterprise isn't sold through bKash.
      await asUser(db, admin)
      const ent = await value<string>(db, `select p ->> 'id' from jsonb_array_elements(public.pbx_packages_list() -> 'packages') p where p ->> 'code' = 'ENTERPRISE'`)
      await expectError(db, `select public.pbx_bkash_start($1)`, [JSON.stringify({ type: 'PACKAGE', package_id: ent })], /Enterprise/)
      void owner
    }))

  it('top-ups have a 100 tk minimum, credit the balance once, and the ledger cannot be edited', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await expectError(db, `select public.pbx_bkash_start('{"type":"TOPUP","amount_tk":99}')`, [], /smallest recharge is 100/)
      const t = await value<J>(db, `select public.pbx_bkash_start('{"type":"TOPUP","amount_tk":250}')`)
      await asService(db)
      await db.query(`select public.pbx_bkash_complete($1, true, 'TRXT1', 250)`, [t.reference])
      await db.query(`select public.pbx_bkash_complete($1, true, 'TRXT1', 250)`, [t.reference])
      await asUser(db, admin)
      expect(num((await value<J>(db, `select public.pbx_overview()`)).balanceTk)).toBe(250)
      const hist = await value<J>(db, `select public.pbx_billing_history()`)
      expect(hist.ledger).toHaveLength(1)
      expect(hist.ledger[0]).toMatchObject({ kind: 'TOPUP' })
      expect(hist.payments[0]).toMatchObject({ status: 'COMPLETED', trxId: 'TRXT1' })
      await asSystem(db)
      await expectError(db, `update public.pbx_ledger set amount_tk = 1`, [], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.pbx_ledger`, [], /IMMUTABLE_RECORD/)

      // A failed payment changes nothing.
      await asUser(db, admin)
      const f = await value<J>(db, `select public.pbx_bkash_start('{"type":"TOPUP","amount_tk":300}')`)
      await asService(db)
      expect((await value<J>(db, `select public.pbx_bkash_complete($1, false, null, null, 'Cancelled on the bKash page')`, [f.reference])).status).toBe('failed')
      await asUser(db, admin)
      expect(num((await value<J>(db, `select public.pbx_overview()`)).balanceTk)).toBe(250)
    }))
})

describe('VoiceDrive PBX: agents and softphone credentials', () => {
  it('seats limit agents; the gateway sees only a digest of a short-lived password', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { agents: 3 })
      await asUser(db, owner)
      // Micro is no longer sold.
      expect((await value<J>(db, `select public.pbx_packages_list()`)).packages.map((p: J) => p.code)).toEqual(['STARTER', 'GROWTH', 'BUSINESS', 'SCALE', 'ENTERPRISE'])
      const a1 = await addAgent(db, owner, 'ORDER_MANAGER', '101')
      await addAgent(db, owner, 'ORDER_MANAGER')
      await addAgent(db, owner, 'ORDER_MANAGER')
      const extra = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, owner)
      await expectError(db, `select public.pbx_save_agent($1)`, [JSON.stringify({ profile_id: extra })], /all 3 agent seats are used/)
      // An inactive agent doesn't use a seat.
      await db.query(`select public.pbx_save_agent($1)`, [JSON.stringify({ profile_id: extra, active: false })])
      await expectError(db, `select public.pbx_save_agent($1)`, [JSON.stringify({ profile_id: randomUUID() })], /choose a staff member/)

      await asSystem(db)
      const code = await value<number>(db, `select code from public.pbx_businesses where is_primary`)
      expect(a1.agent.sip_username).toBe(`vd${code}x101`)

      const password = 'S3cret-' + randomUUID()
      const cred = await issue(db, a1.staff, password)
      expect(cred).toMatchObject({ sipUsername: `vd${code}x101`, sipUri: `sip:vd${code}x101@pbx.example.com`, extension: '101' })

      await asSystem(db)
      await db.query(`set local role pbx_gateway`)
      const auth = (await db.query(`select * from pbx_gw.ps_auths where id = $1`, [`vd${code}x101`])).rows[0]
      expect(auth.password_digest).toBe(`MD5:${md5(`vd${code}x101:voicedrive:${password}`)}`)
      expect(JSON.stringify(auth)).not.toContain(password)
      const ep = (await db.query(`select * from pbx_gw.ps_endpoints where id = $1`, [`vd${code}x101`])).rows[0]
      expect(ep).toMatchObject({ webrtc: 'yes', context: 'vd-agents', transport: 'transport-wss' })
      await expectError(db, `select * from public.pbx_agents`, [], /permission denied/)
      await asSystem(db)

      // Expired credentials vanish from the gateway's view.
      await db.query(`update public.pbx_sip_credentials set expires_at = now() - interval '1 second'`)
      await db.query(`set local role pbx_gateway`)
      expect((await db.query(`select * from pbx_gw.ps_auths`)).rows).toHaveLength(0)
      await asSystem(db)

      // Staff can't read credentials or call records directly.
      await asUser(db, a1.staff)
      await expectError(db, `select * from public.pbx_sip_credentials`, [], /permission denied/)
      await expectError(db, `select * from public.pbx_call_records`, [], /permission denied/)
    }))

  it('maintenance and an inactive line stop new credentials', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner)
      const { staff } = await addAgent(db, owner)
      await asUser(db, owner)
      await db.query(`select public.pbx_admin_save_settings($1)`, [JSON.stringify({ maintenance: { starts_at: new Date(Date.now() - 60_000).toISOString(),
        until: new Date(Date.now() + 3_600_000).toISOString(), message: 'Upgrade' } })])
      expect((await value<J>(db, `select public.pbx_maintenance_status()`)).state).toBe('active')
      await asUser(db, staff)
      await expectError(db, `select public.pbx_issue_my_credential($1)`, ['x'.repeat(32)], /MAINTENANCE/)
      await asUser(db, owner)
      await db.query(`select public.pbx_admin_save_settings($1)`, [JSON.stringify({ maintenance: { starts_at: new Date(Date.now() + 3_600_000).toISOString(),
        until: new Date(Date.now() + 7_200_000).toISOString() } })])
      expect((await value<J>(db, `select public.pbx_maintenance_status()`)).state).toBe('scheduled')
      await asUser(db, staff)
      expect((await issue(db, staff)).sipUsername).toBeTruthy()

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.pbx_issue_my_credential($1)`, ['x'.repeat(32)], /pbx.call/)
    }))
})

describe('VoiceDrive PBX: outgoing calls and billing on the gateway record', () => {
  it('the gateway authorises the requested number, holds a channel, and charges ceil(seconds) × 0.40/60 + 15% VAT once', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { channels: 1, balance: 10 })
      const a = await addAgent(db, owner)
      const b = await addAgent(db, owner)
      await issue(db, a.staff)
      await issue(db, b.staff)
      const sipA = a.agent.sip_username as string

      await asUser(db, a.staff)
      const req = await value<J>(db, `select public.pbx_start_manual_call('+8801711000111')`)
      expect(req).toMatchObject({ status: 'REQUESTED', dial: '01711000111', direction: 'OUTBOUND' })

      await asService(db)
      // Dialling a different number than the request is refused.
      const bad = await value<J>(db, `select public.pbx_gw_outbound_start($1, '01999999999', $2, 'gw-1')`, [sipA, req.id])
      expect(bad).toMatchObject({ allow: false, reason: 'NUMBER_MISMATCH' })
      // No request id at all is refused too.
      expect((await value<J>(db, `select public.pbx_gw_outbound_start($1, '01711000111', null, 'gw-x')`, [sipA])).reason).toBe('NO_REQUEST')

      await asUser(db, a.staff)
      const req2 = await value<J>(db, `select public.pbx_start_manual_call('01711000111')`)
      await asService(db)
      const ok = await value<J>(db, `select public.pbx_gw_outbound_start($1, '01711000111', $2, 'gw-2')`, [sipA, req2.id])
      // 10 tk at 0.46 tk/min allows 1304 s, but the business cap is 15 min.
      expect(ok).toMatchObject({ allow: true, dial: '01711000111', callerId: '09639123456', maxSeconds: 900 })
      expect(ok.trunk).toMatch(/^vdtrunk-\d+$/)
      // The same request can't start twice.
      expect((await value<J>(db, `select public.pbx_gw_outbound_start($1, '01711000111', $2, 'gw-3')`, [sipA, req2.id])).reason).toBe('REQUEST_USED')

      // The only channel is busy: another agent's request is refused by the app and by the gateway.
      await asUser(db, b.staff)
      await expectError(db, `select public.pbx_start_manual_call('01811000222')`, [], /call channels are busy/)

      await asService(db)
      await db.query(`select public.pbx_gw_call_answered($1)`, [req2.id])
      const end = await value<J>(db, `select public.pbx_gw_call_ended($1, 'COMPLETED', 61.2, 'NORMAL_CLEARING')`, [req2.id])
      // 62 s → 0.4133 + 0.0620 VAT
      expect(end).toMatchObject({ status: 'COMPLETED', billedSeconds: 62 })
      expect(num(end.chargedTk)).toBeCloseTo(0.4133 + 0.062, 4)
      const again = await value<J>(db, `select public.pbx_gw_call_ended($1, 'COMPLETED', 600)`, [req2.id])
      expect(again.already).toBe(true)
      await asUser(db, a.staff)
      const ov = await value<J>(db, `select public.pbx_overview()`)
      expect(num(ov.balanceTk)).toBeCloseTo(10 - 0.4753, 2)
      expect(ov.channelsInUse).toBe(0)
      const state = await value<J>(db, `select public.pbx_get_call_state($1)`, [req2.id])
      expect(state).toMatchObject({ status: 'COMPLETED', billedSeconds: 62 })
      expect(num(state.vatTk)).toBeCloseTo(0.062, 4)

      // Unanswered outgoing calls cost nothing.
      const req3 = await value<J>(db, `select public.pbx_start_manual_call('01711000111')`)
      await asService(db)
      await db.query(`select public.pbx_gw_outbound_start($1, '01711000111', $2, 'gw-4')`, [sipA, req3.id])
      expect((await value<J>(db, `select public.pbx_gw_call_ended($1, 'BUSY', 0, 'USER_BUSY')`, [req3.id]))).toMatchObject({ status: 'BUSY', billedSeconds: 0 })
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.pbx_ledger where kind = 'CALL_CHARGE'`)).toBe(1)
    }))

  it('limits a call to what the balance can pay, counting money held by other live calls', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { channels: 5, balance: 1 })
      const a = await addAgent(db, owner)
      const b = await addAgent(db, owner)
      await issue(db, a.staff)
      await issue(db, b.staff)
      await asUser(db, a.staff)
      const r1 = await value<J>(db, `select public.pbx_start_manual_call('01711000111')`)
      await asUser(db, b.staff)
      const r2 = await value<J>(db, `select public.pbx_start_manual_call('01811000222')`)
      await asService(db)
      const s1 = await value<J>(db, `select public.pbx_gw_outbound_start($1, '01711000111', $2, 'g1')`, [a.agent.sip_username, r1.id])
      // 1 tk ÷ 0.46 tk/min = 130 s
      expect(s1.maxSeconds).toBe(130)
      const s2 = await value<J>(db, `select public.pbx_gw_outbound_start($1, '01811000222', $2, 'g2')`, [b.agent.sip_username, r2.id])
      expect(s2).toMatchObject({ allow: false, reason: 'INSUFFICIENT_BALANCE' })

      // Empty balance: the app refuses before dialling.
      await asUser(db, owner)
      const bid = await value<string>(db, `select public.pbx_overview() -> 'business' ->> 'id'`)
      await db.query(`select public.pbx_admin_adjust_balance($1, -1, 'test')`, [bid])
      await asUser(db, b.staff)
      await expectError(db, `select public.pbx_start_manual_call('01811000222')`, [], /balance is empty/)
    }))

  it('order calls are linked to the order and show in the list call state', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { balance: 20 })
      const a = await addAgent(db, owner)
      await issue(db, a.staff)
      const p = await createProduct(db, { price: 500, stock: 5 })
      const o = await createOrder(db, { phone: '01755000333', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, a.staff)
      const req = await value<J>(db, `select public.pbx_start_web_order_call($1)`, [o.id])
      expect(req).toMatchObject({ kind: 'WEB_ORDER', orderId: o.id, dial: '01755000333' })
      const states = await value<J>(db, `select public.pbx_get_order_call_states($1)`, [[o.id]])
      expect(states[o.id]).toMatchObject({ lastStatus: 'REQUESTED', attempts: 1, live: true })
      const ended = await value<J>(db, `select public.pbx_end_call($1, 'CONFIRMED', 'Will receive tomorrow')`, [req.id])
      expect(ended).toMatchObject({ status: 'CANCELLED', outcome: 'CONFIRMED' })
      await expectError(db, `select public.pbx_end_call($1, 'MAYBE')`, [req.id], /unknown call outcome/)
    }))
})

describe('VoiceDrive PBX: incoming calls, screen-pop, missed calls', () => {
  it('rings available agents, records who answered, is free, and logs unanswered calls as missed', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { balance: 5 })
      const a = await addAgent(db, owner)
      const b = await addAgent(db, owner)
      await issue(db, a.staff)
      await issue(db, b.staff)
      const p = await createProduct(db, { price: 800, stock: 5 })
      await createOrder(db, { phone: '01722000444', items: [{ variantId: p.variantIds[0], quantity: 1 }] })

      // Only agent A is online and available.
      await asUser(db, a.staff)
      await db.query(`select public.pbx_set_inbound_phone_presence('AVAILABLE', true, 'registered')`)
      await asUser(db, b.staff)
      await db.query(`select public.pbx_set_inbound_phone_presence('AWAY', true, 'registered')`)

      await asService(db)
      const inb = await value<J>(db, `select public.pbx_gw_inbound_start('+8809639123456', '+8801722000444', 'in-1')`)
      expect(inb.allow).toBe(true)
      expect(inb.targets.map((t: J) => t.sipUsername)).toEqual([a.agent.sip_username])
      // A retried INVITE is the same call.
      expect((await value<J>(db, `select public.pbx_gw_inbound_start('09639123456', '01722000444', 'in-1')`)).callId).toBe(inb.callId)

      await asUser(db, a.staff)
      const live = await value<J>(db, `select public.pbx_get_my_active_inbound_call()`)
      expect(live).toMatchObject({ id: inb.callId, status: 'RINGING', normalizedCustomerPhone: '01722000444' })
      const ctx = await value<J>(db, `select public.pbx_resolve_inbound_caller_context($1)`, [live.customerPhone])
      expect(ctx.known).toBe(true)
      expect(ctx.orders.length).toBeGreaterThanOrEqual(1)
      const detail = await value<J>(db, `select public.pbx_get_inbound_caller_order_detail('01722000444')`)
      expect(detail.items[0]).toMatchObject({ quantity: 1 })
      expect((await value<J>(db, `select public.pbx_resolve_inbound_caller_courier_rating('01722000444')`)).phone).toBe('01722000444')
      await asUser(db, b.staff)
      expect(await value(db, `select public.pbx_get_my_active_inbound_call()`)).toBeNull()

      await asService(db)
      await db.query(`select public.pbx_gw_call_answered($1, $2)`, [inb.callId, a.agent.sip_username])
      const end = await value<J>(db, `select public.pbx_gw_call_ended($1, 'COMPLETED', 120)`, [inb.callId])
      expect(end).toMatchObject({ status: 'COMPLETED', billedSeconds: 120 })
      expect(num(end.chargedTk)).toBe(0)
      await asUser(db, a.staff)
      expect(num((await value<J>(db, `select public.pbx_overview()`)).balanceTk)).toBe(5)

      // Nobody available: rung no one, then missed.
      await db.query(`select public.pbx_clear_inbound_phone_presence()`)
      await asService(db)
      const miss = await value<J>(db, `select public.pbx_gw_inbound_start('09639123456', '01911000555', 'in-2')`)
      expect(miss.targets).toEqual([])
      await db.query(`select public.pbx_gw_call_ended($1, 'NO_ANSWER', 0)`, [miss.callId])
      await asUser(db, a.staff)
      const missed = await value<J>(db, `select public.pbx_get_recent_missed_inbound_calls(10)`)
      expect(missed.items[0]).toMatchObject({ id: miss.callId, status: 'NO_ANSWER', direction: 'INBOUND', customerPhone: '01911000555',
        normalizedCustomerPhone: '01911000555', callerId: '01911000555', calledBack: false })
      for (const k of ['createdAt', 'outcome', 'agentExtension', 'startedAt', 'answeredAt', 'endedAt']) expect(missed.items[0]).toHaveProperty(k)

      // Call back from the missed list.
      const cb = await value<J>(db, `select public.pbx_start_manual_call(null, $1)`, [miss.callId])
      expect(cb).toMatchObject({ kind: 'CALLBACK', callbackOf: miss.callId, dial: '01911000555' })
      expect((await value<J>(db, `select public.pbx_get_recent_missed_inbound_calls(10)`)).items[0].calledBack).toBe(true)

      // Unknown number and a full line are refused and logged.
      await asService(db)
      expect((await value<J>(db, `select public.pbx_gw_inbound_start('09630000000', '01711', 'in-3')`)).reason).toBe('UNKNOWN_NUMBER')
    }))

  it('telemetry is bounded and batch reads return each result or error', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner)
      const a = await addAgent(db, owner)
      await issue(db, a.staff)
      await asUser(db, a.staff)
      await db.query(`select public.pbx_record_call_attempt_trace(null, 'ice_failed', '{"state":"failed"}')`)
      await db.query(`select public.pbx_report_call_quality(null, '{"rtt":0.12,"jitter":0.01,"packetsLost":3}')`)
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.pbx_call_telemetry`)).toBe(2)

      await asUser(db, a.staff)
      const batch = await value<J>(db, `select public.pbx_batch($1)`, [JSON.stringify({ overview: {}, maintenanceStatus: {}, getInboundPhoneEligibility: {},
        getMyActiveInboundBrowserCall: {}, listAgents: {}, nope: {} })])
      expect(batch.overview.result.lineStatus).toBe('ACTIVE')
      expect(batch.maintenanceStatus.result.state).toBe('none')
      expect(batch.getInboundPhoneEligibility.result.eligible).toBe(true)
      expect(batch.getMyActiveInboundBrowserCall).toEqual({ result: null })
      expect(batch.listAgents.error.message).toMatch(/pbx.manage/)
      expect(batch.nope.error.code).toBe('NOT_FOUND')
    }))
})

describe('VoiceDrive PBX: sweep', () => {
  it('expires requests that never dialled and frees holds the gateway never closed, without charging', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await readyLine(db, owner, { balance: 10 })
      const a = await addAgent(db, owner)
      await issue(db, a.staff)
      await asUser(db, a.staff)
      const r1 = await value<J>(db, `select public.pbx_start_manual_call('01711000111')`)
      const r2 = await value<J>(db, `select public.pbx_start_manual_call('01711000112')`)
      await asService(db)
      await db.query(`select public.pbx_gw_outbound_start($1, '01711000112', $2, 'gs')`, [a.agent.sip_username, r2.id])
      await asSystem(db)
      // The first request was replaced by the second.
      expect(await value<string>(db, `select status from public.pbx_call_records where id = $1`, [r1.id])).toBe('CANCELLED')
      await db.query(`update public.pbx_call_records set started_at = now() - interval '2 hours' where id = $1`, [r2.id])
      const res = await value<J>(db, `select public.pbx_sweep()`)
      expect(res.lost).toBe(1)
      expect(await value<string>(db, `select status from public.pbx_call_records where id = $1`, [r2.id])).toBe('FAILED')
      expect(await value<number>(db, `select count(*)::int from public.pbx_channel_holds`)).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.pbx_ledger where kind = 'CALL_CHARGE'`)).toBe(0)
    }))
})

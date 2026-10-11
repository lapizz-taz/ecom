import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const asPlatform = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string): Promise<{ id: string; owner: string }> {
  await asPlatform(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name: `Phone Shop ${randomUUID().slice(0, 6)}` })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await asPlatform(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, owner }
}

const did = () => `0963${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

type Line = { id: string; code: number; did: string; pbx_enabled: boolean; bridge_ready: boolean; trunk_secret_set: boolean; problems: string[]
  limits: { active: boolean; agents: number }; balance_tk: number }

describe('PBX: VoiceDrive is a platform service', () => {
  it('takes provisioning, packages and balances away from merchant owners and gives them to platform PBX staff', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const pbxAdmin = await createPlatformStaff(db, 'PBX_ADMIN')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const m = await newMerchant(db, superId)
      const other = await newMerchant(db, superId)
      const limited = await createPlatformStaff(db, 'PBX_ADMIN', { scope: 'ASSIGNED', merchants: [other.id] })

      // The merchant's owner (every merchant permission) cannot provision or give themselves call credit.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      await expectError(db, `select public.pbx_admin_save_settings('{"rate_tk_per_min": 0.01}')`, [], /managed by the platform/)
      await expectError(db, `select public.pbx_admin_list_businesses()`, [], /PERMISSION_DENIED/)

      // Platform PBX staff set the line up, one merchant at a time.
      await asPlatform(db, tech)
      await expectError(db, `select public.platform_pbx_setup($1, '{}')`, [m.id], /PERMISSION_DENIED/)
      await asPlatform(db, limited)
      await expectError(db, `select public.platform_pbx_setup($1, '{}')`, [m.id], /NOT_FOUND/)
      await asPlatform(db, pbxAdmin)
      await expectError(db, `select public.platform_pbx_setup($1, $2)`, [m.id, JSON.stringify({ did: '123', trunk_host: 'sip.iptsp.example' })], /DID/)
      const number = did()
      let line = await value<Line>(db, `select public.platform_pbx_setup($1, $2, 'New line')`, [m.id, JSON.stringify({ did: number, trunk_host: 'sip.iptsp.example', trunk_user: 'shop1' })])
      expect(line).toMatchObject({ did: number, pbx_enabled: false, bridge_ready: false, trunk_secret_set: false })
      expect(line.problems).toEqual(expect.arrayContaining(['NOT_ENABLED', 'BRIDGE_NOT_READY', 'NO_PACKAGE']))
      // One number, one merchant.
      await expectError(db, `select public.platform_pbx_setup($1, $2)`, [other.id, JSON.stringify({ did: number, trunk_host: 'sip.iptsp.example' })], /already used/)
      await expectError(db, `select public.platform_pbx_set_enabled($1, true, 'x')`, [m.id], /say why/)
      line = await value<Line>(db, `select public.platform_pbx_set_enabled($1, true, 'Contract signed')`, [m.id])
      expect(line.pbx_enabled).toBe(true)

      // Tested only with the trunk password saved and the gateway online.
      await expectError(db, `select public.platform_pbx_bridge_ready($1, true)`, [m.id], /trunk password first/)
      await db.query(`select public.platform_pbx_trunk_secret_saved($1, true, '••ss')`, [m.id])
      await asSystem(db, null)
      await db.query(`update public.pbx_gateway_status set last_seen_at = now(), detail = $1`, [JSON.stringify({ trunks: [{ name: `vdtrunk-${line.code}`, state: 'online' }] })])
      await asPlatform(db, pbxAdmin)
      line = await value<Line>(db, `select public.platform_pbx_bridge_ready($1, true)`, [m.id])
      expect(line.bridge_ready).toBe(true)

      // A package and call credit, given with a reason and recorded.
      const starter = (await value<{ packages: Array<{ id: string; code: string }> }>(db, `select public.platform_pbx_overview()`)).packages.find((p) => p.code === 'STARTER')!.id
      await expectError(db, `select public.platform_pbx_grant_package($1, $2, 'no')`, [m.id, JSON.stringify({ package_id: starter, months: 1 })], /say why/)
      await db.query(`select public.platform_pbx_grant_package($1, $2, 'Launch offer for the first month')`, [m.id, JSON.stringify({ package_id: starter, months: 1 })])
      let check = await value<{ ok: boolean; checks: Array<{ key: string; ok: boolean }> }>(db, `select public.platform_pbx_check($1)`, [m.id])
      expect(check.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(expect.arrayContaining(['balance']))
      await db.query(`select public.platform_pbx_adjust_balance($1, 250, 'Goodwill credit for setup delays')`, [m.id])
      check = await value(db, `select public.platform_pbx_check($1)`, [m.id])
      // The plan decides whether PBX is in it; everything about the line itself is now ready.
      expect(check.checks.filter((c) => !c.ok).map((c) => c.key).filter((k) => k !== 'feature')).toEqual([])

      // Extensions: only the merchant's own staff, within the paid seats.
      const agent = await value<{ extension: string }>(db, `select public.platform_pbx_agent_save($1, $2)`, [m.id, JSON.stringify({ profile_id: m.owner })])
      expect(agent.extension).toMatch(/^\d+$/)
      await expectError(db, `select public.platform_pbx_agent_save($1, $2)`, [m.id, JSON.stringify({ profile_id: other.owner })], /choose a staff member/)
      await db.query(`select public.platform_pbx_ring_group_save($1, '{"name":"Sales","strategy":"LONGEST_IDLE","ring_seconds":20}')`, [m.id])
      const detail = await value<{ agents: unknown[]; ring_groups: Array<{ name: string }>; ledger: Array<{ kind: string; amount_tk: number }> }>(db,
        `select public.platform_pbx_merchant($1)`, [m.id])
      expect(detail.agents).toHaveLength(1)
      expect(detail.ring_groups.map((g) => g.name)).toEqual(expect.arrayContaining(['Everyone', 'Sales']))
      expect(detail.ledger[0]).toMatchObject({ kind: 'ADJUSTMENT', amount_tk: 250 })

      // The merchant's own PBX managers still run their agents.
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const list = await value<{ agents: unknown[] }>(db, `select public.pbx_list_agents(null)`)
      expect(list.agents).toHaveLength(1)
      const ov = await value<{ isSuperAdmin: boolean; lineStatus: string }>(db, `select public.pbx_overview(null)`)
      expect(ov.isSuperAdmin).toBe(false)

      await asSystem(db, null)
      const actions = (await db.query(`select action from public.platform_audit_logs where merchant_id = $1 and action like 'pbx.%' order by id`, [m.id])).rows.map((r) => r.action)
      expect(actions).toEqual(expect.arrayContaining(['pbx.configured', 'pbx.enabled', 'pbx.trunk_secret_saved', 'pbx.bridge_ready', 'pbx.package_granted',
        'pbx.balance_adjusted', 'pbx.checked', 'pbx.agent_saved', 'pbx.ring_group_saved']))
      // Nothing of this leaked into the other merchant.
      expect(await value(db, `select count(*)::int from public.pbx_agents where merchant_id = $1`, [other.id])).toBe(0)
    }))

  it('keeps the shared VoiceDrive settings on the platform, validated and versioned', () =>
    inTx(async (db) => {
      const pbxAdmin = await createPlatformStaff(db, 'PBX_ADMIN')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      await asPlatform(db, tech)
      expect((await value<{ settings: { rate_tk_per_min: number } }>(db, `select public.platform_pbx_overview()`)).settings).toHaveProperty('rate_tk_per_min')
      await expectError(db, `select public.platform_pbx_settings_save('{"rate_tk_per_min": 0.5}')`, [], /PERMISSION_DENIED/)
      await asPlatform(db, pbxAdmin)
      await expectError(db, `select public.platform_pbx_settings_save('{"wss_url": "http://pbx.example.com"}')`, [], /wss:\/\//)
      await expectError(db, `select public.platform_pbx_settings_save('{"min_topup_tk": 900, "max_topup_tk": 500}')`, [], /smallest top-up/)
      await expectError(db, `select public.platform_pbx_settings_save('{"turn_urls": ["http://x"]}')`, [], /TURN addresses/)
      const saved = await value<{ rate_tk_per_min: number; wss_url: string }>(db,
        `select public.platform_pbx_settings_save('{"rate_tk_per_min": 0.5, "wss_url": "wss://pbx.example.com:8089/ws"}', 'New IPTSP rate')`)
      expect(saved).toMatchObject({ rate_tk_per_min: 0.5, wss_url: 'wss://pbx.example.com:8089/ws' })
      // Every merchant's VoiceDrive now uses the platform's value.
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner, 'owner@example.com', MERCHANT_1)
      expect(Number((await value<{ ratePerMinTk: number }>(db, `select public.pbx_packages_list()`)).ratePerMinTk)).toBe(0.5)
      await expectError(db, `select public._vd_cfg()`, [], /permission denied/)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.config_versions where ref = 'voicedrive'`)).toBeGreaterThanOrEqual(1)
    }))
})

describe('Other integrations', () => {
  it('shows merchant connections without their credentials and retries failed jobs once', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const support = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      const channel = await value<string>(db, `insert into public.sales_channels (merchant_id, platform, name, shop_domain, status, last_error)
        values ($1, 'SHOPIFY', 'Shop', $2, 'ERROR', 'Token revoked by the shop') returning id`, [m.id, `i-${randomUUID().slice(0, 6)}.myshopify.com`])
      for (let i = 0; i < 2; i++) {
        await db.query(`insert into public.channel_sync_jobs (merchant_id, channel_id, kind, ref_id, status, attempts, last_error)
          values ($1, $2, 'INVENTORY', $3, 'FAILED', 8, 'HTTP 401')`, [m.id, channel, randomUUID()])
      }
      await asPlatform(db, support)
      const o = await value<{ stores: Array<{ id: string; failed_jobs: number; last_error: string }>; platform: Record<string, unknown> }>(db, `select public.platform_integrations_overview()`)
      const row = o.stores.find((s) => s.id === channel)!
      expect(row).toMatchObject({ failed_jobs: 2, last_error: 'Token revoked by the shop' })
      expect(JSON.stringify(o)).not.toMatch(/access_token|api_key|app_secret|password/i)
      await expectError(db, `select public.platform_integration_retry('store_jobs', $1)`, [channel], /PERMISSION_DENIED/)
      await asPlatform(db, tech)
      expect(await value(db, `select public.platform_integration_retry('store_jobs', $1, 'Shop re-authorised')`, [channel])).toEqual({ requeued: 2 })
      expect(await value(db, `select public.platform_integration_retry('store_jobs', $1)`, [channel])).toEqual({ requeued: 0 })
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and status = 'PENDING' and attempts = 0`, [channel])).toBe(2)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'integrations.retry' and entity_id = $1`, [channel])).toBe(2)
    }))
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

const asPlatform = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)

async function newMerchant(db: Db, superId: string, name = `Ops Shop ${randomUUID().slice(0, 6)}`): Promise<{ id: string; owner: string }> {
  await asPlatform(db, superId)
  const created = await value<{ id: string }>(db, `select public.platform_merchant_create($1)`, [JSON.stringify({ name })])
  await asSystem(db, null)
  const owner = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@shop.example`])
  await asPlatform(db, superId)
  await db.query(`select public.platform_merchant_set_owner($1, $2, 'Shop Owner')`, [created.id, owner])
  return { id: created.id, owner }
}

const brokenStore = (db: Db, merchant: string) =>
  db.query(`insert into public.sales_channels (merchant_id, platform, name, shop_domain, status) values ($1, 'SHOPIFY', 'Shop', $2, 'ERROR')`,
    [merchant, `ops-${randomUUID().slice(0, 6)}.myshopify.com`])

const ruleId = (db: Db, trigger: string) =>
  value<string>(db, `select id from public.platform_automation_rules where trigger = $1 and archived_at is null order by created_at limit 1`, [trigger])

type Component = { key: string; status: string; check: string; detail: string }

describe('system health', () => {
  it('reports how each part was checked, never "ok" without a measurement, and lets only health managers act', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const m = await newMerchant(db, superId)
      const merchantStaff = await createStaff(db, 'OWNER', undefined, m.id)

      await asSystem(db, null)
      await db.query(`update public.platform_settings set value = value || '{"connected": false}' where key = 'sms'`)
      await db.query(`delete from public.pbx_gateway_status`)

      await asPlatform(db, viewer)
      const h = await value<{ components: Component[]; can: { manage: boolean } }>(db, `select public.platform_health()`)
      expect(h.can.manage).toBe(false)
      for (const c of h.components) {
        expect(['ok', 'warn', 'down', 'idle', 'unknown']).toContain(c.status)
        expect(c.check.length).toBeGreaterThan(5)
      }
      const byKey = Object.fromEntries(h.components.map((c) => [c.key, c]))
      expect(byKey.database.status).toBe('ok')
      // Not connected is "down" (merchants cannot send); a gateway that never checked in is "idle", not healthy.
      expect(byKey.sms_provider).toMatchObject({ status: 'down', detail: expect.stringMatching(/Not connected/) })
      expect(byKey.pbx_gateway.status).toBe('idle')

      // A broken store shows up.
      await asSystem(db, null)
      await brokenStore(db, m.id)
      await asPlatform(db, viewer)
      const h2 = await value<{ components: Component[] }>(db, `select public.platform_health()`)
      expect(h2.components.find((c) => c.key === 'stores')!.status).toBe('warn')

      // The system log: filter, then resolve (managers only).
      await asSystem(db, null)
      const logId = Number(await value<string>(db, `insert into public.system_logs (merchant_id, level, category, source, message)
        values ($1, 'ERROR', 'WEBHOOK', 'shopify-webhook', 'Signature mismatch for ops test') returning id`, [m.id]))
      await asPlatform(db, viewer)
      const logs = await value<{ total: number; rows: Array<{ id: number; merchant: { id: string } }> }>(db,
        `select public.platform_system_logs($1)`, [JSON.stringify({ q: 'ops test', category: 'webhook' })])
      expect(logs.total).toBe(1)
      expect(logs.rows[0]).toMatchObject({ id: logId, merchant: { id: m.id } })
      await expectError(db, `select public.platform_system_logs_resolve($1::bigint[])`, [[logId]], /PERMISSION_DENIED/)
      await asPlatform(db, tech)
      expect(await value(db, `select public.platform_system_logs_resolve($1::bigint[], 'Shop rotated its secret')`, [[logId]])).toBe(1)
      expect(await value(db, `select public.platform_system_logs_resolve($1::bigint[])`, [[logId]])).toBe(0)

      // Merchant staff never reach the platform's health or logs.
      await asUser(db, merchantStaff, 'owner@shop.example', m.id)
      await expectError(db, `select public.platform_health()`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_system_logs()`, [], /PERMISSION_DENIED/)
    }))

  it('previews a bulk retry, then requeues each failed job once', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const m = await newMerchant(db, superId)
      await asSystem(db, null)
      const channel = await value<string>(db, `insert into public.sales_channels (merchant_id, platform, name, shop_domain, status)
        values ($1, 'SHOPIFY', 'Shop', $2, 'CONNECTED') returning id`, [m.id, `r-${randomUUID().slice(0, 6)}.myshopify.com`])
      const ref = randomUUID()
      await db.query(`insert into public.channel_sync_jobs (merchant_id, channel_id, kind, ref_id, status, attempts, last_error)
        values ($1, $2, 'INVENTORY', $3, 'FAILED', 8, 'HTTP 500'), ($1, $2, 'INVENTORY', $4, 'FAILED', 8, 'HTTP 500')`, [m.id, channel, ref, randomUUID()])
      // A newer job for the same item is already waiting: that failure is not retried.
      await db.query(`insert into public.channel_sync_jobs (merchant_id, channel_id, kind, ref_id, status) values ($1, $2, 'INVENTORY', $3, 'PENDING')`, [m.id, channel, ref])

      await asPlatform(db, viewer)
      await expectError(db, `select public.platform_health_retry('store_jobs', true)`, [], /PERMISSION_DENIED/)
      await asPlatform(db, tech)
      const preview = await value<{ count: number; merchants: Array<{ id: string }> }>(db, `select public.platform_health_retry('store_jobs', true)`)
      expect(preview.count).toBeGreaterThanOrEqual(1)
      expect(preview.merchants.map((x) => x.id)).toContain(m.id)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and status = 'FAILED'`, [channel])).toBe(2)

      await asPlatform(db, tech)
      await db.query(`select public.platform_health_retry('store_jobs', false, 'Shopify outage over')`)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and status = 'FAILED'`, [channel])).toBe(1)
      expect(await value(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and ref_id = $2 and status = 'PENDING'`, [channel, ref])).toBe(1)
      await asPlatform(db, tech)
      await expectError(db, `select public.platform_health_retry('orders', false)`, [], /nothing to retry/)
    }))
})

type Incident = { id: string; number: number; status: string; severity: string; mark_unavailable: boolean; merchants: Array<{ id: string }> | null
  updates?: Array<{ kind: string; body: string | null }> }

describe('incidents', () => {
  it('tracks an outage from report to resolution and shows the affected integration as unavailable meanwhile', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const agent = await createPlatformStaff(db, 'SUPPORT_AGENT')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const ops = await createPlatformStaff(db, 'OPERATIONS_MANAGER')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const hit = await newMerchant(db, superId)
      const fine = await newMerchant(db, superId)
      await asPlatform(db, superId)
      for (const m of [hit.id, fine.id]) {
        await db.query(`select public.platform_merchant_feature_set($1, 'shopify', true, 'Uses Shopify')`, [m])
      }
      const shopify = (m: string) => value<string>(db, `select public.merchant_entitlements($1) -> 'shopify' ->> 'state'`, [m])
      await asSystem(db, null)
      expect(await shopify(hit.id)).toBe('ENABLED')

      // Support agents report incidents; marking an integration unavailable needs incident management.
      await asPlatform(db, agent)
      const report = { title: 'Shopify orders not importing', severity: 'HIGH', integration: 'shopify', scope: 'SELECTED', merchants: [hit.id] }
      await expectError(db, `select public.platform_incident_create($1)`, [JSON.stringify({ ...report, mark_unavailable: true })], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_incident_create($1)`, [JSON.stringify({ ...report, severity: 'SEVERE' })], /severity/)
      await expectError(db, `select public.platform_incident_create($1)`, [JSON.stringify({ ...report, assigned_to: billing })], /cannot work on incidents/)
      const inc = await value<Incident>(db, `select public.platform_incident_create($1)`, [JSON.stringify({ ...report, assigned_to: tech })])
      expect(inc).toMatchObject({ status: 'INVESTIGATING', severity: 'HIGH', mark_unavailable: false })
      expect(inc.merchants?.map((x) => x.id)).toEqual([hit.id])

      // High severity alerts the people who work on incidents; the assignee is told it is theirs.
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1 and kind = 'incident.opened'`, [ops])).toBe(1)
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1 and kind = 'incident.assigned'`, [tech])).toBe(1)
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1`, [billing])).toBe(0)

      // Technical support confirms it and marks Shopify unavailable — for the affected merchant only.
      await asPlatform(db, tech)
      await db.query(`select public.platform_incident_update($1, '{"status": "IDENTIFIED", "mark_unavailable": true, "note": "Shopify API returns 503"}')`, [inc.id])
      await asSystem(db, null)
      expect(await shopify(hit.id)).toBe('UNAVAILABLE')
      expect(await shopify(fine.id)).toBe('ENABLED')

      await asPlatform(db, tech)
      await db.query(`select public.platform_incident_note($1, 'Shopify status page confirms the outage')`, [inc.id])
      await expectError(db, `select public.platform_incident_update($1, '{"status": "RESOLVED"}')`, [inc.id], /resolution/)
      const done = await value<Incident>(db, `select public.platform_incident_update($1, '{"status": "RESOLVED", "resolution": "Shopify recovered; imports caught up"}')`, [inc.id])
      expect(done.status).toBe('RESOLVED')
      await expectError(db, `select public.platform_incident_update($1, '{"severity": "LOW"}')`, [inc.id], /reopen/)
      await asSystem(db, null)
      expect(await shopify(hit.id)).toBe('ENABLED')

      // The timeline is complete and cannot be rewritten.
      await asPlatform(db, agent)
      const full = await value<Incident>(db, `select public.platform_incident_get($1)`, [inc.id])
      expect(full.updates!.map((u) => u.kind)).toEqual(['CREATED', 'STATUS', 'UNAVAILABLE', 'NOTE', 'STATUS'])
      expect(full.updates![4].body).toBe('Shopify recovered; imports caught up')
      await asSystem(db, null)
      await expectError(db, `delete from public.platform_incident_updates where incident_id = $1`, [inc.id], /./)

      // An outage for everyone applies to every merchant until resolved.
      await asPlatform(db, tech)
      const all = await value<Incident>(db, `select public.platform_incident_create($1)`, [JSON.stringify({ title: 'Platform SMS gateway down', severity: 'CRITICAL',
        integration: 'shopify', scope: 'ALL', mark_unavailable: true })])
      await asSystem(db, null)
      expect(await shopify(fine.id)).toBe('UNAVAILABLE')
      await asPlatform(db, tech)
      await db.query(`select public.platform_incident_update($1, '{"status": "RESOLVED", "resolution": "Recovered after failover"}')`, [all.id])
      await asSystem(db, null)
      expect(await shopify(fine.id)).toBe('ENABLED')

      // Merchants cannot read incidents.
      await asUser(db, hit.owner, 'owner@shop.example', hit.id)
      await expectError(db, `select public.platform_incidents_list()`, [], /PERMISSION_DENIED/)
      await expectError(db, `select count(*) from public.platform_incidents`, [], /permission denied/)
    }))
})

type RunResult = Array<{ rule: string; acted: number; failed: number; skipped: number }>

describe('automation rules', () => {
  it('acts once per subject per cooldown, caps each run and records every action', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const ops = await createPlatformStaff(db, 'OPERATIONS_MANAGER')
      const tech = await createPlatformStaff(db, 'TECHNICAL_SUPPORT')
      const a = await newMerchant(db, superId)
      const b = await newMerchant(db, superId)
      await asSystem(db, null)
      await brokenStore(db, a.id)
      await brokenStore(db, b.id)

      // Operations can draft a rule, but switching it on (it acts by itself) needs manage access.
      await asPlatform(db, ops)
      const draft = { name: 'Broken stores → tech', trigger: 'integration_failures', conditions: { min_errors: 3 },
        actions: [{ type: 'notify_staff', module: 'integrations', action: 'edit', severity: 'WARN' }], max_actions_per_run: 1 }
      await expectError(db, `select public.platform_automation_rule_save($1)`, [JSON.stringify({ ...draft, enabled: true })], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_automation_rule_save($1)`, [JSON.stringify({ ...draft, actions: [{ type: 'escalate_ticket' }] })], /does not fit/)
      await expectError(db, `select public.platform_automation_rule_save($1)`, [JSON.stringify({ ...draft, conditions: { hourz: 2 } })], /not a setting/)
      const rule = await value<{ id: string; enabled: boolean }>(db, `select public.platform_automation_rule_save($1)`, [JSON.stringify(draft)])
      expect(rule.enabled).toBe(false)

      // The dry run lists who it would act on and changes nothing.
      const dry = await value<{ matches: number; would_act: number; subjects: Array<{ key: string }> }>(db, `select public.platform_automation_test($1)`,
        [JSON.stringify({ id: rule.id })])
      expect(dry.subjects.map((s) => s.key)).toEqual(expect.arrayContaining([`merchant:${a.id}`, `merchant:${b.id}`]))
      expect(dry.would_act).toBe(1)
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_automation_runs where rule_id = $1`, [rule.id])).toBe(0)

      // Running needs manage access.
      await asPlatform(db, ops)
      await expectError(db, `select public.platform_automation_run($1)`, [rule.id], /PERMISSION_DENIED/)
      await asPlatform(db, superId)
      const first = await value<RunResult>(db, `select public.platform_automation_run($1)`, [rule.id])
      expect(first[0]).toMatchObject({ acted: 1, failed: 0 })
      const second = await value<RunResult>(db, `select public.platform_automation_run($1)`, [rule.id])
      expect(second[0].acted).toBe(1)
      // Both merchants are now in cooldown: nothing happens, however often it runs.
      const third = await value<RunResult>(db, `select public.platform_automation_run($1)`, [rule.id])
      expect(third[0]).toMatchObject({ acted: 0, failed: 0 })
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_automation_runs where rule_id = $1 and status = 'ACTED'`, [rule.id])).toBe(2)
      // Technical support (integrations.edit) was told once per merchant.
      expect(await value(db, `select count(*)::int from public.platform_notifications where user_id = $1 and kind = 'automation.integration_failures'
        and merchant_id = any($2::uuid[])`, [tech, [a.id, b.id]])).toBe(2)
      await expectError(db, `delete from public.platform_automation_runs where rule_id = $1`, [rule.id], /./)
    }))

  it('escalates an overdue ticket one step at a time and opens one incident per outage', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asUser(db, m.owner, 'owner@shop.example', m.id)
      const t = await value<{ id: string }>(db, `select to_jsonb(public.support_ticket_create($1))`, [JSON.stringify({
        kind: 'BUG', category: 'ORDERS', subject: 'Orders are stuck', body: 'Orders have not moved since yesterday', priority: 'HIGH' })])
      await asSystem(db, null)
      await db.query(`update public.support_tickets set due_at = now() - interval '2 hours' where id = $1`, [t.id])
      const overdue = await ruleId(db, 'ticket_overdue')

      await asPlatform(db, superId)
      await db.query(`select public.platform_automation_run($1)`, [overdue])
      await db.query(`select public.platform_automation_run($1)`, [overdue])
      await asSystem(db, null)
      const ticket = (await db.query(`select escalation_level, priority from public.support_tickets where id = $1`, [t.id])).rows[0]
      expect(ticket).toEqual({ escalation_level: 1, priority: 'URGENT' })
      expect(await value(db, `select count(*)::int from public.support_ticket_events where ticket_id = $1 and kind = 'ESCALATED'`, [t.id])).toBe(1)

      // A connected platform service failing more than it works opens one incident, not one per run.
      await db.query(`update public.platform_settings set value = value || '{"connected": true}' where key = 'sms'`)
      for (let i = 0; i < 4; i++) {
        await db.query(`insert into public.service_usage (merchant_id, service, status, units, charge, idempotency_key) values ($1, 'SMS', 'FAILED', 1, 'NONE', $2)`,
          [m.id, `ops-${randomUUID()}`])
      }
      const down = await ruleId(db, 'service_down')
      await asPlatform(db, superId)
      await db.query(`select public.platform_automation_run($1)`, [down])
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_incidents where dedupe_key like $1 and status <> 'RESOLVED'`, [`auto:${down}:service:sms`])).toBe(1)
      // The cron path runs as the system; the subject is in cooldown so nothing new happens.
      await db.query(`select public.platform_ops_run()`)
      expect(await value(db, `select count(*)::int from public.platform_incidents where dedupe_key like $1`, [`auto:${down}:service:sms`])).toBe(1)
    }))
})

type Announcement = { id: string; status: string; recipients: number | null; delivered: number }

describe('announcements', () => {
  it('previews the audience, refuses a stale preview, respects muted kinds and tracks reads', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const ops = await createPlatformStaff(db, 'OPERATIONS_MANAGER')
      const billing = await createPlatformStaff(db, 'BILLING_MANAGER')
      const a = await newMerchant(db, superId)
      const b = await newMerchant(db, superId)
      const c = await newMerchant(db, superId)
      const audience = { type: 'MERCHANTS', merchants: [a.id, b.id] }

      // b turns off feature news; service notices cannot be turned off.
      await asUser(db, b.owner, 'owner@shop.example', b.id)
      await expectError(db, `select public.announcement_preferences_save(array['MAINTENANCE'])`, [], /cannot be turned off/)
      await db.query(`select public.announcement_preferences_save(array['FEATURE'])`)
      await expectError(db, `select public.platform_announcement_preview($1)`, [JSON.stringify(audience)], /PERMISSION_DENIED/)

      await asPlatform(db, billing)
      const preview = await value<{ count: number; muted: number }>(db, `select public.platform_announcement_preview($1, 'FEATURE')`, [JSON.stringify(audience)])
      expect(preview).toMatchObject({ count: 2, muted: 1 })
      await expectError(db, `select public.platform_announcement_save($1)`, [JSON.stringify({ kind: 'FEATURE', title: 'Hi', body: 'x', audience })], /title and a message/)
      await expectError(db, `select public.platform_announcement_save($1)`, [JSON.stringify({ kind: 'FEATURE', title: 'New labels', body: 'Try them', link: 'javascript:alert(1)', audience })], /links go to/)
      const feature = await value<Announcement>(db, `select public.platform_announcement_save($1)`, [JSON.stringify({
        kind: 'FEATURE', title: 'New label designer', body: 'Design labels your way under Settings → Labels.', link: '/admin/settings/labels', audience })])
      // Billing staff draft; sending needs notifications manage.
      await expectError(db, `select public.platform_announcement_send($1, 2)`, [feature.id], /PERMISSION_DENIED/)

      await asPlatform(db, ops)
      await expectError(db, `select public.platform_announcement_send($1, 3)`, [feature.id], /preview it again/)
      const sent = await value<Announcement>(db, `select public.platform_announcement_send($1, 2, 'Launch')`, [feature.id])
      expect(sent).toMatchObject({ status: 'SENT', recipients: 1, delivered: 2 })
      await expectError(db, `select public.platform_announcement_send($1, 2)`, [feature.id], /only a draft/)
      const maint = await value<Announcement>(db, `select public.platform_announcement_save($1)`, [JSON.stringify({
        kind: 'MAINTENANCE', severity: 'WARN', title: 'Maintenance tonight', body: 'Order sync pauses 02:00–02:30.', audience })])
      await db.query(`select public.platform_announcement_send($1, 2)`, [maint.id])

      type Mine = { items: Array<{ id: string; kind: string; read: boolean }>; muted: string[] }
      await asUser(db, a.owner, 'owner@shop.example', a.id)
      let mine = await value<Mine>(db, `select public.my_announcements()`)
      expect(mine.items.map((i) => i.kind).sort()).toEqual(['FEATURE', 'MAINTENANCE'])
      await db.query(`select public.announcement_mark_read($1)`, [feature.id])
      await db.query(`select public.announcement_mark_read($1)`, [feature.id])
      mine = await value<Mine>(db, `select public.my_announcements()`)
      expect(mine.items.find((i) => i.id === feature.id)!.read).toBe(true)

      // b muted feature news but still gets maintenance notices.
      await asUser(db, b.owner, 'owner@shop.example', b.id)
      mine = await value<Mine>(db, `select public.my_announcements()`)
      expect(mine.items.map((i) => i.kind)).toEqual(['MAINTENANCE'])
      expect(mine.muted).toEqual(['FEATURE'])
      await expectError(db, `select public.announcement_mark_read($1)`, [feature.id], /NOT_FOUND/)

      // c was not in the audience.
      await asUser(db, c.owner, 'owner@shop.example', c.id)
      expect((await value<Mine>(db, `select public.my_announcements()`)).items).toEqual([])

      await asPlatform(db, ops)
      const detail = await value<{ deliveries: Array<{ merchant: { id: string }; status: string; readers: number }> }>(db,
        `select public.platform_announcement_get($1)`, [feature.id])
      expect(detail.deliveries.find((d) => d.merchant.id === a.id)).toMatchObject({ status: 'DELIVERED', readers: 1 })
      expect(detail.deliveries.find((d) => d.merchant.id === b.id)).toMatchObject({ status: 'MUTED', readers: 0 })

      // Withdrawn notices disappear for merchants.
      await db.query(`select public.platform_announcement_cancel($1, 'Moved to next week')`, [maint.id])
      await asUser(db, a.owner, 'owner@shop.example', a.id)
      expect((await value<Mine>(db, `select public.my_announcements()`)).items.map((i) => i.kind)).toEqual(['FEATURE'])
    }))

  it('publishes a scheduled announcement from the ops job', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const m = await newMerchant(db, superId)
      await asPlatform(db, superId)
      const later = await value<Announcement>(db, `select public.platform_announcement_save($1)`, [JSON.stringify({
        kind: 'SUBSCRIPTION', title: 'New plans next month', body: 'Prices change on the 1st.', audience: { type: 'MERCHANTS', merchants: [m.id] },
        publish_at: new Date(Date.now() + 3600_000).toISOString() })])
      const scheduled = await value<Announcement>(db, `select public.platform_announcement_send($1, 1)`, [later.id])
      expect(scheduled.status).toBe('SCHEDULED')
      await asSystem(db, null)
      await db.query(`select public.platform_ops_run()`)
      expect(await value(db, `select status from public.platform_announcements where id = $1`, [later.id])).toBe('SCHEDULED')
      await db.query(`update public.platform_announcements set publish_at = now() - interval '1 minute' where id = $1`, [later.id])
      await db.query(`select public.platform_ops_run()`)
      expect(await value(db, `select status from public.platform_announcements where id = $1`, [later.id])).toBe('SENT')
      expect(await value(db, `select count(*)::int from public.platform_announcement_deliveries where announcement_id = $1`, [later.id])).toBe(1)
    }))
})

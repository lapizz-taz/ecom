import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asSystem, asUser, closePool, inTx, value } from '../support/db'
import { advanceOrder, createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'
import { PHONE_A, callEach, callable, storeIds, type Target } from '../support/sweep'

afterAll(closePool)

/**
 * Every built-in staff role calls every function it may call, with its own store's ids (ids only,
 * then filled), and the sweep notes which tables each successful call wrote to (inserted, updated
 * or deleted rows, read from the transaction's own counters). A write must be backed by one of the
 * role's permissions that is more than "view", named by the function; apart from that, a role only
 * writes its own records (check-in, profile, an error report, a support ticket, the contact form)
 * or an audit entry on its own.
 */

/** The sweep reads the Postgres catalogs and statistics, which the Cloudflare engine does not have. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

const ROLES = ['VIEWER', 'CALL', 'MODERATOR', 'PRODUCTION_MANAGER', 'INVENTORY_MANAGER', 'FINANCE_MANAGER', 'ORDER_MANAGER', 'MANAGER']

/** What any staff member may write for themselves, and where. */
const OWN: Record<string, string[]> = {
  hr_check_in: ['hr_attendance'],
  log_client_error: ['system_logs'],
  report_issue: ['support_tickets', 'support_ticket_events', 'system_logs'],
  submit_contact_message: ['contact_messages'],
  update_my_profile: ['profiles', 'audit_logs'],
}

/** What a signed-out visitor may write through: the contact forms, the cart, visit tracking and sign-up. */
const PUBLIC_WRITERS = ['submit_contact_message', 'platform_contact_submit', 'public_lead_touch', 'public_signup_request',
  'storefront_cart_sync', 'storefront_cart_restore', 'track_storefront_event', 'track_visit_event', 'storefront_ad_tracking']

/** Super Admin roles; each writes only within its platform permissions (module.action, more than "view"). */
const PLATFORM_ROLES = ['VIEWER', 'SUPPORT_AGENT', 'BILLING_MANAGER', 'TECHNICAL_SUPPORT', 'PBX_ADMIN', 'OPERATIONS_MANAGER']

/** Rows inserted, updated or deleted so far in this transaction, per table. */
const WRITES = `select coalesce(jsonb_object_agg(relname, n_tup_ins + n_tup_upd + n_tup_del), '{}')
  from pg_catalog.pg_stat_xact_user_tables where schemaname = 'public'`

describe('role write sweep', () => {
  it.skipIf(onEngine)('lets each role write only what its permissions allow, through any function', { timeout: 900_000 }, () =>
    inTx(async (db) => {
      const product = await createProduct(db, { name: 'Write sweep product', price: 900, cost: 400, stock: 9 })
      const delivered = await createOrder(db, { phone: '01711999004', items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, delivered.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
      const open = await createOrder(db, { phone: PHONE_A, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      const owner = await createStaff(db, 'OWNER')

      await asSystem(db)
      const ids = await storeIds(db, MERCHANT_1)
      const a: Target = { order: open.id, product: product.productId, variant: product.variantIds[0], customer: open.customer_id, owner, merchant: MERCHANT_1 }
      const fns = await callable(db, 'authenticated')
      const perms = new Map((await db.query<{ code: string; perms: string[] }>(
        `select r.code, coalesce(array_agg(p.code) filter (where p.code is not null), '{}') as perms
           from public.roles r left join public.role_permissions rp on rp.role_id = r.id left join public.permissions p on p.id = rp.permission_id
          where r.merchant_id = $1 group by r.code`, [MERCHANT_1])).rows.map((r) => [r.code, r.perms]))
      // The permission codes a function names (its own body and, for a cost-clearing wrapper, the _raw_ one).
      const named = new Map((await db.query<{ name: string; perms: string[] }>(
        `select f.proname as name, coalesce(array_agg(distinct m[1]) filter (where m[1] is not null), '{}') as perms
           from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           left join pg_proc raw on raw.proname = '_raw_' || f.proname and raw.pronamespace = n.oid
           left join lateral regexp_matches(f.prosrc || coalesce(raw.prosrc, ''), '''([a-z_]+\\.[a-z_]+)''', 'g') m on true
          where n.nspname = 'public' group by f.proname`)).rows.map((r) => [r.name, r.perms]))
      await db.query(`set local statement_timeout = '5s'`)

      const problems: string[] = []
      const wrote = new Set<string>()
      for (const role of ROLES) {
        expect(perms.has(role)).toBe(true)
        const may = new Set((perms.get(role) ?? []).filter((p) => !p.endsWith('.view')))
        await asUser(db, await createStaff(db, role))
        let before: Record<string, number> = {}
        await callEach(db, fns, ids, a, async (c) => {
          if (c.failed) return
          const after = await value<Record<string, number>>(db, WRITES)
          const tables = Object.keys(after).filter((t) => after[t] !== (before[t] ?? 0)).sort()
          if (!tables.length) return
          wrote.add(`${role} ${c.fn}`)
          const allowed = (named.get(c.fn) ?? []).some((p) => may.has(p))
            || (OWN[c.fn] && tables.every((t) => OWN[c.fn].includes(t)))
            || tables.every((t) => t === 'audit_logs')
          if (!allowed) problems.push(`${role} ${c.fn}(${c.filled ? 'filled' : 'ids'}) wrote ${tables.join(', ')} without a permission it names (${(named.get(c.fn) ?? []).join(', ') || 'none'})`)
        }, async () => { before = await value<Record<string, number>>(db, WRITES) })
        await asSystem(db)
      }
      expect([...new Set(problems)]).toEqual([])
      // The sweep reached real writes: the read-only role its own profile, others their daily work.
      for (const w of ['VIEWER update_my_profile', 'CALL add_order_note', 'ORDER_MANAGER approve_orders', 'FINANCE_MANAGER record_order_payment', 'INVENTORY_MANAGER adjust_stock']) {
        expect(wrote).toContain(w)
      }
    }))

  it.skipIf(onEngine)('lets a signed-out visitor write only through the public forms, the cart and tracking', { timeout: 300_000 }, () =>
    inTx(async (db) => {
      const product = await createProduct(db, { name: 'Visitor sweep product', price: 900, stock: 9 })
      const open = await createOrder(db, { phone: PHONE_A, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      const ids = await storeIds(db, MERCHANT_1)
      const a: Target = { order: open.id, product: product.productId, variant: product.variantIds[0], customer: open.customer_id, owner, merchant: MERCHANT_1 }
      const fns = await callable(db, 'anon')
      await db.query(`set local statement_timeout = '5s'`)
      await asAnon(db, MERCHANT_1)
      const problems: string[] = []
      let before: Record<string, number> = {}
      const r = await callEach(db, fns, ids, a, async (c) => {
        if (c.failed) return
        const after = await value<Record<string, number>>(db, WRITES)
        const tables = Object.keys(after).filter((t) => after[t] !== (before[t] ?? 0))
        if (tables.length && !PUBLIC_WRITERS.includes(c.fn)) problems.push(`visitor ${c.fn} wrote ${tables.sort().join(', ')}`)
      }, async () => { before = await value<Record<string, number>>(db, WRITES) })
      expect(problems).toEqual([])
      expect(r.answered).toBeGreaterThan(50)
    }))

  it.skipIf(onEngine)('lets each Super Admin role write only what its platform permissions allow, through any function', { timeout: 900_000 }, () =>
    inTx(async (db) => {
      const product = await createProduct(db, { name: 'Platform sweep product', price: 900, cost: 400, stock: 9 })
      const open = await createOrder(db, { phone: PHONE_A, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      const ids = await storeIds(db, MERCHANT_1)
      const a: Target = { order: open.id, product: product.productId, variant: product.variantIds[0], customer: open.customer_id, owner, merchant: MERCHANT_1 }
      const fns = await callable(db, 'authenticated')
      const perms = new Map((await db.query<{ code: string; perms: string[] }>(
        `select r.code, coalesce(array_agg(p.module || '.' || p.action) filter (where p.module is not null), '{}') as perms
           from public.platform_roles r left join public.platform_role_permissions p on p.role_id = r.id group by r.code`)).rows.map((r) => [r.code, r.perms]))
      // module.action pairs a function checks; module.* where the action is worked out (create or edit).
      const named = new Map((await db.query<{ name: string; perms: string[] }>(
        `select f.proname as name, coalesce(array_agg(distinct m[1] || '.' || coalesce(m[2], '*')) filter (where m[1] is not null), '{}') as perms
           from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           left join lateral regexp_matches(f.prosrc, '(?:_platform_require|platform_can)\\(''([a-z_]+)'',\\s*(?:''([a-z]+)''|case)', 'g') m on true
          where n.nspname = 'public' group by f.proname`)).rows.map((r) => [r.name, r.perms]))
      await db.query(`set local statement_timeout = '5s'`)

      const problems: string[] = []
      const wrote = new Set<string>()
      for (const role of PLATFORM_ROLES) {
        expect(perms.has(role)).toBe(true)
        const may = (perms.get(role) ?? []).filter((p) => !p.endsWith('.view'))
        const allowedBy = (p: string) => (p.endsWith('.*') ? may.some((m) => m.startsWith(p.slice(0, -1))) : may.includes(p))
        await asUser(db, await createPlatformStaff(db, role), 'staff@platform.example', null)
        let before: Record<string, number> = {}
        await callEach(db, fns, ids, a, async (c) => {
          if (c.failed) return
          const after = await value<Record<string, number>>(db, WRITES)
          const tables = Object.keys(after).filter((t) => after[t] !== (before[t] ?? 0)).sort()
          if (!tables.length) return
          wrote.add(`${role} ${c.fn}`)
          const allowed = (named.get(c.fn) ?? []).some(allowedBy)
            || (c.fn === 'platform_me' && tables.every((t) => t === 'platform_staff')) // the caller's own "last seen"
            || tables.every((t) => t === 'platform_audit_logs' || t === 'audit_logs')
          if (!allowed) problems.push(`${role} ${c.fn}(${c.filled ? 'filled' : 'ids'}) wrote ${tables.join(', ')} without a platform permission it names (${(named.get(c.fn) ?? []).join(', ') || 'none'})`)
        }, async () => { before = await value<Record<string, number>>(db, WRITES) })
        await asSystem(db)
      }
      expect([...new Set(problems)]).toEqual([])
      for (const w of ['PBX_ADMIN platform_pbx_settings_save', 'OPERATIONS_MANAGER platform_merchant_note_add', 'BILLING_MANAGER platform_order_fee_override_set']) {
        expect(wrote).toContain(w)
      }
    }))
})

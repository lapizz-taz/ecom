import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

/** A second merchant with the same defaults a new business starts with. */
async function createMerchant(db: Db, name = `Shop ${randomUUID().slice(0, 6)}`): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [name])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  return id
}

type List = { total: number; items: Array<{ id: string }> }
const searchOrders = (db: Db) => value<List>(db, `select public.admin_search_orders('{}'::jsonb, 'created_at', 'desc', 100, 0)`)

describe('tenancy: structure', () => {
  it('gives every table a merchant and an isolation policy, except listed shared reference data', () =>
    inTx(async (db) => {
      await asSystem(db)
      const missing = await value<string[] | null>(db, `
        select array_agg(c.relname order by c.relname) from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and c.relname <> all (public._tenancy_global_tables())
          and (not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'merchant_id' and not a.attisdropped)
               or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                              and p.policyname = 'tenant_isolation' and p.permissive = 'RESTRICTIVE'))`)
      expect(missing).toBeNull()
      expect(await value(db, `select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`)).toBe(0)
    }))

  it('runs business functions as app_owner, which cannot bypass row-level security', () =>
    inTx(async (db) => {
      await asSystem(db)
      expect(await value(db, `select rolbypassrls from pg_roles where rolname = 'app_owner'`)).toBe(false)
      const wrongOwner = await value<string[] | null>(db, `
        select array_agg(p.proname order by p.proname) from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proowner <> 'app_owner'::regrole
          and not exists (select 1 from public.tenancy_exempt_functions e where e.name = p.proname)`)
      expect(wrongOwner).toBeNull()
      // The exempt list is short and every entry exists.
      const exempt = await value<number>(db, `select count(*)::int from public.tenancy_exempt_functions e
        where exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = e.name)`)
      expect(exempt).toBe(await value(db, `select count(*)::int from public.tenancy_exempt_functions`))
      // Outside the Super Admin functions (which check platform permissions themselves) the list stays short.
      expect(await value(db, `select count(*)::int from public.tenancy_exempt_functions where name !~ '^_?platform_'`)).toBeLessThan(80)
    }))

  it('turns existing data into Merchant #1', () =>
    inTx(async (db) => {
      await asSystem(db)
      expect(await one(db, `select number, status from public.merchants where id = $1`, [MERCHANT_1])).toEqual({ number: '1', status: 'ACTIVE' })
      expect(await value(db, `select count(*)::int from public.roles where merchant_id = $1`, [MERCHANT_1])).toBe(8)
      expect(await value(db, `select count(*)::int from public.settings where merchant_id <> $1`, [MERCHANT_1])).toBe(0)
    }))
})

describe('tenancy: a new merchant', () => {
  it('starts with its own roles, statuses, categories, templates and settings — none of Merchant #1\'s data', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      await asSystem(db, null)
      const counts = await one<Record<string, number>>(db, `
        select (select count(*)::int from public.roles where merchant_id = $1) as roles,
               (select count(*)::int from public.role_permissions where merchant_id = $1) as role_permissions,
               (select count(*)::int from public.order_review_statuses where merchant_id = $1) as review,
               (select count(*)::int from public.order_sources where merchant_id = $1) as sources,
               (select count(*)::int from public.finance_categories where merchant_id = $1) as finance,
               (select count(*)::int from public.fraud_rule_actions where merchant_id = $1) as fraud_actions,
               (select count(*)::int from public.notifications where merchant_id = $1) as templates,
               (select count(*)::int from public.settings where merchant_id = $1) as settings,
               (select count(*)::int from public.orders where merchant_id = $1) as orders,
               (select count(*)::int from public.products where merchant_id = $1) as products`, [m2])
      expect(counts).toEqual({ roles: 8, role_permissions: 137, review: 8, sources: 9, finance: 29, fraud_actions: 7, templates: 36, settings: 24, orders: 0, products: 0 })
      // Running it again changes nothing; running it for another merchant is refused.
      await asSystem(db, m2)
      await db.query(`select public._merchant_seed_defaults($1)`, [m2])
      expect(await value(db, `select count(*)::int from public.roles where merchant_id = $1`, [m2])).toBe(8)
      await expectError(db, `select public._merchant_seed_defaults($1)`, [MERCHANT_1], /PERMISSION_DENIED/)
    }))

  it('can have the same customer phone, product slug, SKU, coupon code and order number as Merchant #1', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const sku = `SAME-${randomUUID().slice(0, 6)}`
      const p1 = await createProduct(db, { name: 'Same Tee', price: 500, variants: [{ sku, title: 'M', stock: 5 }] })
      const p2 = await createProduct(db, { name: 'Same Tee', price: 500, variants: [{ sku, title: 'M', stock: 5 }], merchantId: m2 })
      // Changes run inside the row's merchant (audit entries are written for that merchant).
      await asSystem(db, MERCHANT_1)
      await db.query(`update public.products set slug = 'same-tee' where id = $1`, [p1.productId])
      await asSystem(db, m2)
      await db.query(`update public.products set slug = 'same-tee' where id = $1`, [p2.productId])
      await asSystem(db, null)
      // Without a merchant, even the database owner cannot change rows whose triggers write merchant data.
      await expectError(db, `update public.products set slug = 'moved' where id = $1`, [p1.productId], /row-level security/)
      const same = await db.query(`select merchant_id, slug from public.products where id = any($1)`, [[p1.productId, p2.productId]])
      expect(same.rows.map((r) => r.slug)).toEqual(['same-tee', 'same-tee'])
      expect(await value(db, `select count(distinct merchant_id)::int from public.product_variants where sku = $1`, [sku])).toBe(2)
      const o1 = await createOrder(db, { phone: '01711000901', items: [{ variantId: p1.variantIds[0], quantity: 1 }] })
      const o2 = await createOrder(db, { phone: '01711000901', items: [{ variantId: p2.variantIds[0], quantity: 1 }], merchantId: m2 })
      await asSystem(db, null)
      const customers = await db.query(`select merchant_id from public.customers where id = any($1)`, [[o1.customer_id, o2.customer_id]])
      expect(customers.rows.map((r) => r.merchant_id).sort()).toEqual([MERCHANT_1, m2].sort())
      for (const m of [MERCHANT_1, m2]) {
        await asSystem(db, m)
        await db.query(`insert into public.coupons (code, discount_type, discount_value) values ('TWIN', 'FIXED', 10)`)
      }
      await expectError(db, `insert into public.coupons (code, discount_type, discount_value) values ('TWIN', 'FIXED', 10)`, [], /coupons_code_key/)
      // A store-provided order number (WooCommerce, Shopify) may repeat across merchants, never within one.
      await asSystem(db, m2)
      await db.query(`update public.orders set order_number = $1 where id = $2`, [o1.order_number, o2.id])
      const o3 = await createOrder(db, { phone: '01711000902', items: [{ variantId: p1.variantIds[0], quantity: 1 }] })
      await expectError(db, `update public.orders set order_number = $1 where id = $2`, [o1.order_number, o3.id], /orders_order_number_key/)
    }))
})

describe('tenancy: isolation', () => {
  it('shows staff only their own merchant\'s rows — in tables, views and functions', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const p1 = await createProduct(db, { price: 400 })
      const p2 = await createProduct(db, { price: 400, merchantId: m2 })
      const o1 = await createOrder(db, { phone: '01711000911', items: [{ variantId: p1.variantIds[0], quantity: 1 }] })
      const o2 = await createOrder(db, { phone: '01711000912', items: [{ variantId: p2.variantIds[0], quantity: 1 }], merchantId: m2 })
      const owner2 = await createStaff(db, 'OWNER', undefined, m2)
      const owner1 = await createStaff(db, 'OWNER')

      await asUser(db, owner2)
      expect(await value(db, `select public.current_merchant_id()`)).toBe(m2)
      expect((await db.query(`select id from public.orders`)).rows.map((r) => r.id)).toEqual([o2.id])
      expect(await value(db, `select count(*)::int from public.products where id = $1`, [p1.productId])).toBe(0)
      expect(await value(db, `select count(*)::int from public.customers where phone = '01711000911'`)).toBe(0)
      expect(await value(db, `select count(*)::int from public.v_order_statistics`)).toBeGreaterThanOrEqual(0)
      const list = await searchOrders(db)
      expect(list.items.map((i) => i.id)).toEqual([o2.id])
      expect(await value(db, `select count(*)::int from public.settings where key = 'store'`)).toBe(1)
      expect(await value(db, `select merchant_id from public.settings where key = 'store'`)).toBe(m2)

      await asUser(db, owner1)
      const list1 = await searchOrders(db)
      expect(list1.items.map((i) => i.id)).toContain(o1.id)
      expect(list1.items.map((i) => i.id)).not.toContain(o2.id)
      expect(await value(db, `select count(*)::int from public.orders where id = $1`, [o2.id])).toBe(0)
    }))

  it('refuses to write another merchant\'s rows, or to write rows into another merchant', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const p1 = await createProduct(db, { price: 300 })
      const owner2 = await createStaff(db, 'OWNER', undefined, m2)
      await asUser(db, owner2)
      // Updating or deleting by id silently matches nothing: the row does not exist for them.
      expect((await db.query(`update public.products set name = 'hijacked' where id = $1`, [p1.productId])).rowCount).toBe(0)
      expect((await db.query(`delete from public.categories where merchant_id = $1`, [MERCHANT_1])).rowCount).toBe(0)
      // Naming another merchant on insert is rejected by the database.
      await expectError(db, `insert into public.categories (merchant_id, name, slug) values ($1, 'X', 'x')`, [MERCHANT_1], /row-level security/)
      await db.query(`insert into public.categories (name, slug) values ('Mine', 'mine')`)
      await expectError(db, `update public.categories set merchant_id = $1 where slug = 'mine'`, [MERCHANT_1], /row-level security/)
      // Business functions see the same wall: another merchant's order is "not found".
      await asSystem(db)
      const o1 = await createOrder(db, { phone: '01711000913', items: [{ variantId: p1.variantIds[0], quantity: 1 }] })
      await asUser(db, owner2)
      await expectError(db, `select public.transition_order_status($1, 'CANCELLED', 'test')`, [o1.id], /not found|NOT_FOUND/i)
      await asSystem(db)
      expect(await value(db, `select name from public.products where id = $1`, [p1.productId])).not.toBe('hijacked')
      expect(await value(db, `select status::text from public.orders where id = $1`, [o1.id])).not.toBe('CANCELLED')
    }))

  it('ignores a merchant header or setting sent by staff; their account decides', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const owner1 = await createStaff(db, 'OWNER')
      await asUser(db, owner1, 'owner@example.com', m2)
      expect(await value(db, `select public.current_merchant_id()`)).toBe(MERCHANT_1)
      await db.query(`select set_config('app.merchant_id', $1, true)`, [m2])
      expect(await value(db, `select public.current_merchant_id()`)).toBe(MERCHANT_1)
    }))

  it('lets platform functions act for a merchant only when the caller is active platform staff', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      await asSystem(db, null)
      const id = randomUUID()
      await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `ops-${id.slice(0, 6)}@platform.example`])
      await db.query(`insert into public.platform_staff (user_id, email, role_id) values ($1, 'ops@platform.example', (select id from public.platform_roles where code = 'SUPPORT_AGENT'))`, [id])
      await asUser(db, id, 'ops@platform.example', null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      await db.query(`select set_config('app.merchant_id', $1, true)`, [m2])
      expect(await value(db, `select public.current_merchant_id()`)).toBe(m2)
      await asSystem(db, null)
      await db.query(`update public.platform_staff set is_active = false where user_id = $1`, [id])
      await asUser(db, id, 'ops@platform.example', null)
      await db.query(`select set_config('app.merchant_id', $1, true)`, [m2])
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
    }))

  it('gives storefront visitors the merchant named by the store, and nothing without one', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const name = `Visible ${randomUUID().slice(0, 6)}`
      await createProduct(db, { name, price: 250, merchantId: m2 })
      await asAnon(db, m2)
      const found = await value<{ items: Array<{ name: string }> }>(db, `select public.storefront_list_products(p_search => $1)`, [name])
      expect(found.items.map((i) => i.name)).toEqual([name])
      await asAnon(db, MERCHANT_1)
      expect((await value<{ items: unknown[] }>(db, `select public.storefront_list_products(p_search => $1)`, [name])).items).toEqual([])
      await asAnon(db, null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      expect((await value<{ items: unknown[] }>(db, `select public.storefront_list_products(p_search => $1)`, [name])).items).toEqual([])
      // A closed merchant's store is gone.
      await asSystem(db, null)
      await db.query(`update public.merchants set status = 'CLOSED' where id = $1`, [m2])
      await asAnon(db, m2)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
    }))

  it('fails closed for server calls that do not name a merchant', () =>
    inTx(async (db) => {
      await createProduct(db, { price: 100 })
      await asService(db, null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      expect((await value<{ items: unknown[] }>(db, `select public.storefront_list_products()`)).items).toEqual([])
      // Even the service role (which bypasses row-level security) cannot create a row without a merchant.
      await expectError(db, `insert into public.categories (name, slug) values ('Orphan', 'orphan')`, [], /null value in column "merchant_id"/)
      // ...but the platform can still record an error that belongs to no merchant.
      const logId = await value<number>(db, `select public.log_system_event('ERROR', 'WEBHOOK', 'test', 'unknown shop', '{}')`)
      await asSystem(db, null)
      expect(await value(db, `select merchant_id from public.system_logs where id = $1`, [logId])).toBeNull()
      const owner1 = await createStaff(db, 'OWNER')
      await asUser(db, owner1)
      expect(await value(db, `select count(*)::int from public.system_logs where id = $1`, [logId])).toBe(0)
    }))

  it('keeps Vault credentials per merchant', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const owner1 = await createStaff(db, 'OWNER')
      await asService(db)
      await db.query(`select public.integration_secret_store('tenancy_test', '{"api_key":"m1-secret"}', '••••cret', $1)`, [owner1])
      expect(await value(db, `select public.integration_secret_get('tenancy_test')`)).toEqual({ api_key: 'm1-secret' })
      await asService(db, m2)
      expect(await value(db, `select public.integration_secret_get('tenancy_test')`)).toBeNull()
      await asService(db, null)
      expect(await value(db, `select public.integration_secret_get('tenancy_test')`)).toBeNull()
      await expectError(db, `select public.integration_secret_store('tenancy_test', '{}', null, null)`, [], /MERCHANT_REQUIRED/)
      // Couriers: another merchant's courier is "not found".
      await asSystem(db)
      const courier = await value<string>(db, `select id from public.couriers limit 1`)
      await asService(db, m2)
      await expectError(db, `select public.courier_credentials_get($1)`, [courier], /NOT_FOUND/)
    }))

  it('keeps one login in one business', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const staff1 = await createStaff(db, 'ORDER_MANAGER')
      await asSystem(db, m2)
      await expectError(db, `select public.admin_set_user_role($1, 'VIEWER', true)`, [staff1], /another business/)
      await asSystem(db, null)
      await expectError(db, `select public.grant_owner('nobody-here@example.com')`, [], /NOT_FOUND/)
    }))
})

describe('tenancy: platform support sessions', () => {
  async function platformStaff(db: Db): Promise<string> {
    await asSystem(db, null)
    const id = randomUUID()
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `support-${id.slice(0, 6)}@platform.example`])
    await db.query(`insert into public.platform_staff (user_id, email, role_id) values ($1, $2, (select id from public.platform_roles where code = 'SUPPORT_AGENT'))`, [id, `support-${id.slice(0, 6)}@platform.example`])
    return id
  }

  it('lets support view a merchant read-only for a limited time, then nothing', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const p2 = await createProduct(db, { price: 700, merchantId: m2 })
      const o2 = await createOrder(db, { phone: '01711000921', items: [{ variantId: p2.variantIds[0], quantity: 1 }], merchantId: m2 })
      const agent = await platformStaff(db)

      // Without a session the agent is nobody.
      await asUser(db, agent, 'agent@example.com', null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      expect(await value(db, `select public.is_staff()`)).toBe(false)

      await asSystem(db, null)
      const session = await value<string>(db, `insert into public.support_sessions (staff_user_id, merchant_id, reason, expires_at)
        values ($1, $2, 'Customer asked why order is stuck', now() + interval '30 minutes') returning id`, [agent, m2])

      await asUser(db, agent, 'agent@example.com', null)
      expect(await value(db, `select public.current_merchant_id()`)).toBe(m2)
      expect(await value(db, `select public.is_staff()`)).toBe(true)
      expect(await value(db, `select public.has_permission('orders.view')`)).toBe(true)
      expect(await value(db, `select public.has_permission('orders.update')`)).toBe(false)
      expect((await searchOrders(db)).items.map((i) => i.id)).toEqual([o2.id])
      // Read-only: direct writes are refused by the database, even where a policy would allow staff.
      await expectError(db, `insert into public.categories (name, slug) values ('Support was here', 'support-was-here')`, [], /row-level security/)
      expect((await db.query(`delete from public.categories`)).rowCount).toBe(0)

      // Expired or ended: back to nothing.
      await asSystem(db, null)
      await db.query(`update public.support_sessions set ended_at = now(), end_reason = 'done' where id = $1`, [session])
      await asUser(db, agent, 'agent@example.com', null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      expect(await value(db, `select count(*)::int from public.orders`)).toBe(0)
    }))

  it('needs a second person to approve a session that can change data, and caps sessions at 4 hours', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const agent = await platformStaff(db)
      const other = await platformStaff(db)
      await asSystem(db, null)
      await expectError(db, `insert into public.support_sessions (staff_user_id, merchant_id, mode, reason, expires_at)
        values ($1, $2, 'ASSIST', 'Fix a broken courier setup', now() + interval '1 hour')`, [agent, m2], /support_sessions_check/)
      await expectError(db, `insert into public.support_sessions (staff_user_id, merchant_id, mode, reason, expires_at, approved_by)
        values ($1, $2, 'ASSIST', 'Fix a broken courier setup', now() + interval '1 hour', $1)`, [agent, m2], /support_sessions_check/)
      await expectError(db, `insert into public.support_sessions (staff_user_id, merchant_id, reason, expires_at)
        values ($1, $2, 'Look around', now() + interval '5 hours')`, [agent, m2], /support_sessions_check/)
      await db.query(`insert into public.support_sessions (staff_user_id, merchant_id, mode, permissions, reason, expires_at, approved_by)
        values ($1, $2, 'ASSIST', '{products.manage}', 'Fix a broken category setup', now() + interval '1 hour', $3)`, [agent, m2, other])
      await asUser(db, agent, 'agent@example.com', null)
      expect(await value(db, `select public.has_permission('products.manage')`)).toBe(true)
      expect(await value(db, `select public.has_permission('finance.manage')`)).toBe(false)
      await db.query(`insert into public.categories (name, slug) values ('Assisted', 'assisted')`)
      await asSystem(db, null)
      expect(await value(db, `select merchant_id from public.categories where slug = 'assisted'`)).toBe(m2)
    }))

  it('is never available to someone who is not active platform staff', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const agent = await platformStaff(db)
      await asSystem(db, null)
      await db.query(`insert into public.support_sessions (staff_user_id, merchant_id, reason, expires_at)
        values ($1, $2, 'Look at an order', now() + interval '30 minutes')`, [agent, m2])
      await db.query(`update public.platform_staff set is_active = false where user_id = $1`, [agent])
      await asUser(db, agent, 'agent@example.com', null)
      expect(await value(db, `select public.current_merchant_id()`)).toBeNull()
      // Merchant staff cannot read platform tables at all.
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select count(*) from public.support_sessions`, [], /permission denied/)
      await expectError(db, `select count(*) from public.platform_staff`, [], /permission denied/)
      expect(await value(db, `select count(*)::int from public.merchants`)).toBe(1)
    }))
})

describe('tenancy: scheduled jobs', () => {
  it('runs each job once per merchant, inside that merchant', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      await asSystem(db, null)
      const merchants = await value<number>(db, `select count(*)::int from public.merchants where status <> 'CLOSED'`)
      const result = await value<{ merchants: number; failed: number }>(db, `select public.for_each_merchant('expire_unpaid_advance_orders')`)
      expect(result).toEqual({ job: 'expire_unpaid_advance_orders', merchants, failed: 0 })
      expect(merchants).toBeGreaterThanOrEqual(2)
      expect(await value(db, `select current_setting('app.merchant_id', true)`)).toBe('')
      await expectError(db, `select public.for_each_merchant('drop_everything')`, [], /unknown job/)
      await asUser(db, await createStaff(db, 'OWNER', undefined, m2))
      await expectError(db, `select public.for_each_merchant('pbx_sweep')`, [], /permission denied/)
    }))

  it('counts money only inside one merchant', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const p2 = await createProduct(db, { price: 900, merchantId: m2 })
      await createOrder(db, { phone: '01711000931', items: [{ variantId: p2.variantIds[0], quantity: 2 }], merchantId: m2 })
      const owner2 = await createStaff(db, 'OWNER', undefined, m2)
      await asUser(db, owner2)
      const dash = await value<{ orders: number }>(db, `select public.dashboard_overview(current_date - 1, current_date)`)
      expect(num(dash.orders)).toBe(1)
    }))
})

describe('tenancy: finding the merchant for outside requests', () => {
  it('maps channels, couriers, payments, API keys and domains to their merchant — and only for the service role', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      await asSystem(db, m2)
      const courier = await value<string>(db, `select id from public.couriers where merchant_id = $1 limit 1`, [m2])
      const channel = await value<string>(db, `insert into public.sales_channels (platform, name, shop_domain) values ('WOOCOMMERCE', 'Second Woo', 'https://second.example') returning id`)
      await db.query(`insert into public.site_api_keys (name, kind, key_hash, prefix, allowed_origins) values ('site', 'SECRET', 'hash-m2', 'sk_live_ab', '{}')`)
      await db.query(`insert into public.store_domains (domain, status) values ('second-shop.example', 'ACTIVE')`)

      await asService(db, null)
      const lookup = (kind: string, key: string) => value<string | null>(db, `select public.merchant_for($1, $2)`, [kind, key])
      expect(await lookup('courier', courier)).toBe(m2)
      expect(await lookup('channel', channel)).toBe(m2)
      expect(await lookup('site_api_key', 'hash-m2')).toBe(m2)
      expect(await lookup('store_domain', 'SECOND-SHOP.example')).toBe(m2)
      expect(await lookup('courier', randomUUID())).toBeNull()
      expect(await lookup('courier', 'not-a-uuid')).toBeNull()
      await expectError(db, `select public.merchant_for('everything', 'x')`, [], /unknown lookup/)

      await asUser(db, await createStaff(db, 'OWNER'))
      await expectError(db, `select public.merchant_for('courier', $1)`, [courier], /permission denied/)
    }))

  it('answers nothing when a key exists in two merchants (never guesses)', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      for (const m of [MERCHANT_1, m2]) {
        await asSystem(db, m)
        const courier = await value<string>(db, `insert into public.couriers (name, provider) values ('Pathao', 'pathao') returning id`)
        const p = await createProduct(db, { price: 100, merchantId: m })
        const o = await createOrder(db, { phone: '01711000941', items: [{ variantId: p.variantIds[0], quantity: 1 }], merchantId: m })
        await asSystem(db, m)
        await db.query(`insert into public.shipments (order_id, courier_id, consignment_id) values ($1, $2, 'SAME-123')`, [o.id, courier])
      }
      await asService(db, null)
      expect(await value(db, `select public.merchant_for('consignment', 'pathao:SAME-123')`)).toBeNull()
    }))

  it('opens the right store for a web address', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db, 'Second Shop')
      await asSystem(db, m2)
      await db.query(`insert into public.store_domains (domain, status) values ('second-shop.example', 'ACTIVE')`)
      await asAnon(db, null)
      expect(await value(db, `select public.storefront_resolve('www.second-shop.example')`)).toMatchObject({ merchant_id: m2, name: 'Second Shop' })
      expect(await value(db, `select public.storefront_resolve('second-shop.example:443')`)).toMatchObject({ merchant_id: m2 })
      // The platform's own address shows the default store (Merchant #1).
      expect(await value(db, `select public.storefront_resolve('commerce.vercel.app')`)).toMatchObject({ merchant_id: MERCHANT_1 })
    }))

  it('tells staff which merchant they work for', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db, 'Merchant Two')
      const owner2 = await createStaff(db, 'OWNER', undefined, m2)
      await asUser(db, owner2)
      expect(await value(db, `select public.get_my_access()`)).toMatchObject({ merchant_id: m2, merchant: { name: 'Merchant Two', status: 'ACTIVE' } })
      expect(await value(db, `select public.is_platform_staff()`)).toBe(false)
    }))

  it('keeps platform credentials apart from every merchant, with an audit entry', () =>
    inTx(async (db) => {
      await asService(db, null)
      await db.query(`select public.platform_secret_store('test.gateway', '{"token":"platform-1"}', 'tok ••••rm-1', null)`)
      expect(await value(db, `select public.platform_secret_get('test.gateway')`)).toEqual({ token: 'platform-1' })
      // A merchant's own credentials with the same name are a different thing.
      await asService(db)
      expect(await value(db, `select public.integration_secret_get('test.gateway')`)).toBeNull()
      await asSystem(db, null)
      expect(await value(db, `select count(*)::int from public.platform_audit_logs where action = 'platform_credential.saved' and entity_id = 'test.gateway'`)).toBe(1)
      await expectError(db, `update public.platform_audit_logs set action = 'x'`, [], /IMMUTABLE_RECORD/)
      await expectError(db, `delete from public.platform_audit_logs`, [], /IMMUTABLE_RECORD/)
      await asUser(db, await createStaff(db, 'OWNER'))
      await expectError(db, `select public.platform_secret_get('test.gateway')`, [], /permission denied/)
      await expectError(db, `select * from public.platform_credentials`, [], /permission denied/)
      await expectError(db, `select * from public.platform_audit_logs`, [], /permission denied/)
    }))
})

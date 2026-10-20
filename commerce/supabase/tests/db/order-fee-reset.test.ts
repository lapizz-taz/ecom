import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createPlatformStaff, createProduct, createStaff, inventory, placeOrder } from '../support/fixtures'

afterAll(closePool)

const as = (db: Db, id: string) => asUser(db, id, 'staff@platform.example', null)
type Batch = { approved: number; failed: Array<{ order_id: string; error: string }> }

async function feeOn(db: Db, superId: string, over: Record<string, unknown> = {}) {
  await as(db, superId)
  return value<Record<string, unknown>>(db, `select public.platform_order_fee_settings_save($1, 'Charging approved orders')`,
    [JSON.stringify({ enabled: true, fee: 1.5, on_empty: 'BLOCK', free_per_month: 0, ...over })])
}

async function topUp(db: Db, superId: string, merchant: string, poisha: number) {
  await as(db, superId)
  return value<Record<string, any>>(db, `select public.platform_credit_adjust($1, 'BALANCE', $2, 'ADJUSTMENT', 'Paid in cash at the office', null, $3)`,
    [merchant, poisha, randomUUID()])
}

async function newOrder(db: Db, variant: string, phone: string) {
  return (await placeOrder(db, { phone, items: [{ variantId: variant, quantity: 1 }] })).id
}

async function approve(db: Db, staff: string, ids: string[]) {
  await asUser(db, staff)
  return value<Batch>(db, `select public.approve_orders($1)`, [ids])
}

async function balance(db: Db, merchant: string) {
  await asSystem(db)
  return value<number>(db, `select public.credit_available($1, 'BALANCE')`, [merchant])
}

describe('order fee: charging approved orders', () => {
  it('is off until switched on; then charges each approved order once from the balance, and refuses when it is empty', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      const p = await createProduct(db, { price: 500, stock: 20 })

      // Off by default: approving records nothing and charges nothing.
      const free = await newOrder(db, p.variantIds[0], '01711000901')
      expect(await approve(db, agent, [free])).toEqual({ approved: 1, failed: [] })
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.order_fee_charges where order_id = $1`, [free]))).toBe(0)

      // On at 1.50 Tk with an empty balance: the approval is refused and says why.
      await feeOn(db, superId)
      const a = await newOrder(db, p.variantIds[0], '01711000902')
      const refused = await approve(db, agent, [a])
      expect(refused.approved).toBe(0)
      expect(refused.failed[0].error).toMatch(/costs 1\.50 Tk and the balance is 0\.00 Tk/)
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [a])).not.toBe('CONFIRMED')

      // 3 Tk added by the Super Admin (no second person needed for small top-ups).
      const entry = await topUp(db, superId, MERCHANT_1, 300)
      expect(entry).toMatchObject({ amount: 300, balance_after: 300, credit_type: 'BALANCE' })
      expect(await approve(db, agent, [a])).toEqual({ approved: 1, failed: [] })
      await asSystem(db)
      expect(await balance(db, MERCHANT_1)).toBe(150)
      expect(await value<Record<string, any>>(db, `select to_jsonb(c) from public.order_fee_charges c where order_id = $1`, [a]))
        .toMatchObject({ charge: 'CHARGED', fee: 1.5 })
      expect(await value(db, `select reason from public.credit_ledger where merchant_id = $1 and credit_type = 'BALANCE' and kind = 'USAGE'`,
        [MERCHANT_1])).toMatch(/approved/)

      // Approving again or moving it along never charges twice.
      expect((await approve(db, agent, [a])).failed[0].error).toMatch(/already approved/)
      await advanceOrder(db, a, ['PROCESSING', 'CANCELLED'])
      expect(await balance(db, MERCHANT_1)).toBe(150)

      const b = await newOrder(db, p.variantIds[0], '01711000903')
      const c = await newOrder(db, p.variantIds[0], '01711000904')
      const both = await approve(db, agent, [b, c])
      expect(both.approved).toBe(1)
      expect(both.failed).toHaveLength(1)
      expect(await balance(db, MERCHANT_1)).toBe(0)

      // The store sees its price, balance and month.
      await asUser(db, agent)
      const mine = await value<Record<string, any>>(db, `select public.my_order_fee()`)
      expect(mine).toMatchObject({ enabled: true, fee: 1.5, balance_tk: 0, low_balance: true, orders_left: 0 })
      expect(mine.month).toMatchObject({ charged: 2, amount_tk: 3 })
      expect((await value<Record<string, any>>(db, `select public.my_credits()`)).order_fee).toMatchObject({ fee: 1.5 })
    }))

  it('follows a store price, an exemption, free monthly orders and the "let it through" policy', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const agent = await createStaff(db, 'ORDER_MANAGER')
      const p = await createProduct(db, { price: 500, stock: 20 })
      await feeOn(db, superId, { free_per_month: 1 })
      await topUp(db, superId, MERCHANT_1, 1000)

      // The first order of the month is free.
      const first = await newOrder(db, p.variantIds[0], '01711000911')
      await approve(db, agent, [first])
      await asSystem(db)
      expect(await value(db, `select charge from public.order_fee_charges where order_id = $1`, [first])).toBe('FREE')
      expect(await balance(db, MERCHANT_1)).toBe(1000)

      // This store pays 0.50 Tk.
      await as(db, superId)
      await db.query(`select public.platform_order_fee_override_set($1, 0.5, false, 'Launch discount for this store')`, [MERCHANT_1])
      const second = await newOrder(db, p.variantIds[0], '01711000912')
      await approve(db, agent, [second])
      expect(await balance(db, MERCHANT_1)).toBe(950)

      // Exempt: recorded, not charged.
      await as(db, superId)
      await db.query(`select public.platform_order_fee_override_set($1, null, true, 'Partner store, no fee')`, [MERCHANT_1])
      const third = await newOrder(db, p.variantIds[0], '01711000913')
      await approve(db, agent, [third])
      await asSystem(db)
      expect(await value(db, `select charge from public.order_fee_charges where order_id = $1`, [third])).toBe('EXEMPT')
      expect(await balance(db, MERCHANT_1)).toBe(950)

      // Back to the platform price, with "let it through" and too little balance: approved and recorded as unpaid.
      await as(db, superId)
      await db.query(`select public.platform_order_fee_override_set($1, null, false, 'Back to the normal price')`, [MERCHANT_1])
      await feeOn(db, superId, { fee: 20, on_empty: 'ALLOW', free_per_month: 0 })
      const fourth = await newOrder(db, p.variantIds[0], '01711000914')
      expect(await approve(db, agent, [fourth])).toEqual({ approved: 1, failed: [] })
      await asSystem(db)
      expect(await value(db, `select charge from public.order_fee_charges where order_id = $1`, [fourth])).toBe('UNPAID')
      expect(await balance(db, MERCHANT_1)).toBe(950)
      await as(db, superId)
      const overview = await value<Record<string, any>>(db, `select public.platform_order_fee_overview()`)
      expect(overview.totals.unpaid_orders).toBeGreaterThanOrEqual(1)
      expect(overview.stores.find((s: any) => s.merchant_id === MERCHANT_1)).toMatchObject({ fee: 20, balance_tk: 9.5 })
    }))

  it('keeps fee settings and balances to the right people', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      const owner = await createStaff(db, 'OWNER')
      await as(db, viewer)
      await expectError(db, `select public.platform_order_fee_settings_save('{"fee": 0}', 'Free for everyone')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public.platform_order_fee_override_set($1, 0, false, 'Free for this one')`, [MERCHANT_1], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select public.platform_order_fee_settings_save('{"fee": 0}', 'Free for everyone')`, [], /PERMISSION_DENIED/)
      await expectError(db, `select public._order_fee_charge(gen_random_uuid(), $1, 'X')`, [MERCHANT_1], /permission denied/)
      await expectError(db, `select public.platform_credit_adjust($1, 'BALANCE', 100000, 'ADJUSTMENT', 'Topping myself up', null, gen_random_uuid())`,
        [MERCHANT_1], /PERMISSION_DENIED/)
      await as(db, superId)
      await expectError(db, `select public.platform_order_fee_settings_save('{"fee": 1.555}', 'Too precise')`, [], /2 decimals/)
      await expectError(db, `select public.platform_order_fee_settings_save('{"fee": 1, "on_empty": "MAYBE"}', 'Bad option')`, [], /BLOCK|ALLOW/)
      // Large balance top-ups wait for a second person.
      expect(await topUp(db, superId, MERCHANT_1, 6_000_000)).toHaveProperty('pending_approval')
    }))
})

describe('store reset', () => {
  async function storeWithHistory(db: Db) {
    const p = await createProduct(db, { price: 500, stock: 10 })
    const shipped = await newOrder(db, p.variantIds[0], '01711000921')
    await advanceOrder(db, shipped, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
    const waiting = await newOrder(db, p.variantIds[0], '01711000922')
    await advanceOrder(db, waiting, ['CONFIRMED'])
    return p
  }

  it('needs the right person, the exact store name, a reason and a fresh export', () =>
    inTx(async (db) => {
      await storeWithHistory(db)
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const viewer = await createPlatformStaff(db, 'VIEWER')
      await asSystem(db)
      const name = await value<string>(db, `select name from public.merchants where id = $1`, [MERCHANT_1])
      await as(db, viewer)
      await expectError(db, `select public.platform_store_reset($1, 'ORDERS', $2, 'Start again after testing')`, [MERCHANT_1, name], /PERMISSION_DENIED/)
      await as(db, superId)
      await expectError(db, `select public.platform_store_reset($1, 'ORDERS', 'Another shop', 'Start again after testing')`, [MERCHANT_1], /store name/)
      await expectError(db, `select public.platform_store_reset($1, 'ORDERS', $2, 'Because')`, [MERCHANT_1, name], /at least 10/)
      await expectError(db, `select public.platform_store_reset($1, 'ORDERS', $2, 'Start again after testing')`, [MERCHANT_1, name], /export/)
      await expectError(db, `select public.platform_store_reset($1, 'SOME', $2, 'Start again after testing')`, [MERCHANT_1, name], /choose what to reset/)
      // Outside a reset, history stays immutable.
      await asSystem(db)
      await expectError(db, `delete from public.inventory_movements where merchant_id = $1`, [MERCHANT_1], /IMMUTABLE_RECORD/)
      await db.query(`select set_config('app.store_reset', gen_random_uuid()::text, true)`)
      await expectError(db, `delete from public.order_status_history where merchant_id = $1`, [MERCHANT_1], /IMMUTABLE_RECORD/)
    }))

  it('clears orders and customers, keeps products, stock history, credits and the audit trail, and leaves other stores alone', () =>
    inTx(async (db) => {
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const p = await storeWithHistory(db)
      await as(db, superId)
      const other = (await value<{ id: string }>(db, `select public.platform_merchant_create('{"name": "Other Shop"}')`)).id
      const otherProduct = await createProduct(db, { price: 300, stock: 4, merchantId: other })
      await feeOn(db, superId)
      await topUp(db, superId, MERCHANT_1, 500)
      await asSystem(db)
      const name = await value<string>(db, `select name from public.merchants where id = $1`, [MERCHANT_1])
      const movementsBefore = await value<number>(db, `select count(*)::int from public.inventory_movements where merchant_id = $1`, [MERCHANT_1])
      expect(movementsBefore).toBeGreaterThan(0)

      await as(db, superId)
      await db.query(`select public.platform_merchant_export($1, 'Copy before resetting the store')`, [MERCHANT_1])
      const r = await value<Record<string, any>>(db, `select public.platform_store_reset($1, 'ORDERS', $2, 'Start again after testing')`,
        [MERCHANT_1, ` ${name.toUpperCase()} `])
      expect(r.counts.orders).toBeGreaterThanOrEqual(2)

      await asSystem(db)
      for (const t of ['orders', 'order_items', 'order_status_history', 'customers', 'fraud_checks', 'stock_reservations']) {
        expect(await value<number>(db, `select count(*)::int from public.${t} where merchant_id = $1`, [MERCHANT_1]), t).toBe(0)
      }
      expect(await value<number>(db, `select count(*)::int from public.products where merchant_id = $1`, [MERCHANT_1])).toBeGreaterThan(0)
      expect((await inventory(db, p.variantIds[0])).reserved).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.inventory_movements where merchant_id = $1`, [MERCHANT_1]))
        .toBeGreaterThanOrEqual(movementsBefore)
      expect(await balance(db, MERCHANT_1)).toBe(500)
      expect(await value<number>(db, `select count(*)::int from public.audit_logs where merchant_id = $1 and action = 'store.reset'`, [MERCHANT_1])).toBe(1)
      expect(await value<number>(db, `select count(*)::int from public.platform_audit_logs where action = 'merchants.reset'`)).toBeGreaterThanOrEqual(1)
      expect(await value<number>(db, `select count(*)::int from public.products where id = $1`, [otherProduct.productId])).toBe(1)
      // The bypass ended with the reset.
      await expectError(db, `delete from public.inventory_movements where merchant_id = $1`, [MERCHANT_1], /IMMUTABLE_RECORD/)

      // A store connection with a saved key, here and in another business.
      await asSystem(db, MERCHANT_1)
      const channel = await value<string>(db, `insert into public.sales_channels (platform, name, shop_domain, status) values ('SHOPIFY', 'Old shop', 'old-shop.myshopify.com', 'DISCONNECTED') returning id`)
      const secret = await value<string>(db, `select vault.create_secret('{"access_token":"x"}')`)
      await db.query(`insert into public.integration_credentials (key, secret_id) values ($1, $2)`, [`channels.${channel.replace(/-/g, '')}`, secret])
      // Every other kind of connection: a courier account, an SMS provider key, a custom domain,
      // connection settings and a store that sends visitors to the Shopify shop.
      const courier = await value<string>(db, `insert into public.couriers (name, provider, api_enabled, api_status) values ('Steadfast', 'steadfast', true, 'CONNECTED') returning id`)
      const courierSecret = await value<string>(db, `select vault.create_secret('{"api_key":"k"}')`)
      await db.query(`insert into public.courier_credentials (courier_id, provider, secret_id, hint) values ($1, 'steadfast', $2, 'k…')`, [courier, courierSecret])
      const smsSecret = await value<string>(db, `select vault.create_secret('{"api_key":"s"}')`)
      await db.query(`insert into public.integration_credentials (key, secret_id, hint) values ('sms.provider', $1, 's…')`, [smsSecret])
      await db.query(`insert into public.store_domains (domain, status) values ('shop.example.com', 'ACTIVE')`)
      await db.query(`update public.settings set value = value || '{"connected": true, "provider": "bulksmsbd"}' where key = 'sms' and merchant_id = $1`, [MERCHANT_1])
      await db.query(`update public.settings set value = value || '{"mode": "SHOPIFY", "redirect_url": "https://old-shop.myshopify.com"}' where key = 'storefront' and merchant_id = $1`, [MERCHANT_1])
      await asSystem(db, other)
      const otherChannel = await value<string>(db, `insert into public.sales_channels (platform, name, shop_domain, status) values ('SHOPIFY', 'Their shop', 'their-shop.myshopify.com', 'CONNECTED') returning id`)
      const otherCourier = await value<string>(db, `insert into public.couriers (name, provider) values ('Pathao', 'pathao') returning id`)

      // Everything: products, their stock history and store connections go too; the reset is listed.
      await as(db, superId)
      const all = await value<Record<string, any>>(db, `select public.platform_store_reset($1, 'EVERYTHING', $2, 'Fresh start before going live')`, [MERCHANT_1, name])
      expect(all.counts.products).toBeGreaterThan(0)
      await asSystem(db)
      for (const t of ['products', 'product_variants', 'inventory', 'inventory_movements', 'finance_transactions', 'suppliers']) {
        expect(await value<number>(db, `select count(*)::int from public.${t} where merchant_id = $1`, [MERCHANT_1]), t).toBe(0)
      }
      expect(await value<number>(db, `select count(*)::int from public.product_variants where merchant_id = $1`, [other])).toBe(1)
      expect(all.counts.store_connections).toBe(1)
      expect(await value<number>(db, `select count(*)::int from public.sales_channels where merchant_id = $1`, [MERCHANT_1])).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.integration_credentials where merchant_id = $1 and key like 'channels.%'`, [MERCHANT_1])).toBe(0)
      expect(await value<number>(db, `select count(*)::int from vault.secrets where id = $1`, [secret])).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.sales_channels where id = $1`, [otherChannel])).toBe(1)
      // No other connection or its key is left; the business starts with a new business's courier and settings.
      expect(all.counts.every_connection).toBe(true)
      expect(await value<string[]>(db, `select coalesce(array_agg(name), '{}') from public.couriers where merchant_id = $1`, [MERCHANT_1])).toEqual(['Own delivery'])
      for (const t of ['courier_credentials', 'integration_credentials', 'api_keys', 'ad_connections', 'system_logs']) {
        expect(await value<number>(db, `select count(*)::int from public.${t} where merchant_id = $1`, [MERCHANT_1]), t).toBe(0)
      }
      // Domains stay as removed rows (so their visitors see "store not available"), never live or proven.
      expect(await value<number>(db, `select count(*)::int from public.store_domains where merchant_id = $1 and (status <> 'REMOVED' or verified_at is not null)`, [MERCHANT_1])).toBe(0)
      expect(await value<number>(db, `select count(*)::int from vault.secrets where id in ($1, $2)`, [courierSecret, smsSecret])).toBe(0)
      expect(await value<Record<string, any>>(db, `select value from public.settings where key = 'sms' and merchant_id = $1`, [MERCHANT_1])).toMatchObject({ connected: false, provider: null })
      const storefront = await value<Record<string, any>>(db, `select value from public.settings where key = 'storefront' and merchant_id = $1`, [MERCHANT_1])
      expect(storefront.mode).toBe('OFF')
      expect(storefront.redirect_url).toBeUndefined()
      expect(await value<number>(db, `select count(*)::int from public.couriers where id = $1`, [otherCourier])).toBe(1)
      expect(await balance(db, MERCHANT_1)).toBe(500)
      await as(db, superId)
      expect((await value<Record<string, any>>(db, `select public.platform_store_resets($1)`, [MERCHANT_1])).resets).toHaveLength(2)
    }))
})

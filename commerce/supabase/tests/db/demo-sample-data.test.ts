import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createProduct, inventory } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

// supabase/demo-sample-data.sql fills the look-only demo business on fullfilio.com. It runs as the
// database owner, who sees every business, so it must stay inside the one it is given.
const script = readFileSync(new URL('../../demo-sample-data.sql', import.meta.url), 'utf8')

/** The script is run on the live Postgres database only (it lifts record locks with ALTER TABLE). */
const onEngine = Boolean(process.env.CF_DB_TESTS)

// The live demo business's order rules (29 Oct 2026), so the test places orders the same way.
const DEMO_RULES: Record<string, unknown> = {
  fraud: {
    enabled: true, providers: ['internal'], block_mode: 'REJECT', thresholds: { high: 60, medium: 30, critical: 80 },
    receive_rate: { actions: { LOW: 'ADVANCE', MID: 'ADVANCE', NEW: 'COD', GOOD: 'COD', ERROR: 'ADVANCE' }, enabled: false,
      mid_min: 50, good_min: 80, min_parcels: 1, advance_type: 'FIXED', advance_amount: 55 },
    cache_minutes: 30, default_advance: { type: 'DELIVERY_CHARGE', value: 0 }, on_provider_error: 'REVIEW',
    new_customer_score: 20, check_manual_orders: false,
  },
  orders: {
    track_carts: true, auto_merge_enabled: true, auto_merge_minutes: 3, capture_incomplete: true, require_confirmation: true,
    max_quantity_per_item: 20, abandoned_cart_minutes: 60, auto_merge_web_enabled: true, duplicate_window_hours: 24,
    auto_merge_window_hours: 72, duplicate_check_enabled: true, require_courier_before_ship: false,
    advance_payment_timeout_hours: 24, require_confirmation_after_advance: false,
  },
}

async function demoBusiness(db: Db): Promise<string> {
  const id = await createMerchant(db)
  await asSystem(db, null)
  await db.query(`update public.merchants set view_only = true where id = $1`, [id])
  await db.query(`update public.notifications set is_enabled = false where merchant_id = $1`, [id])
  await asSystem(db, id)
  for (const [key, rules] of Object.entries(DEMO_RULES)) {
    await db.query(`update public.settings set value = value || $3::jsonb where merchant_id = $1 and key = $2`, [id, key, JSON.stringify(rules)])
  }
  return id
}

async function run(db: Db, merchant: string, backdate: 'on' | 'off'): Promise<Record<string, unknown>> {
  await asSystem(db, null)
  await db.query(`select set_config('demo.merchant_id', $1, true), set_config('demo.backdate', $2, true)`, [merchant, backdate])
  const res = await db.query(script)
  const last = Array.isArray(res) ? res[res.length - 1] : res
  return last.rows[0].demo_sample_data
}

describe.skipIf(onEngine)('demo sample data', () => {
  it('fills only the demo business, with a month of orders', () =>
    inTx(async (db) => {
      // Another business with a product and a courier named like the demo's.
      const other = await createProduct(db, { name: 'Essential Cotton Tee', price: 700, stock: 9 })
      await asSystem(db, MERCHANT_1)
      await db.query(`insert into public.couriers(name, provider, default_shipping_cost) values ('Steadfast', 'manual', 60)`)
      const before = await inventory(db, other.variantIds[0])
      const otherOrders = await value<number>(db, `select count(*)::int from public.orders where merchant_id = $1`, [MERCHANT_1])

      const demo = await demoBusiness(db)
      const out = await run(db, demo, 'on')

      expect(out).toMatchObject({ products: 12, view_only: true, is_demo: true })
      expect(Number(out.orders)).toBeGreaterThanOrEqual(55)
      expect(Number(out.customers)).toBeGreaterThanOrEqual(45)
      const byStatus = out.orders_by_status as Record<string, number>
      for (const s of ['ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMED', 'PRODUCTION', 'QUALITY_CHECK', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REJECTED_FRAUD']) {
        expect(byStatus[s], s).toBeGreaterThan(0)
      }
      // Spread over the month, and the record locks are back on.
      expect(new Date(String(out.oldest_order)).getTime()).toBeLessThan(Date.now() - 20 * 86_400_000)
      expect(await value<number>(db, `select count(*)::int from pg_trigger where tgname like '%immutable' and tgenabled = 'D'`)).toBe(0)
      await expectError(db, `update public.order_status_history set created_at = created_at where merchant_id = $1`, [demo], /IMMUTABLE_RECORD/)

      // The other business is untouched.
      expect(await inventory(db, other.variantIds[0])).toEqual(before)
      expect(await value<number>(db, `select count(*)::int from public.orders where merchant_id = $1`, [MERCHANT_1])).toBe(otherOrders)
      expect(await value<number>(db, `select count(*)::int from public.couriers where merchant_id = $1 and name = 'Steadfast'`, [MERCHANT_1])).toBe(1)
      // Every order line is the demo's own product.
      expect(await value<number>(db, `
        select count(*)::int from public.order_items i join public.orders o on o.id = i.order_id
        join public.product_variants v on v.id = i.variant_id join public.products p on p.id = v.product_id
        where o.merchant_id = $1 and p.merchant_id <> $1`, [demo])).toBe(0)
      // No message was queued for anyone.
      expect(await value<number>(db, `select count(*)::int from public.notification_logs where merchant_id = $1`, [demo])).toBe(0)
      // Stock agrees with the open reservations.
      expect(await value<number>(db, `
        select count(*)::int from public.inventory i join public.product_variants v on v.id = i.variant_id
        join public.products p on p.id = v.product_id
        where p.merchant_id = $1 and i.reserved <> coalesce((select sum(quantity) from public.stock_reservations r
                                    where r.variant_id = i.variant_id and r.status = 'ACTIVE'), 0)`, [demo])).toBe(0)
    }))

  it('can leave every record dated today', () =>
    inTx(async (db) => {
      const demo = await demoBusiness(db)
      const out = await run(db, demo, 'off')
      expect(Number(out.orders)).toBeGreaterThanOrEqual(55)
      expect(await value<number>(db, `select count(*)::int from public.orders where merchant_id = $1 and created_at < now() - interval '1 day'`, [demo])).toBe(0)
    }))

  it('refuses a business that is not look-only, or one that has data already', () =>
    inTx(async (db) => {
      await db.query('savepoint a')
      await expect(run(db, MERCHANT_1, 'off')).rejects.toThrow(/not a look-only business/)
      await db.query('rollback to savepoint a')

      const demo = await demoBusiness(db)
      await run(db, demo, 'off')
      await db.query('savepoint b')
      await expect(run(db, demo, 'off')).rejects.toThrow(/not a look-only business|already has products or orders/)
      await db.query('rollback to savepoint b')
      await db.query(`update public.merchants set view_only = true where id = $1`, [demo])
      await expect(run(db, demo, 'off')).rejects.toThrow(/already has products or orders/)
    }))
})

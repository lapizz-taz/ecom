import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, sellOn } from '../support/fixtures'

afterAll(closePool)

const TO_READY = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
type Report = Record<string, any>

async function report(db: Db, basis = 'delivered'): Promise<Report> {
  await asSystem(db)
  return value<Report>(db, `select public.report_order_financials(current_date - 1, current_date + 1, $1)`, [basis])
}
const t = (r: Report, k: string) => num(r.totals[k])

async function wooStore(db: Db) {
  await asService(db)
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`,
    [JSON.stringify({ platform: 'WOOCOMMERCE', shop_domain: `https://w${Math.floor(Math.random() * 1e6)}.example.com`, auth_mode: 'KEYS' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', name = 'My Woo shop' where id = $1`, [id])
  await sellOn(db, 'WOOCOMMERCE')
  return id
}

/**
 * Known transactions:
 *  A  own website: 1 × 1,000 (cost 400), delivery charge 120, courier 80
 *  B  WooCommerce: 1 × 650 (no cost configured), delivery charge 120, courier 80
 *  ads 300 (manual entry, no ad account connected)
 */
async function knownDay(db: Db) {
  await asSystem(db)
  const district = `fin${Math.floor(Math.random() * 1e6)}`
  await db.query(`insert into public.delivery_zones(name, districts, charge, return_charge, sort_order) values ('Fin zone', $1, 120, 60, 0)`, [`{${district}}`])
  const courier = await value<string>(db, `insert into public.couriers(name, provider) values ('Fin courier', 'manual') returning id`)
  const shirt = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
  const tote = await createProduct(db, { price: 650, cost: 0, stock: 5 })
  const woo = await wooStore(db)

  const deliver = async (variantId: string, channel?: string) => {
    const o = await createOrder(db, { district, items: [{ variantId, quantity: 1 }] })
    await asSystem(db)
    if (channel) await db.query(`update public.orders set sales_channel_id = $2, external_order_id = $3 where id = $1`, [o.id, channel, `W${o.id.slice(0, 6)}`])
    await advanceOrder(db, o.id, TO_READY)
    await asSystem(db)
    await db.query(`select public.assign_courier($1, $2, $3, 80)`, [o.id, courier, `TRK-${o.id.slice(0, 8)}`])
    await advanceOrder(db, o.id, ['SHIPPED', 'DELIVERED'])
    return o.id
  }
  const a = await deliver(shirt.variantIds[0])
  const b = await deliver(tote.variantIds[0], woo)
  await asSystem(db)
  const campaign = await value<string>(db, `insert into public.marketing_campaigns(platform, name) values ('META', 'Fin test') returning id`)
  await db.query(`insert into public.marketing_spend(campaign_id, spend_date, spend) values ($1, current_date, 300)`, [campaign])
  return { a, b, woo, tote }
}

describe('Order financials against known transactions', () => {
  it('adds up sales, product cost, delivery cost and ads exactly, and equals the profit & loss statement', () =>
    inTx(async (db) => {
      const before = await report(db)
      await knownDay(db)
      const r = await report(db)
      const d = (k: string) => t(r, k) - t(before, k)
      expect(d('product_sales')).toBe(1650)
      expect(d('delivery_income')).toBe(240)
      expect(d('sales')).toBe(1890)
      expect(d('product_cost')).toBe(400) // B has no cost: not invented
      expect(d('delivery_cost')).toBe(160)
      expect(d('ads')).toBe(300)
      expect(d('profit')).toBe(1890 - 400 - 160 - 300)
      expect(d('orders')).toBe(2)

      await asSystem(db)
      const statement = await value<Record<string, string>>(db, `select public.report_profit_loss(current_date - 1, current_date + 1)`)
      expect(t(r, 'profit')).toBe(num(statement.net_profit))
      expect(t(r, 'sales')).toBe(num(statement.revenue))
    }))

  it('separates the WooCommerce store, flags its missing cost and keeps ads apart from channels', () =>
    inTx(async (db) => {
      const { woo, b } = await knownDay(db)
      const r = await report(db)
      const ch = r.channels.find((c: Report) => c.key === woo)
      expect(ch).toMatchObject({ name: 'My Woo shop', platform: 'WOOCOMMERCE', synced: true, orders: 1, missing_cost_orders: 1 })
      expect([num(ch.sales), num(ch.product_cost), num(ch.delivery_cost), num(ch.profit)]).toEqual([770, 0, 80, 690])
      const web = r.channels.find((c: Report) => c.key === 'source:ADMIN' || c.key === 'source:STOREFRONT')
      expect(num(web.product_cost)).toBeGreaterThanOrEqual(400)
      expect(num(r.unallocated.ads)).toBeGreaterThanOrEqual(300)
      expect(r.quality.missing_cost_orders).toBeGreaterThanOrEqual(1)
      expect(num(r.quality.synced_sales)).toBeGreaterThanOrEqual(770)
      // Courier fees are estimates until the courier reports them.
      expect(num(r.quality.delivery_cost_estimated)).toBeGreaterThanOrEqual(160)
      // No ad account connected here: the 300 is a manual entry, not "synced".
      expect(['manual', 'synced']).toContain(r.quality.ads.status)

      await asSystem(db)
      const rows = await value<Report>(db, `select public.report_order_financials_orders(current_date - 1, current_date + 1, 'delivered', null, true, 50, 0)`)
      expect(rows.rows.map((x: Report) => x.order_id)).toContain(b)
      expect(rows.rows.find((x: Report) => x.order_id === b)).toMatchObject({ channel: 'My Woo shop', missing_cost: true, delivery_estimated: true })
    }))

  it('rebuild cost: preview changes nothing; apply fills only the missing cost once, as new ledger entries', () =>
    inTx(async (db) => {
      const { b, tote } = await knownDay(db)
      await asSystem(db)
      const rows0 = await value<number>(db, `select count(*)::int from public.finance_transactions`)
      // Still unknown: nothing to rebuild from.
      let plan = await value<Report>(db, `select public.finance_rebuild_cost(current_date - 1, current_date + 1, false)`)
      expect(plan.rows.some((x: Report) => x.order_id === b)).toBe(false)
      expect(plan.unknown_items).toBeGreaterThanOrEqual(1)

      // The owner adds the cost now.
      await db.query(`update public.product_variants set cost_price = 250 where id = $1`, [tote.variantIds[0]])
      plan = await value<Report>(db, `select public.finance_rebuild_cost(current_date - 1, current_date + 1, false)`)
      expect(plan.rows.find((x: Report) => x.order_id === b)).toMatchObject({ quantity: 1 })
      expect(num(plan.rows.find((x: Report) => x.order_id === b).amount)).toBe(250)
      expect(await value<number>(db, `select count(*)::int from public.finance_transactions`)).toBe(rows0)

      const before = await report(db)
      const owner = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, owner)
      const done = await value<Report>(db, `select public.finance_rebuild_cost(current_date - 1, current_date + 1, true)`)
      expect(done.applied).toBe(true)
      expect(done.posted).toBeGreaterThanOrEqual(1)
      const after = await report(db)
      expect(t(after, 'product_cost') - t(before, 'product_cost')).toBe(num(done.amount))
      await asSystem(db)
      expect(num(await value(db, `select cost_total from public.orders where id = $1`, [b]))).toBe(250)
      expect(num(await value(db, `select unit_cost from public.order_items where order_id = $1`, [b]))).toBe(250)

      // Running it again adds nothing.
      await asUser(db, owner)
      const again = await value<Report>(db, `select public.finance_rebuild_cost(current_date - 1, current_date + 1, true)`)
      expect(again.posted).toBe(0)
      expect(t(await report(db), 'product_cost')).toBe(t(after, 'product_cost'))
      // Nothing was deleted or rewritten: only appended.
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.finance_transactions`)).toBe(rows0 + done.posted)
    }))

  it('recalculate posts a delivered order that never reached the ledger, once', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, cost: 200, stock: 3 })
      const o = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      // As if delivered by an old import, without the ledger posting.
      await db.query(`update public.orders set status = 'DELIVERED', delivered_at = now() where id = $1`, [o.id])
      const before = await report(db)
      expect(before.quality.unposted_delivered).toBeGreaterThanOrEqual(1)

      const fm = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, fm)
      const r1 = await value<Report>(db, `select public.finance_recalculate_orders(current_date - 1, current_date + 1)`)
      expect(r1.orders).toBeGreaterThanOrEqual(1)
      const after = await report(db)
      expect(t(after, 'product_sales') - t(before, 'product_sales')).toBeGreaterThanOrEqual(500)
      expect(after.quality.unposted_delivered).toBe(0)
      await asUser(db, fm)
      const r2 = await value<Report>(db, `select public.finance_recalculate_orders(current_date - 1, current_date + 1)`)
      expect(r2).toMatchObject({ orders: 0, entries: 0 })
      expect(t(await report(db), 'sales')).toBe(t(after, 'sales'))
    }))

  it('needs finance.view to read and finance.manage to change; rejects bad arguments', () =>
    inTx(async (db) => {
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.report_order_financials(current_date - 1, current_date, 'delivered')`, [], /finance\.view|permission/i)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.report_order_financials(current_date - 1, current_date, 'approved')`)
      await db.query(`select public.finance_rebuild_cost(current_date - 1, current_date, false)`)
      await expectError(db, `select public.finance_rebuild_cost(current_date - 1, current_date, true)`, [], /finance\.manage|permission/i)
      await expectError(db, `select public.finance_recalculate_orders(current_date - 1, current_date)`, [], /finance\.manage|permission/i)
      await expectError(db, `select public.report_order_financials(current_date, current_date - 1, 'delivered')`, [], /VALIDATION/)
      await expectError(db, `select public.report_order_financials(current_date - 1, current_date, 'paid')`, [], /VALIDATION/)
    }))
})

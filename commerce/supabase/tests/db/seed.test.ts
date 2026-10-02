import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../support/db'

// The development seed is built through the real business functions, so
// loading it is itself an end-to-end check of the order lifecycle.
describe('development seed', () => {
  let client: pg.Client

  beforeAll(async () => {
    const url = await createTestDatabase('commerce_seed_test', true)
    client = new pg.Client({ connectionString: url })
    await client.connect()
  }, 120_000)

  afterAll(async () => {
    await client?.end()
  })

  it('creates staff accounts with roles', async () => {
    const { rows } = await client.query(`select r.code from public.profiles p join public.roles r on r.id = p.role_id order by r.code`)
    expect(rows.map((r) => r.code)).toEqual(['FINANCE_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'OWNER', 'PRODUCTION_MANAGER'])
  })

  it('has orders in every major stage', async () => {
    const { rows } = await client.query(`select distinct status::text from public.orders`)
    const statuses = rows.map((r) => r.status)
    for (const s of ['ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMED', 'PRODUCTION', 'QUALITY_CHECK', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REJECTED_FRAUD']) {
      expect(statuses).toContain(s)
    }
  })

  it('keeps stock consistent with reservations', async () => {
    const { rows } = await client.query(`
      select i.variant_id from public.inventory i
      where i.reserved <> coalesce((select sum(quantity) from public.stock_reservations r
                                    where r.variant_id = i.variant_id and r.status = 'ACTIVE'), 0)`)
    expect(rows).toHaveLength(0)
  })

  it('produces a P&L, dashboard and reports', async () => {
    const pnl = (await client.query(`select public.report_profit_loss(current_date - 31, current_date) as r`)).rows[0].r
    expect(Number(pnl.revenue)).toBeGreaterThan(0)
    expect(Number(pnl.cogs)).toBeGreaterThan(0)
    const dash = (await client.query(`select public.dashboard_overview(current_date - 30, current_date) as r`)).rows[0].r
    expect(dash.orders).toBeGreaterThan(20)
    expect(dash.finance).toBeDefined()
    for (const fn of ['report_fraud', 'report_couriers', 'report_customers', 'report_cancellations_returns', 'report_advance_payments', 'report_production']) {
      await client.query(`select public.${fn}(current_date - 30, current_date)`)
    }
    await client.query(`select public.report_timeseries(current_date - 30, current_date, 'week')`)
    await client.query(`select public.report_inventory_valuation()`)
  })
})

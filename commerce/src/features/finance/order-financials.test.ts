import { describe, expect, it } from 'vitest'
import type { OrderFinancials } from '@/services/finance'
import { allocation, calculationRows, profitOf } from './order-financials'

// The known day from the database test: own order 1,000 + 120 (cost 400, courier 80), WooCommerce
// order 650 + 120 (no cost, courier 80), ads 300, one refund of 90, rent 200, a claim of 50.
function report(over: Partial<OrderFinancials> = {}): OrderFinancials {
  const totals = {
    product_sales: 1650, delivery_income: 240, sales: 1890, return_charges: 0, other_income: 50, refunds: 90,
    product_cost: 400, delivery_cost: 160, ads: 300, other_expense: 200, total_expense: 1150,
    profit: 1890 + 50 - 90 - 400 - 160 - 300 - 200, orders: 2, margin_pct: null, profit_per_order: null, sales_per_order: null,
  }
  return {
    from: '2026-10-01', to: '2026-10-01', basis: 'delivered', totals,
    counts: { product_sales: 2, delivery_income: 2, product_cost: 1, delivery_cost: 2, refunds: 1, other_income: 1, other_expense: 1 },
    stats: { basis: 'approved', total: 2, delivered: 2, pending: 0, returned: 0, cancelled: 0, delivered_pct: 100 },
    quality: {
      missing_cost_orders: 1, missing_cost_items: 1, missing_cost_fixable: 0, unposted_delivered: 0,
      delivery_cost_estimated: 160, delivery_cost_confirmed: 0, sold_without_delivery_cost: 0, synced_sales: 770, synced_orders: 1,
      ads: { status: 'manual', accounts: 0, last_sync_at: null, entries: 1 },
    },
    channels: [], unallocated: { ads: 300, other_expense: 200, other_income: 50, refunds: 0 },
    products: { count: 0, rows: [] }, categories: [], daily: [],
    ...over,
  }
}

describe('profit calculation table', () => {
  it('adds up to the profit the server calculated', () => {
    const r = report()
    expect(profitOf(calculationRows(r))).toBe(r.totals.profit)
  })
  it('marks synced sales, the missing product cost and estimated courier fees honestly', () => {
    const rows = calculationRows(report())
    expect(rows.find((x) => x.label === 'Total sales')?.certainty).toBe('synced')
    expect(rows.find((x) => x.label === 'Product cost')).toMatchObject({ certainty: 'unavailable', warning: expect.stringContaining('1 order sold without a product cost') })
    expect(rows.find((x) => x.label === 'Delivery cost')?.certainty).toBe('estimated')
    expect(rows.find((x) => x.label === 'Ads expense')?.certainty).toBe('actual')
  })
  it('says ad spend is unknown when no ad account is connected and nothing was entered', () => {
    const r = report({ quality: { ...report().quality, ads: { status: 'unavailable', accounts: 0, last_sync_at: null, entries: 0 } } })
    expect(calculationRows(r).find((x) => x.label === 'Ads expense')).toMatchObject({ certainty: 'unavailable', warning: expect.stringContaining('before ads') })
  })
})

describe('revenue allocation', () => {
  it('splits sales into costs and profit that add back up to 100%', () => {
    const a = allocation(report().totals)
    expect(a.sales).toBe(1890)
    expect(a.parts.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(1890, 2)
    expect(a.parts.reduce((s, p) => s + p.pct, 0)).toBeCloseTo(100, 6)
    expect(a.loss).toBe(0)
  })
  it('shows a loss instead of a negative profit slice', () => {
    const t = { ...report().totals, ads: 3000, profit: report().totals.profit - 2700 }
    const a = allocation(t)
    expect(a.parts.find((p) => p.key === 'profit')?.amount).toBe(0)
    expect(a.loss).toBeCloseTo(2700 - report().totals.profit, 2)
  })
  it('has no shares without sales', () => {
    const a = allocation({ ...report().totals, sales: 0 })
    expect(a.parts.every((p) => p.pct === 0)).toBe(true)
  })
})

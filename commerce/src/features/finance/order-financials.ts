import type { OrderFinancials } from '@/services/finance'
import { formatMoney, toNumber } from '@/lib/format'

export type Certainty = 'actual' | 'synced' | 'estimated' | 'unavailable'

export interface AllocationPart {
  key: 'profit' | 'product_cost' | 'delivery_cost' | 'ads' | 'other'
  label: string
  amount: number
  /** Share of sales, 0–100 (0 when there are no sales). */
  pct: number
}

/**
 * Where each taka of sales went. "Other" holds other expenses and refunds less other income and
 * return charges, so the parts always add back up to sales. A loss has no profit part; `loss`
 * then says by how much costs exceed sales.
 */
export function allocation(totals: OrderFinancials['totals']): { parts: AllocationPart[]; sales: number; loss: number } {
  const sales = toNumber(totals.sales)
  const other = toNumber(totals.other_expense) + toNumber(totals.refunds) - toNumber(totals.other_income) - toNumber(totals.return_charges)
  const profit = toNumber(totals.profit)
  const raw: Array<Omit<AllocationPart, 'pct'>> = [
    { key: 'product_cost', label: 'Product cost', amount: toNumber(totals.product_cost) },
    { key: 'delivery_cost', label: 'Delivery cost', amount: toNumber(totals.delivery_cost) },
    { key: 'ads', label: 'Ads expense', amount: toNumber(totals.ads) },
    { key: 'other', label: 'Other expense', amount: other },
    { key: 'profit', label: 'Profit', amount: Math.max(profit, 0) },
  ]
  const parts = raw.map((p) => ({ ...p, pct: sales > 0 ? Math.max(p.amount, 0) / sales * 100 : 0 }))
  return { parts, sales, loss: profit < 0 ? -profit : 0 }
}

export interface CalcRow {
  section: 'Revenue' | 'Expenses'
  label: string
  amount: number
  /** Orders behind the amount, plus entries without an order (ads: entries). */
  count: number | null
  detail: string
  /** Subtracted from profit. */
  negative?: boolean
  certainty?: Certainty
  warning?: string
}

/** The "Profit calculation" table, in the order of the statement. Adds up to totals.profit. */
export function calculationRows(r: OrderFinancials): CalcRow[] {
  const t = r.totals
  const c = r.counts
  const q = r.quality
  const n = (v: number | undefined) => (v === undefined ? 0 : toNumber(v))
  const rows: CalcRow[] = [
    {
      section: 'Revenue', label: 'Total sales', amount: toNumber(t.sales), count: n(c.product_sales),
      detail: `Products ${fmt(t.product_sales)} + delivery charges ${fmt(t.delivery_income)}`,
      certainty: toNumber(q.synced_sales) > 0 ? 'synced' : 'actual',
    },
    { section: 'Revenue', label: 'Return charges', amount: toNumber(t.return_charges), count: n(c.return_charges), detail: 'Advance kept on returned or cancelled orders', certainty: 'actual' },
    { section: 'Revenue', label: 'Other income', amount: toNumber(t.other_income), count: n(c.other_income), detail: 'Courier claims and other income entries', certainty: 'actual' },
    { section: 'Revenue', label: 'Refunds', amount: toNumber(t.refunds), count: n(c.refunds), detail: 'Refunds and partial-delivery returns', negative: true, certainty: 'actual' },
    {
      section: 'Expenses', label: 'Product cost', amount: toNumber(t.product_cost), count: n(c.product_cost), negative: true,
      detail: 'Cost of the products sold (cost price at the time of the order)',
      certainty: q.missing_cost_orders > 0 ? 'unavailable' : 'actual',
      warning: q.missing_cost_orders > 0 ? `${q.missing_cost_orders} order${q.missing_cost_orders === 1 ? '' : 's'} sold without a product cost — counted as 0, not guessed` : undefined,
    },
    {
      section: 'Expenses', label: 'Delivery cost', amount: toNumber(t.delivery_cost), count: n(c.delivery_cost), negative: true,
      detail: 'Courier, COD and return fees',
      certainty: toNumber(q.delivery_cost_estimated) > 0 ? 'estimated' : 'actual',
      warning: toNumber(q.delivery_cost_estimated) > 0 ? `${fmt(q.delivery_cost_estimated)} is the courier's rate, not yet confirmed by the courier` : undefined,
    },
    {
      section: 'Expenses', label: 'Ads expense', amount: toNumber(t.ads), count: q.ads.entries, negative: true,
      detail: q.ads.status === 'synced' ? 'From your connected ad accounts' : q.ads.status === 'manual' ? 'Entered by hand (no ad account connected)' : 'No ad account connected',
      certainty: q.ads.status === 'synced' ? 'synced' : q.ads.status === 'manual' ? 'actual' : 'unavailable',
      warning: q.ads.status === 'unavailable' ? 'Ad spend is unknown, so profit is before ads' : undefined,
    },
    { section: 'Expenses', label: 'Other expense', amount: toNumber(t.other_expense), count: n(c.other_expense), negative: true, detail: 'Salaries, rent, packaging, software, SMS and other expenses', certainty: 'actual' },
  ]
  return rows
}

/** Profit from the rows; equals totals.profit (checked in tests). */
export function profitOf(rows: CalcRow[]): number {
  return Math.round(rows.reduce((s, r) => s + (r.negative ? -r.amount : r.amount), 0) * 100) / 100
}

const fmt = (v: unknown) => formatMoney(v)

export const CERTAINTY: Record<Certainty, { label: string; hint: string; className: string }> = {
  actual: { label: 'Actual', hint: 'Recorded in your books', className: 'bg-emerald-500/10 text-emerald-700' },
  synced: { label: 'Synced', hint: 'Imported from a connected store or ad account', className: 'bg-sky-500/10 text-sky-700' },
  estimated: { label: 'Estimated', hint: 'Courier rate, replaced when the courier reports the real fee', className: 'bg-amber-500/10 text-amber-700' },
  unavailable: { label: 'Unavailable', hint: 'Not configured or not connected — not guessed', className: 'bg-red-500/10 text-red-700' },
}

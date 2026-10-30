import { ChevronDown } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate, formatMoney, formatNumber, formatPercent, formatShortDate, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { EstimatedProfit } from '@/services/reports'

type Totals = EstimatedProfit['totals']

/** Whole taka: the paisa of an estimate are noise. */
const taka = (v: unknown) => formatMoney(Math.round(toNumber(v)))

const INCOME: Array<{ key: keyof Totals; label: string }> = [
  { key: 'other_income', label: 'Other income' },
  { key: 'return_charges', label: 'Return charges paid' },
]
const COSTS: Array<{ key: keyof Totals; label: string; color: string }> = [
  { key: 'product_cost', label: 'Product cost', color: 'bg-sky-500' },
  { key: 'courier_cost', label: 'Courier cost', color: 'bg-violet-500' },
  { key: 'ads', label: 'Ads', color: 'bg-amber-500' },
  { key: 'other_expense', label: 'Other expense', color: 'bg-slate-400' },
]

const HOW = [
  ['Approved', 'An order counts on the day it is approved: its sale, less its product cost and courier charge. Before a parcel is booked, the delivery charge stands in for the courier’s fee.'],
  ['Returned', 'No sale and no product cost, because the goods come back. The courier’s delivery and return charges are a loss, less what the customer paid: an advance, or cash at the door that the courier reports. Paid in full, no loss.'],
  ['Cancelled', 'Nothing, unless the courier charged or you kept the advance.'],
  ['Ads and expenses', 'Counted on their own date, as in your books.'],
  ['The books', 'Finance → Profit & loss counts a sale only once it is delivered, so it shows a different number while orders are on their way.'],
] as const

function period(e: EstimatedProfit) {
  return e.from === e.to ? formatDate(e.to) : `${formatShortDate(e.from)} – ${formatDate(e.to)}`
}

/** How the dashboard's profit is made: approved orders, returns less the charges customers paid, ads and expenses. */
export function EstimatedProfitDialog({ open, onOpenChange, estimate }: { open: boolean; onOpenChange: (open: boolean) => void; estimate: EstimatedProfit | null | undefined }) {
  const t = estimate?.totals
  const n = (k: keyof Totals) => toNumber(t?.[k])
  const profit = n('profit')
  const sales = n('sales')
  const income = sales + n('other_income') + n('return_charges')
  const costs = COSTS.reduce((a, c) => a + n(c.key), 0)
  // Where the money goes: costs and profit as parts of what came in (or of the costs, when they are larger).
  const base = Math.max(income, costs)
  const parts = [...COSTS.map((c) => ({ ...c, value: n(c.key) })), { key: 'profit' as const, label: 'Profit', color: 'bg-emerald-500', value: Math.max(profit, 0) }]
    .filter((p) => p.value > 0)
  const orders = estimate?.orders
  const returns = estimate?.returns
  const quality = estimate?.quality

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="gap-1 pr-8">
          <p className="text-xs text-muted-foreground">Profit{estimate ? ` · ${period(estimate)}` : ''}</p>
          <DialogTitle className={cn('text-3xl font-semibold tracking-[-0.02em] tabular-nums', profit < 0 ? 'text-red-600' : 'text-emerald-600')}>
            {taka(profit)}
          </DialogTitle>
          <DialogDescription>
            {sales > 0 ? `${formatPercent((100 * profit) / sales)} of sales. ` : ''}Orders count from the day they are approved, after every cost.
          </DialogDescription>
        </DialogHeader>

        {base > 0 && (
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img"
            aria-label={parts.map((p) => `${p.label} ${taka(p.value)}`).join(', ')}>
            {parts.map((p) => <span key={p.key} className={cn('h-full', p.color)} style={{ width: `${(100 * p.value) / base}%` }} />)}
          </div>
        )}

        <dl className="grid gap-1.5 rounded-xl border bg-muted/30 p-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt>Sales <span className="text-muted-foreground">· {formatNumber(orders?.approved ?? 0)} approved orders</span></dt>
            <dd className="font-medium tabular-nums">{taka(sales)}</dd>
          </div>
          {INCOME.map((x) => (
            <div key={x.key} className={cn('flex items-baseline justify-between gap-3', n(x.key) === 0 && 'text-muted-foreground')}>
              <dt>{x.label}</dt>
              <dd className="tabular-nums">+{taka(n(x.key))}</dd>
            </div>
          ))}
          {COSTS.map((x) => (
            <div key={x.key} className={cn('flex items-baseline justify-between gap-3', n(x.key) === 0 && 'text-muted-foreground')}>
              <dt className="flex items-center gap-2"><span aria-hidden className={cn('size-2 rounded-full', x.color)} />{x.label}</dt>
              <dd className="tabular-nums">−{taka(n(x.key))}</dd>
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t pt-2.5 font-semibold">
            <dt className="flex items-center gap-2"><span aria-hidden className="size-2 rounded-full bg-emerald-500" />Profit</dt>
            <dd className={cn('tabular-nums', profit < 0 ? 'text-red-600' : 'text-emerald-600')}>{taka(profit)}</dd>
          </div>
        </dl>

        {orders && (
          <div className="grid grid-cols-4 gap-2 text-center">
            {([['Delivered', orders.delivered], ['In progress', orders.open], ['Returned', orders.returned], ['Cancelled', orders.cancelled]] as const).map(([label, count]) => (
              <div key={label} className="rounded-lg border px-1 py-2">
                <p className="text-base font-semibold tabular-nums">{formatNumber(count)}</p>
                <p className="truncate text-[11px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        )}

        {returns && returns.orders > 0 && (
          <div className="rounded-xl border p-3 text-sm">
            <p className="font-medium">{formatNumber(returns.orders)} returned order{returns.orders === 1 ? '' : 's'}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><p className="text-muted-foreground">Courier charges</p><p className="font-medium tabular-nums">{taka(returns.courier_cost)}</p></div>
              <div><p className="text-muted-foreground">Paid by customers</p><p className="font-medium tabular-nums">{taka(returns.paid)}</p></div>
              <div><p className="text-muted-foreground">Loss</p><p className={cn('font-medium tabular-nums', toNumber(returns.loss) > 0 && 'text-red-600')}>{taka(returns.loss)}</p></div>
            </div>
          </div>
        )}

        {quality && (quality.missing_cost > 0 || quality.courier_estimated > 0) && (
          <ul className="grid gap-1 text-xs">
            {quality.missing_cost > 0 && (
              <li className="text-amber-600">
                {formatNumber(quality.missing_cost)} order{quality.missing_cost === 1 ? ' has' : 's have'} products without a cost, so the profit is too high. Add the cost on the product.
              </li>
            )}
            {quality.courier_estimated > 0 && (
              <li className="text-muted-foreground">
                The courier cost of {formatNumber(quality.courier_estimated)} order{quality.courier_estimated === 1 ? ' is' : 's is'} an estimate until the courier reports it.
              </li>
            )}
          </ul>
        )}

        <details className="group rounded-xl border px-4 py-3 text-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
            How it’s counted
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <dl className="mt-3 grid gap-2">
            {HOW.map(([head, body]) => (
              <div key={head}>
                <dt className="font-medium">{head}</dt>
                <dd className="text-muted-foreground">{body}</dd>
              </div>
            ))}
          </dl>
        </details>

        <DialogFooter>
          <Button variant="outline" size="sm" asChild><Link to="/admin/finance/profit-loss">Profit & loss (delivered)</Link></Button>
          <Button size="sm" asChild><Link to="/admin/orders/approved">See the orders</Link></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatDateTime, formatMoney, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { labelOrders } from '@/services/orders'

const MAX = 200

/**
 * Printable sheets for the selected approved orders:
 * - picking: every product to take off the shelf, added up across the orders
 * - sheet: one line per order (hand-over sheet for the courier rider)
 */
export default function OrderSheetsPage() {
  const [params, setParams] = useSearchParams()
  const kind = params.get('kind') === 'sheet' ? 'sheet' : 'picking'
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean), [params])
  const { data: config } = useStoreConfig()
  const orders = useQuery({ queryKey: ['label-orders', ids], enabled: ids.length > 0, queryFn: () => labelOrders(ids) })

  const picking = useMemo(() => {
    const lines = new Map<string, { sku: string | null; name: string; variant: string | null; qty: number; orders: Set<string> }>()
    for (const o of orders.data ?? []) {
      for (const i of o.order_items ?? []) {
        const key = `${i.sku ?? ''}|${i.product_name}|${i.variant_title ?? ''}`
        const line = lines.get(key) ?? { sku: i.sku, name: i.product_name, variant: i.variant_title, qty: 0, orders: new Set<string>() }
        line.qty += i.quantity
        line.orders.add(o.order_number)
        lines.set(key, line)
      }
    }
    return [...lines.values()].sort((a, b) => (a.sku ?? a.name).localeCompare(b.sku ?? b.name))
  }, [orders.data])

  if (!ids.length) return <EmptyState title="Nothing selected" description="Select orders in Approved Orders, then choose Actions → Picking or Sheet." />
  if (orders.isLoading) return <LoadingState />
  if (orders.error) return <ErrorState error={orders.error} />
  const list = orders.data ?? []
  const units = picking.reduce((s, l) => s + l.qty, 0)
  const cod = list.reduce((s, o) => s + Math.max(toNumber(o.total_amount) - toNumber(o.amount_paid), 0), 0)

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link to="/admin/orders/approved" className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4" /> Approved orders</Link>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {(['picking', 'sheet'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setParams((p) => { p.set('kind', k); return p }, { replace: true })}
                className={cn('rounded-md px-3 py-1 text-sm', kind === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                {k === 'picking' ? 'Picking list' : 'Order sheet'}
              </button>
            ))}
          </div>
          <Button onClick={() => window.print()}><Printer /> Print</Button>
        </div>
      </div>
      {ids.length > MAX && <p className="no-print mb-3 text-sm text-amber-700">Only the first {MAX} of {ids.length} selected orders fit on one sheet. Print the rest separately.</p>}

      <div className="rounded-lg border bg-white p-6 text-sm text-black print:border-0 print:p-0">
        <div className="mb-4 flex items-end justify-between border-b pb-3">
          <div>
            <p className="text-lg font-semibold">{kind === 'picking' ? 'Picking list' : 'Order sheet'}</p>
            <p className="text-xs text-gray-600">{config?.store?.name} · {formatDateTime(new Date().toISOString())}</p>
          </div>
          <p className="text-right text-xs text-gray-600">
            {list.length} order{list.length === 1 ? '' : 's'}
            {kind === 'picking' ? ` · ${units} item${units === 1 ? '' : 's'}` : ` · COD to collect ${formatMoney(cod)}`}
          </p>
        </div>

        {kind === 'picking' ? (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-600 uppercase">
                <th className="w-8 py-1.5">✓</th><th className="py-1.5">SKU</th><th className="py-1.5">Product</th>
                <th className="py-1.5 text-right">Qty</th><th className="py-1.5 pl-4">Orders</th>
              </tr>
            </thead>
            <tbody>
              {picking.map((l) => (
                <tr key={`${l.sku}|${l.name}|${l.variant}`} className="border-b align-top">
                  <td className="py-1.5"><span className="inline-block size-4 border border-gray-500" /></td>
                  <td className="py-1.5 font-mono text-xs">{l.sku ?? '—'}</td>
                  <td className="py-1.5">{l.name}{l.variant && <span className="text-gray-600"> · {l.variant}</span>}</td>
                  <td className="py-1.5 text-right text-base font-semibold tabular-nums">{l.qty}</td>
                  <td className="py-1.5 pl-4 text-xs text-gray-600">{[...l.orders].join(', ')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3} className="pt-2 text-right font-medium">Total items</td><td className="pt-2 text-right font-semibold tabular-nums">{units}</td><td /></tr></tfoot>
          </table>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b text-left text-gray-600 uppercase">
                <th className="py-1.5">#</th><th className="py-1.5">Order</th><th className="py-1.5">Customer</th><th className="py-1.5">Address</th>
                <th className="py-1.5">Items</th><th className="py-1.5">Courier · tracking</th><th className="py-1.5 text-right">COD</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o, n) => {
                const s = o.shipments?.find((x) => x.is_active)
                return (
                  <tr key={o.id} className="border-b align-top">
                    <td className="py-1.5 pr-2 text-gray-600">{n + 1}</td>
                    <td className="py-1.5 pr-2 font-medium">{o.order_number}</td>
                    <td className="py-1.5 pr-2">{o.customer_name}<br /><span className="tabular-nums">{o.customer_phone}</span></td>
                    <td className="py-1.5 pr-2">{[o.shipping_address, o.shipping_area, o.shipping_district].filter(Boolean).join(', ')}</td>
                    <td className="py-1.5 pr-2">{(o.order_items ?? []).map((i) => `${i.product_name}${i.variant_title ? ` · ${i.variant_title}` : ''} ×${i.quantity}`).join(', ')}</td>
                    <td className="py-1.5 pr-2">{s ? `${s.couriers?.name ?? ''} ${s.consignment_id ?? s.tracking_number ?? ''}` : 'Not booked'}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{formatMoney(Math.max(toNumber(o.total_amount) - toNumber(o.amount_paid), 0))}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot><tr><td colSpan={6} className="pt-2 text-right font-medium">Total COD</td><td className="pt-2 text-right font-semibold tabular-nums">{formatMoney(cod)}</td></tr></tfoot>
          </table>
        )}
        {kind === 'sheet' && (
          <div className="mt-10 grid grid-cols-2 gap-10 text-xs text-gray-600">
            <p className="border-t pt-1">Handed over by</p>
            <p className="border-t pt-1">Received by (courier)</p>
          </div>
        )}
      </div>
    </div>
  )
}

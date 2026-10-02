import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatDate, formatMoney, toNumber } from '@/lib/format'
import { PAYMENT_METHOD } from '@/lib/status'
import { getOrder } from '@/services/orders'

/** Printable invoice and packing slip (PDF via the browser's print dialog). */
export default function OrderPrintPage() {
  const { id = '' } = useParams()
  const packing = useLocation().pathname.endsWith('packing-slip')
  const { data: config } = useStoreConfig()
  const order = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id) })
  if (order.isLoading) return <LoadingState />
  if (order.error || !order.data) return <ErrorState error={order.error ?? new Error('NOT_FOUND: Order not found')} />
  const o = order.data
  const shipment = o.shipments.find((s) => s.is_active)
  const store = config?.store

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex items-center justify-between">
        <Link to={`/admin/orders/${o.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4" /> Back to order</Link>
        <Button onClick={() => window.print()}><Printer /> Print</Button>
      </div>
      <div className="rounded-lg border bg-white p-8 text-sm text-black print:border-0 print:p-0">
        <div className="flex justify-between gap-6 border-b pb-5">
          <div>
            <p className="text-xl font-semibold">{store?.name}</p>
            {store?.address && <p>{store.address}</p>}
            {store?.phone && <p>{store.phone}</p>}
            {store?.email && <p>{store.email}</p>}
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold">{packing ? 'Packing slip' : 'Invoice'}</p>
            <p className="font-mono">{o.order_number}</p>
            <p>{formatDate(o.created_at)}</p>
            {shipment?.tracking_number && <p>Tracking: {shipment.tracking_number}</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 py-5">
          <div>
            <p className="mb-1 text-xs font-semibold text-gray-500 uppercase">Deliver to</p>
            <p className="font-medium">{o.customer_name}</p>
            <p>{o.customer_phone}</p>
            <p>{o.shipping_address}</p>
            <p>{[o.shipping_area, o.shipping_city, o.shipping_district, o.shipping_postal_code].filter(Boolean).join(', ')}</p>
          </div>
          <div className="text-right">
            <p className="mb-1 text-xs font-semibold text-gray-500 uppercase">Payment</p>
            <p>{PAYMENT_METHOD[o.payment_method]}</p>
            {shipment?.couriers && <p>Courier: {shipment.couriers.name}</p>}
            <p className="mt-2 text-lg font-semibold">Collect: {formatMoney(Math.max(toNumber(o.total_amount) - toNumber(o.amount_paid), 0))}</p>
          </div>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y text-left text-xs text-gray-500 uppercase">
              <th className="py-2">Item</th><th className="py-2">SKU</th><th className="py-2 text-right">Qty</th>
              {!packing && <><th className="py-2 text-right">Price</th><th className="py-2 text-right">Total</th></>}
              {packing && <th className="py-2 text-right">Packed</th>}
            </tr>
          </thead>
          <tbody>
            {o.order_items.map((i) => (
              <tr key={i.id} className="border-b">
                <td className="py-2">{i.product_name}{i.variant_title ? ` — ${i.variant_title}` : ''}</td>
                <td className="py-2 font-mono text-xs">{i.sku}</td>
                <td className="py-2 text-right">{i.quantity}</td>
                {!packing && <><td className="py-2 text-right">{formatMoney(i.unit_price)}</td><td className="py-2 text-right">{formatMoney(i.line_subtotal)}</td></>}
                {packing && <td className="py-2 text-right">☐</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!packing && (
          <dl className="ml-auto mt-4 w-64 space-y-1">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(o.subtotal)}</dd></div>
            {toNumber(o.discount_total) > 0 && <div className="flex justify-between"><dt>Discount</dt><dd>-{formatMoney(o.discount_total)}</dd></div>}
            <div className="flex justify-between"><dt>Delivery</dt><dd>{formatMoney(toNumber(o.delivery_charge) - toNumber(o.delivery_discount))}</dd></div>
            <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total</dt><dd>{formatMoney(o.total_amount)}</dd></div>
            {toNumber(o.amount_paid) > 0 && <div className="flex justify-between"><dt>Paid</dt><dd>-{formatMoney(o.amount_paid)}</dd></div>}
            <div className="flex justify-between font-semibold"><dt>Due on delivery</dt><dd>{formatMoney(Math.max(toNumber(o.total_amount) - toNumber(o.amount_paid), 0))}</dd></div>
          </dl>
        )}
        {o.customer_note && <p className="mt-6 rounded border p-3"><strong>Note:</strong> {o.customer_note}</p>}
        <p className="mt-8 text-center text-xs text-gray-500">Thank you for shopping with {store?.name}.</p>
      </div>
    </div>
  )
}

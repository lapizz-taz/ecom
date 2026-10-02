import { formatDate, formatMoney, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { LabelOrder } from '@/services/orders'
import { Barcode } from './barcode'

export type LabelFormat = '100x150' | '75x100' | 'A4'

export const LABEL_FORMATS: Array<{ value: LabelFormat; label: string; hint: string }> = [
  { value: '100x150', label: '4 × 6 in (100 × 150 mm)', hint: 'Thermal label printer' },
  { value: '75x100', label: '3 × 4 in (75 × 100 mm)', hint: 'Small thermal labels' },
  { value: 'A4', label: 'A4 — 4 labels per sheet', hint: 'Any office printer' },
]

/** Page size for the browser print dialog. */
export function pageCss(format: LabelFormat): string {
  if (format === 'A4') return '@page { size: A4 portrait; margin: 0 }'
  const [w, h] = format.split('x')
  return `@page { size: ${w}mm ${h}mm; margin: 0 }`
}

export interface LabelOptions {
  storeName: string
  storePhone?: string
  showCod: boolean
  showItems: boolean
  note?: string
}

/**
 * One shipping label. Large, high-contrast and barcode-first so it scans
 * reliably at the packing desk and reads clearly for the courier.
 */
export function ShippingLabel({ order, format, options }: { order: LabelOrder; format: LabelFormat; options: LabelOptions }) {
  const shipment = (order.shipments ?? []).find((s) => s.is_active)
  const courierName = (shipment?.couriers as { name: string } | null)?.name
  const tracking = shipment?.tracking_number || shipment?.consignment_id
  const due = Math.max(toNumber(order.total_amount) - toNumber(order.amount_paid), 0)
  const items = order.order_items ?? []
  const totalQty = items.reduce((s, i) => s + i.quantity, 0)
  const small = format === '75x100'
  const size = format === '100x150' ? 'h-[150mm] w-[100mm]' : format === '75x100' ? 'h-[100mm] w-[75mm]' : 'h-[148.5mm] w-[105mm]'

  return (
    <article className={cn('shipping-label flex flex-col overflow-hidden border border-black/80 bg-white text-black', size,
      small ? 'p-[3mm] text-[9pt]' : 'p-[4mm] text-[10pt]')}>
      <header className="flex items-start justify-between gap-2 border-b-2 border-black pb-[2mm]">
        <div className="min-w-0">
          <p className={cn('truncate font-bold leading-tight', small ? 'text-[11pt]' : 'text-[13pt]')}>{options.storeName}</p>
          {options.storePhone && <p className="text-[8pt]">{options.storePhone}</p>}
        </div>
        {options.showCod && (
          <div className="shrink-0 text-right">
            <p className="text-[7pt] font-semibold tracking-wider uppercase">{due > 0 ? 'Collect (COD)' : 'Paid'}</p>
            <p className={cn('leading-none font-extrabold tabular-nums', small ? 'text-[15pt]' : 'text-[20pt]')}>{due > 0 ? formatMoney(due) : '৳0'}</p>
          </div>
        )}
      </header>

      <section className="border-b border-black/60 py-[2mm]">
        <Barcode value={order.order_number} height={small ? 38 : 52} className="h-[13mm] w-full" />
        <div className="mt-[1mm] flex items-baseline justify-between font-mono">
          <span className={cn('font-bold tracking-wider', small ? 'text-[11pt]' : 'text-[13pt]')}>{order.order_number}</span>
          <span className="text-[8pt]">{formatDate(order.created_at)}</span>
        </div>
      </section>

      <section className="flex-1 py-[2mm]">
        <p className="text-[7pt] font-semibold tracking-wider uppercase">Deliver to</p>
        <p className={cn('font-bold leading-tight', small ? 'text-[11pt]' : 'text-[13pt]')}>{order.customer_name}</p>
        <p className={cn('font-mono font-semibold tabular-nums', small ? 'text-[10pt]' : 'text-[12pt]')}>{order.customer_phone}</p>
        <p className="mt-[1mm] leading-snug">{order.shipping_address}</p>
        <p className={cn('mt-[1mm] font-extrabold uppercase', small ? 'text-[11pt]' : 'text-[14pt]')}>
          {order.shipping_district}{order.shipping_area ? <span className="font-semibold normal-case"> · {order.shipping_area}</span> : null}
        </p>
      </section>

      {(courierName || tracking) && (
        <section className="border-t border-black/60 py-[2mm]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{courierName ?? 'Courier'}</span>
            {tracking && <span className="font-mono text-[9pt]">{tracking}</span>}
          </div>
          {tracking && !small && <Barcode value={tracking} height={36} className="mt-[1mm] h-[9mm] w-full" />}
        </section>
      )}

      {options.showItems && items.length > 0 && (
        <section className="border-t border-black/60 pt-[1.5mm] text-[8pt] leading-snug">
          <ul className={cn(small ? 'line-clamp-2' : 'line-clamp-4')}>
            {items.map((i, idx) => (
              <li key={idx} className="truncate">{i.quantity}× {i.product_name}{i.variant_title ? ` (${i.variant_title})` : ''}</li>
            ))}
          </ul>
          <p className="mt-[0.5mm] font-semibold">{totalQty} item{totalQty === 1 ? '' : 's'}</p>
        </section>
      )}
      {(options.note || order.customer_note) && (
        <p className="mt-[1mm] line-clamp-2 border-t border-dashed border-black/60 pt-[1mm] text-[7.5pt]">
          {order.customer_note ? <>Note: {order.customer_note}</> : options.note}
        </p>
      )}
    </article>
  )
}

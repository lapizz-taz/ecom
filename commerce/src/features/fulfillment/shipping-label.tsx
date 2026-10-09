import type { CSSProperties, ReactNode } from 'react'
import { formatDate, formatMoney, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { LabelOrder } from '@/services/orders'
import { Barcode } from './barcode'
import { type LabelBlock, type LabelTemplate, type Paper, chunk, paperOf, TEXT_SCALE } from './label-template'
import { QrCode } from './qr-code'

export interface LabelStore {
  name: string
  phone?: string
  address?: string
  logoUrl?: string | null
  /** Where the order-tracking page lives (for the QR code). */
  siteUrl?: string
}

/** What a label needs from an order (a real order, or the builder's sample). */
export type LabelData = Pick<LabelOrder, 'order_number' | 'created_at' | 'customer_name' | 'customer_phone' | 'shipping_address' |
  'shipping_area' | 'shipping_district' | 'total_amount' | 'amount_paid' | 'customer_note' | 'order_items' | 'shipments'>

const BARCODE_MM = { S: 9, M: 13, L: 17 } as const

/**
 * One shipping label drawn from the template: blocks top to bottom, the
 * customer block takes the free space. Sizes are in mm and pt so the screen
 * preview and the printed label match.
 */
export function ShippingLabel({ order, template, store, paper = paperOf(template) }: {
  order: LabelData
  template: LabelTemplate
  store: LabelStore
  paper?: Paper
}) {
  const shipment = (order.shipments ?? []).find((s) => s.is_active)
  const courierName = (shipment?.couriers as { name: string } | null)?.name
  const tracking = shipment?.consignment_id || shipment?.tracking_number || null
  const due = Math.max(toNumber(order.total_amount) - toNumber(order.amount_paid), 0)
  const items = order.order_items ?? []
  const totalQty = items.reduce((s, i) => s + i.quantity, 0)
  const tiny = paper.height <= 60 || paper.width <= 60
  const blocks = template.blocks.filter((b) => b.enabled)
  const qr = blocks.find((b) => b.id === 'qr')
  const qrBeside = !!qr?.qr_beside_address && blocks.some((b) => b.id === 'recipient')
  const qrValue = qr?.qr_content === 'order' ? order.order_number
    : qr?.qr_content === 'track_page' ? `${(store.siteUrl ?? '').replace(/\/+$/, '')}/track-order?order=${encodeURIComponent(order.order_number)}`
    : tracking ?? order.order_number
  const qrSize = `${Math.round(Math.min(paper.width, paper.height) * (tiny ? 0.32 : 0.24))}mm`

  const style: CSSProperties = {
    width: `${paper.width}mm`, height: `${paper.height}mm`, padding: `${template.padding}mm`,
    fontSize: `${(paper.basePt * TEXT_SCALE[template.text_size]).toFixed(2)}pt`,
  }

  const render = (b: LabelBlock): ReactNode => {
    switch (b.id) {
      case 'header':
        return (
          <header key={b.id} className="flex items-start justify-between gap-[2mm] border-b-2 border-black pb-[1.5mm]">
            <div className="flex min-w-0 items-center gap-[2mm]">
              {b.show_logo && store.logoUrl && <img src={store.logoUrl} alt="" className="h-[2.4em] w-auto max-w-[30mm] object-contain grayscale" />}
              <div className="min-w-0">
                <p className="truncate text-[1.3em] leading-tight font-bold">{store.name}</p>
                {b.show_phone && store.phone && <p className="text-[0.8em] leading-tight">{store.phone}</p>}
              </div>
            </div>
            {b.show_cod && (
              <div className="shrink-0 text-right">
                <p className="text-[0.7em] font-semibold tracking-wider uppercase">{due > 0 ? 'Collect (COD)' : 'Paid'}</p>
                <p className="text-[2em] leading-none font-extrabold tabular-nums">{due > 0 ? formatMoney(due) : formatMoney(0)}</p>
              </div>
            )}
          </header>
        )
      case 'order_barcode': {
        const mm = BARCODE_MM[b.barcode_height ?? 'M'] * (tiny ? 0.7 : paper.width < 90 ? 0.85 : 1)
        return (
          <section key={b.id} className="border-b border-black/60 py-[1.5mm]">
            <Barcode value={order.order_number} height={60} className="block w-full" style={{ height: `${mm}mm` }} />
            <div className="mt-[0.8mm] flex items-baseline justify-between gap-2 font-mono">
              <span className="text-[1.3em] font-bold tracking-wider">{order.order_number}</span>
              {b.show_date && <span className="text-[0.8em]">{formatDate(order.created_at)}</span>}
            </div>
          </section>
        )
      }
      case 'recipient':
        return (
          <section key={b.id} className="flex flex-[1_0_auto] gap-[2mm] py-[1.5mm]">
            <div className="min-w-0 flex-1">
              <p className="text-[0.7em] font-semibold tracking-wider uppercase">Deliver to</p>
              <p className="text-[1.3em] leading-tight font-bold break-words">{order.customer_name}</p>
              <p className="font-mono text-[1.2em] font-semibold tabular-nums">{order.customer_phone}</p>
              <p className="mt-[0.8mm] leading-snug break-words">{order.shipping_address}</p>
              <p className={cn('mt-[0.8mm] font-extrabold uppercase', b.big_district ? 'text-[1.4em]' : 'text-[1.05em]')}>
                {order.shipping_district}{order.shipping_area ? <span className="font-semibold normal-case"> · {order.shipping_area}</span> : null}
              </p>
            </div>
            {qrBeside && (
              <div className="shrink-0 text-center">
                <QrCode value={qrValue} className="block" style={{ width: 'var(--qr)', height: 'var(--qr)' }} />
              </div>
            )}
          </section>
        )
      case 'qr':
        if (qrBeside) return null
        return (
          <section key={b.id} className="flex items-center justify-center gap-[2mm] border-t border-black/60 py-[1.5mm]">
            <QrCode value={qrValue} className="block shrink-0" style={{ width: 'var(--qr)', height: 'var(--qr)' }} />
            <span className="max-w-[50%] font-mono text-[0.8em] break-all">{qr?.qr_content === 'track_page' ? 'Scan to track your order' : qrValue}</span>
          </section>
        )
      case 'courier':
        if (!courierName && !tracking) return null
        return (
          <section key={b.id} className="border-t border-black/60 py-[1.5mm]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{courierName ?? 'Courier'}</span>
              {tracking && <span className="font-mono text-[0.9em]">{tracking}</span>}
            </div>
            {tracking && b.show_barcode && !tiny && <Barcode value={tracking} height={50} className="mt-[0.8mm] block w-full" style={{ height: `${paper.width < 90 ? 7 : 9}mm` }} />}
          </section>
        )
      case 'items': {
        if (!items.length) return null
        const max = Math.max(1, b.max_items ?? 4)
        const shown = items.slice(0, max)
        return (
          <section key={b.id} className="border-t border-black/60 pt-[1mm] text-[0.8em] leading-snug">
            <ul>
              {shown.map((i, idx) => (
                <li key={idx} className="truncate">{i.quantity}× {i.product_name}{i.variant_title ? ` (${i.variant_title})` : ''}{b.show_sku && i.sku ? ` · ${i.sku}` : ''}</li>
              ))}
            </ul>
            <p className="font-semibold">{totalQty} item{totalQty === 1 ? '' : 's'}{items.length > shown.length ? ` · +${items.length - shown.length} more` : ''}</p>
          </section>
        )
      }
      case 'note': {
        const text = [order.customer_note ? `Note: ${order.customer_note}` : null, b.text?.trim() || null].filter(Boolean)
        if (!text.length) return null
        return <p key={b.id} className="mt-[0.8mm] line-clamp-3 border-t border-dashed border-black/60 pt-[0.8mm] text-[0.75em] break-words">{text.join(' · ')}</p>
      }
      case 'custom_text':
        if (!b.text?.trim()) return null
        return <p key={b.id} className={cn('mt-[0.8mm] border border-black px-[1.5mm] py-[0.5mm] text-center break-words', b.bold && 'font-bold uppercase')}>{b.text}</p>
      case 'return_address':
        if (!store.address) return null
        return (
          <p key={b.id} className="mt-[0.8mm] border-t border-black/60 pt-[0.8mm] text-[0.7em] leading-snug break-words">
            <span className="font-semibold">If undelivered, return to:</span> {store.name}, {store.address}{store.phone ? `, ${store.phone}` : ''}
          </p>
        )
    }
  }

  return (
    <article className={cn('shipping-label flex flex-col overflow-hidden bg-white leading-normal text-black', template.border && 'outline outline-1 -outline-offset-[1.5mm] outline-black')}
      style={{ ...style, ['--qr' as string]: qrSize }}>
      {blocks.map(render)}
    </article>
  )
}

/**
 * The printed pages: one label per page on label paper, or a grid of labels
 * on each A4 sheet. Used both on screen (preview) and inside the print frame.
 */
export function LabelPages({ orders, template, store }: { orders: LabelData[]; template: LabelTemplate; store: LabelStore }) {
  const paper = paperOf(template)
  if (paper.sheet) {
    const per = paper.sheet.columns * paper.sheet.rows
    return (
      <>
        {chunk(orders, per).map((group, i) => (
          <div key={i} className="label-page grid bg-white"
            style={{ width: '210mm', height: '297mm', gridTemplateColumns: `repeat(${paper.sheet!.columns}, ${paper.width}mm)`, gridTemplateRows: `repeat(${paper.sheet!.rows}, ${paper.height}mm)` }}>
            {group.map((o) => <ShippingLabel key={o.order_number} order={o} template={template} store={store} paper={paper} />)}
          </div>
        ))}
      </>
    )
  }
  return (
    <>
      {orders.map((o) => (
        <div key={o.order_number} className="label-page bg-white" style={{ width: `${paper.width}mm`, height: `${paper.height}mm` }}>
          <ShippingLabel order={o} template={template} store={store} paper={paper} />
        </div>
      ))}
    </>
  )
}

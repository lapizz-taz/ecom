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
  'shipping_area' | 'shipping_district' | 'total_amount' | 'amount_paid' | 'customer_note' | 'order_items' | 'shipments'> &
  Partial<Pick<LabelOrder, 'subtotal' | 'delivery_charge' | 'delivery_discount' | 'discount_total' | 'delivery_method' | 'payment_method'>>

const BARCODE_MM = { S: 9, M: 13, L: 17 } as const
const SIZE_EM = { S: 0.85, M: 1, L: 1.3 } as const
const DELIVERY: Record<string, string> = { standard: 'Home delivery', express: 'Express delivery', pickup: 'Store pickup', same_day: 'Same-day delivery' }

/**
 * One label (or invoice page) drawn from the template: blocks top to bottom,
 * the customer block takes the free space. Sizes are in mm and pt so the
 * screen preview and the printed page match. `wrap` lets the builder make
 * each block selectable.
 */
export function ShippingLabel({ order, template, store, paper = paperOf(template), wrap }: {
  order: LabelData
  template: LabelTemplate
  store: LabelStore
  paper?: Paper
  wrap?: (block: LabelBlock, node: ReactNode) => ReactNode
}) {
  const shipment = (order.shipments ?? []).find((s) => s.is_active)
  const courierName = (shipment?.couriers as { name: string } | null)?.name
  const tracking = shipment?.consignment_id || shipment?.tracking_number || null
  const due = Math.max(toNumber(order.total_amount) - toNumber(order.amount_paid), 0)
  const items = order.order_items ?? []
  const totalQty = items.reduce((s, i) => s + i.quantity, 0)
  const tiny = paper.height <= 60 || paper.width <= 60
  const wide = paper.width >= 140
  const blocks = template.blocks.filter((b) => b.enabled)
  const qr = blocks.find((b) => b.id === 'qr')
  const qrBeside = !!qr?.qr_beside_address && blocks.some((b) => b.id === 'recipient')
  const qrValue = qr?.qr_content === 'order' ? order.order_number
    : qr?.qr_content === 'track_page' ? `${(store.siteUrl ?? '').replace(/\/+$/, '')}/track-order?order=${encodeURIComponent(order.order_number)}`
    : tracking ?? order.order_number
  const qrSize = `${Math.round(Math.min(paper.width, Math.min(paper.height, 150)) * (tiny ? 0.32 : wide ? 0.16 : 0.24))}mm`
  const subtotal = order.subtotal ?? items.reduce((s, i) => s + toNumber((i as { line_subtotal?: number }).line_subtotal ?? toNumber((i as { unit_price?: number }).unit_price) * i.quantity), 0)
  const delivery = toNumber(order.delivery_charge) - toNumber(order.delivery_discount)

  const style: CSSProperties = {
    width: `${paper.width}mm`, padding: `${template.padding}mm`,
    ...(template.grow ? { minHeight: `${paper.height}mm` } : { height: `${paper.height}mm` }),
    fontSize: `${(paper.basePt * TEXT_SCALE[template.text_size]).toFixed(2)}pt`,
  }
  const textStyle = (b: LabelBlock): CSSProperties => ({ textAlign: b.align, fontSize: b.size ? `${SIZE_EM[b.size]}em` : undefined })

  const render = (b: LabelBlock): ReactNode => {
    switch (b.id) {
      case 'header':
        return (
          <header className="flex items-start justify-between gap-[2mm] border-b-2 border-black pb-[1.5mm]">
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
                <p className="text-[2em] leading-none font-extrabold tabular-nums">{formatMoney(due)}</p>
              </div>
            )}
          </header>
        )
      case 'business_header':
        return (
          <header className={cn('flex items-center gap-[3mm] pb-[1.5mm]', b.align === 'center' && 'flex-col text-center', b.align === 'right' && 'flex-row-reverse text-right')}>
            {b.show_logo && store.logoUrl && <img src={store.logoUrl} alt="" className="h-[3em] w-auto max-w-[40mm] object-contain" />}
            <div className="min-w-0">
              <p className="text-[1.5em] leading-tight font-bold">{store.name}</p>
              {store.address && <p className="text-[0.85em] leading-snug">{store.address}</p>}
              {b.show_phone && store.phone && <p className="text-[0.85em]">{store.phone}</p>}
            </div>
          </header>
        )
      case 'logo':
        return store.logoUrl
          ? <div className="py-[1mm]" style={{ textAlign: b.align }}><img src={store.logoUrl} alt="" className="inline-block w-auto object-contain" style={{ height: `${b.size === 'S' ? 8 : b.size === 'L' ? 18 : 12}mm` }} /></div>
          : <p className="py-[1mm] text-[1.3em] font-bold" style={{ textAlign: b.align }}>{store.name}</p>
      case 'invoice_header':
        return (
          <section className="grid grid-cols-2 gap-[3mm] border-b border-black pb-[1.5mm]">
            <div className="min-w-0">
              <p className="truncate text-[1.25em] leading-tight font-bold">{store.name}</p>
              <p className="font-mono text-[0.95em]">Invoice: {order.order_number}</p>
              {b.show_date && <p className="text-[0.85em]">Date: {formatDate(order.created_at)}</p>}
            </div>
            {b.show_customer !== false && (
              <div className="min-w-0 text-right">
                <p className="truncate font-bold">{order.customer_name}</p>
                <p className="line-clamp-3 text-[0.85em] leading-snug break-words">{[order.shipping_address, order.shipping_area, order.shipping_district].filter(Boolean).join(', ')}</p>
                <p className="font-mono font-semibold tabular-nums">{order.customer_phone}</p>
              </div>
            )}
          </section>
        )
      case 'order_barcode': {
        const mm = BARCODE_MM[b.barcode_height ?? 'M'] * (tiny ? 0.7 : paper.width < 90 ? 0.85 : 1)
        return (
          <section className="border-b border-black/60 py-[1.5mm]">
            <Barcode value={order.order_number} height={60} className={cn('block', wide ? 'mx-auto w-1/2' : 'w-full')} style={{ height: `${mm}mm` }} />
            <div className="mt-[0.8mm] flex items-baseline justify-between gap-2 font-mono">
              <span className="text-[1.3em] font-bold tracking-wider">{order.order_number}</span>
              {b.show_date && <span className="text-[0.8em]">{formatDate(order.created_at)}</span>}
            </div>
          </section>
        )
      }
      case 'recipient':
        return (
          <section className={cn('flex gap-[2mm] py-[1.5mm]', !template.grow && 'flex-[1_0_auto]')}>
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
          <section className="flex items-center gap-[2mm] py-[1.5mm]" style={{ justifyContent: b.align === 'left' ? 'flex-start' : b.align === 'right' ? 'flex-end' : 'center' }}>
            <QrCode value={qrValue} className="block shrink-0" style={{ width: 'var(--qr)', height: 'var(--qr)' }} />
            <span className="max-w-[50%] font-mono text-[0.8em] break-all">{qr?.qr_content === 'track_page' ? 'Scan to track your order' : qrValue}</span>
          </section>
        )
      case 'courier':
        if (!courierName && !tracking) return null
        return (
          <section className="border-b border-black/60 py-[1.5mm]">
            {tracking && b.show_barcode && !tiny && <Barcode value={tracking} height={50} className={cn('block', wide ? 'mx-auto w-1/2' : 'w-full')} style={{ height: `${paper.width < 90 ? 8 : 11}mm` }} />}
            <div className="mt-[0.5mm] flex items-baseline justify-between gap-2">
              <span className="font-semibold">{courierName ?? 'Courier'}</span>
              {tracking && <span className="font-mono text-[0.9em] font-semibold">{tracking}</span>}
            </div>
          </section>
        )
      case 'cod_badge':
        return (
          <section className="py-[1.5mm]" style={{ textAlign: b.align }}>
            <span className="inline-block rounded-[1mm] border-2 border-black px-[3mm] py-[1mm]">
              <span className="block text-[0.7em] font-semibold tracking-wider uppercase">{due > 0 ? 'Cash on delivery' : 'Paid — collect nothing'}</span>
              <span className="block leading-none font-extrabold tabular-nums" style={{ fontSize: `${b.size === 'S' ? 1.4 : b.size === 'M' ? 1.8 : 2.3}em` }}>{formatMoney(due)}</span>
            </span>
          </section>
        )
      case 'delivery_method':
        return (
          <p className="py-[1mm]" style={textStyle(b)}>
            <span className="font-semibold">{DELIVERY[order.delivery_method ?? ''] ?? (order.delivery_method ? order.delivery_method.replace(/_/g, ' ') : 'Home delivery')}</span>
            {courierName && <span> · {courierName}</span>}
          </p>
        )
      case 'items': {
        if (!items.length) return null
        const max = Math.max(1, b.max_items ?? 4)
        const shown = items.slice(0, max)
        return (
          <section className="border-t border-black/60 pt-[1mm] text-[0.8em] leading-snug">
            <ul>
              {shown.map((i, idx) => (
                <li key={idx} className="truncate">{i.quantity}× {i.product_name}{i.variant_title ? ` (${i.variant_title})` : ''}{b.show_sku && i.sku ? ` · ${i.sku}` : ''}</li>
              ))}
            </ul>
            <p className="font-semibold">{totalQty} item{totalQty === 1 ? '' : 's'}{items.length > shown.length ? ` · +${items.length - shown.length} more` : ''}</p>
          </section>
        )
      }
      case 'product_table': {
        if (!items.length) return null
        const max = template.grow ? items.length : Math.max(1, b.max_items ?? 8)
        const shown = items.slice(0, max)
        return (
          <table className="mt-[1mm] w-full border-collapse text-[0.85em] leading-snug">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="py-[0.6mm] font-semibold">Product</th>
                <th className="w-[9%] py-[0.6mm] text-center font-semibold">Qty</th>
                <th className="w-[18%] py-[0.6mm] text-right font-semibold">Price</th>
                <th className="w-[20%] py-[0.6mm] text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i, idx) => {
                const unit = toNumber((i as { unit_price?: number }).unit_price)
                const line = toNumber((i as { line_subtotal?: number }).line_subtotal ?? unit * i.quantity)
                return (
                  <tr key={idx} className="border-b border-black/30 align-top">
                    <td className="py-[0.6mm] pr-[1mm] break-words">{i.product_name}{i.variant_title && i.variant_title !== 'Default' ? <span className="block text-[0.85em]">{i.variant_title}{b.show_sku && i.sku ? ` · ${i.sku}` : ''}</span> : b.show_sku && i.sku ? <span className="block text-[0.85em]">{i.sku}</span> : null}</td>
                    <td className="py-[0.6mm] text-center tabular-nums">{i.quantity}</td>
                    <td className="py-[0.6mm] text-right tabular-nums">{formatMoney(unit)}</td>
                    <td className="py-[0.6mm] text-right tabular-nums">{formatMoney(line)}</td>
                  </tr>
                )
              })}
            </tbody>
            {items.length > shown.length && (
              <tfoot><tr><td colSpan={4} className="pt-[0.6mm] text-[0.85em]">+{items.length - shown.length} more product{items.length - shown.length === 1 ? '' : 's'}</td></tr></tfoot>
            )}
          </table>
        )
      }
      case 'price_summary': {
        const rows: Array<[string, number, boolean?]> = [
          ['Sub total', toNumber(subtotal)],
          ['Delivery', delivery],
          ['Discount', -toNumber(order.discount_total)],
          ...(b.show_advance !== false ? [['Advance', -toNumber(order.amount_paid)] as [string, number]] : []),
        ]
        return (
          <section className="ml-auto mt-[1.5mm] w-[62%] min-w-[45mm] text-[0.9em]">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 py-[0.2mm]">
                <span>{label}</span><span className="tabular-nums">{value < 0 ? `−${formatMoney(Math.abs(value))}` : formatMoney(value)}</span>
              </div>
            ))}
            <div className="mt-[0.6mm] flex justify-between gap-2 border-t-2 border-black pt-[0.6mm] text-[1.25em] font-extrabold">
              <span>{due > 0 ? 'COD' : 'Paid'}</span><span className="tabular-nums">{formatMoney(due)}</span>
            </div>
          </section>
        )
      }
      case 'note': {
        const text = [order.customer_note ? `Note: ${order.customer_note}` : null, b.text?.trim() || null].filter(Boolean)
        if (!text.length) return null
        return <p className="mt-[0.8mm] line-clamp-3 border-t border-dashed border-black/60 pt-[0.8mm] text-[0.75em] break-words">{text.join(' · ')}</p>
      }
      case 'custom_text':
        if (!b.text?.trim()) return null
        return <p className={cn('mt-[0.8mm] break-words', b.bold && 'border border-black px-[1.5mm] py-[0.5mm] font-bold uppercase')} style={textStyle(b)}>{b.text}</p>
      case 'divider':
        return <hr className={cn('my-[1.2mm] border-0 border-t border-black', b.dashed && 'border-dashed')} />
      case 'return_address':
        if (!store.address) return null
        return (
          <p className="mt-[0.8mm] border-t border-black/60 pt-[0.8mm] text-[0.7em] leading-snug break-words">
            <span className="font-semibold">If undelivered, return to:</span> {store.name}, {store.address}{store.phone ? `, ${store.phone}` : ''}
          </p>
        )
    }
  }

  return (
    <article className={cn('shipping-label flex flex-col overflow-hidden bg-white leading-normal text-black', template.border && 'outline outline-1 -outline-offset-[1.5mm] outline-black')}
      style={{ ...style, ['--qr' as string]: qrSize }}>
      {blocks.map((b) => {
        const node = render(b)
        const key = b.uid ?? b.id
        const fill = b.id === 'recipient' && !template.grow
        return <div key={key} className={cn(fill && 'flex flex-[1_0_auto] flex-col [&>*]:flex-1')}>{wrap ? wrap(b, node) : node}</div>
      })}
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
            {group.map((o) => <ShippingLabel key={o.order_number} order={o} template={{ ...template, grow: false }} store={store} paper={paper} />)}
          </div>
        ))}
      </>
    )
  }
  return (
    <>
      {orders.map((o) => (
        <div key={o.order_number} className="label-page bg-white" style={{ width: `${paper.width}mm`, ...(template.grow ? { minHeight: `${paper.height}mm` } : { height: `${paper.height}mm` }) }}>
          <ShippingLabel order={o} template={template} store={store} paper={paper} />
        </div>
      ))}
    </>
  )
}

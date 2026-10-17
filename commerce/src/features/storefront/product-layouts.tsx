import {
  ArrowLeft, ArrowRight, Banknote, BadgeCheck, ChevronDown, MapPin, Minus, Plus, RotateCcw, ShieldCheck, ShoppingBag, Truck, Users,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import type { ProductDetail } from '@/types/domain'
import { isThemePreview, type ProductAccordion, type ProductPageSettings } from './theme'

// Pieces of the product page shared by its layouts (classic, bold, minimal).
// The buttons look the same in every layout.

const box = 'rounded-[var(--radius)]'

/** Quantity box, "Add to cart" and "Buy it now". */
export function BuyButtons({ pp, quantity, max, onQuantity, disabled, onAdd, onBuy }: {
  pp: ProductPageSettings; quantity: number; max: number; onQuantity: (v: number) => void; disabled: boolean; onAdd: () => void; onBuy: () => void
}) {
  const radius = { borderRadius: pp.button_radius }
  const action = cn('inline-flex h-12 w-full items-center justify-center gap-2 px-4 text-[13px] font-semibold tracking-wide uppercase transition-opacity disabled:cursor-not-allowed disabled:opacity-40')
  return (
    <div className="grid gap-3">
      <div className="flex gap-3">
        {pp.show_quantity && (
          <div style={radius} className="inline-flex h-12 shrink-0 items-center border border-foreground">
            <button type="button" aria-label="Decrease quantity" onClick={() => onQuantity(quantity - 1)} disabled={quantity <= 1}
              className="grid h-full w-10 place-items-center disabled:opacity-35 [&_svg]:size-4"><Minus /></button>
            <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">{quantity}</span>
            <button type="button" aria-label="Increase quantity" onClick={() => onQuantity(quantity + 1)} disabled={quantity >= max}
              className="grid h-full w-10 place-items-center disabled:opacity-35 [&_svg]:size-4"><Plus /></button>
          </div>
        )}
        <button type="button" disabled={disabled} onClick={onAdd} style={radius} className={cn(action, 'flex-1 bg-foreground text-background hover:opacity-90')}>
          <ShoppingBag className="size-4" /> Add to cart
        </button>
      </div>
      {pp.show_buy_now && (
        <button type="button" disabled={disabled} onClick={onBuy} style={radius}
          className={cn(action, pp.buy_now_style === 'filled' ? 'bg-foreground text-background hover:opacity-90' : 'border border-foreground hover:bg-foreground hover:text-background')}>
          Buy it now
        </button>
      )}
    </div>
  )
}

/** Green / orange / red dot with "In stock", "5 left" or "Out of stock". */
export function StockDot({ inStock, available, missing }: { inStock: boolean; available: number | null; missing: boolean }) {
  const [dot, halo, text] = missing ? ['bg-zinc-400', 'bg-zinc-400/25', 'Not available'] : !inStock ? ['bg-red-500', 'bg-red-500/25', 'Out of stock']
    : available !== null && available <= 5 ? ['bg-orange-400', 'bg-orange-400/25', `${available} left`] : ['bg-emerald-500', 'bg-emerald-500/25', 'In stock']
  return (
    <p className="flex items-center gap-2 text-[13px]">
      <span className={cn('grid size-4 place-items-center rounded-full', halo)}>
        <span className={cn('size-2.5 rounded-full', dot)} />
      </span>
      {text}
    </p>
  )
}

/** One large photo at a time, edge to edge, with arrows, swipe and a "1 / 3" counter. */
export function EdgeGallery({ product, index, onIndex, aspect, background }: {
  product: ProductDetail; index: number; onIndex: (i: number) => void; aspect: 'portrait' | 'square'; background: string
}) {
  const count = product.images.length
  const image = product.images[index] ?? product.images[0]
  const touch = useRef<number | null>(null)
  const go = (d: number) => count > 1 && onIndex((index + d + count) % count)
  const arrow = 'absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-white/80 text-black shadow-sm backdrop-blur transition-opacity hover:bg-white [&_svg]:size-4'
  return (
    <div className={cn('relative overflow-hidden', aspect === 'square' ? 'aspect-square' : 'aspect-[4/5]')} style={{ background }}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX }}
      onTouchEnd={(e) => {
        if (touch.current === null) return
        const dx = e.changedTouches[0].clientX - touch.current
        touch.current = null
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
      }}>
      {image && <img src={imageUrl(image.url, 1400)} alt={image.alt || product.name} className="size-full object-cover" />}
      {count > 1 && (
        <>
          <button type="button" aria-label="Previous image" onClick={() => go(-1)} className={cn(arrow, 'left-3 hidden md:grid')}><ArrowLeft /></button>
          <button type="button" aria-label="Next image" onClick={() => go(1)} className={cn(arrow, 'right-3 hidden md:grid')}><ArrowRight /></button>
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-0.5 text-xs font-medium text-white tabular-nums">
            {index + 1} / {count}
          </span>
        </>
      )}
    </div>
  )
}

/** "COLOR : BLACK" with photo swatches when each value has its own photo, else text buttons. */
export function OptionPicker({ product, name, values, selected, onSelect, isAvailable }: {
  product: ProductDetail; name: string; values: string[]; selected: string | undefined; onSelect: (v: string) => void; isAvailable: (v: string) => boolean
}) {
  const photoOf = (value: string) => {
    const ids = new Set(product.variants.filter((v) => v.option_values?.[name] === value).map((v) => v.id))
    return product.images.find((img) => img.variant_id && ids.has(img.variant_id))
  }
  const photos = values.map(photoOf)
  const usePhotos = values.length > 1 && photos.every(Boolean)
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-medium tracking-wide uppercase">{name} : <span className="font-normal text-muted-foreground">{selected}</span></p>
      <div className="flex flex-wrap gap-2">
        {values.map((value, i) => {
          const active = selected === value
          const available = isAvailable(value)
          return usePhotos ? (
            <button key={value} type="button" onClick={() => onSelect(value)} aria-pressed={active} aria-label={value} title={value}
              className={cn('size-[58px] overflow-hidden border p-1 transition-colors', active ? 'border-foreground' : 'border-border hover:border-foreground/60', !available && 'opacity-40')}>
              <img src={imageUrl(photos[i]!.url, 160)} alt="" className="size-full object-cover" loading="lazy" />
            </button>
          ) : (
            <button key={value} type="button" onClick={() => onSelect(value)} aria-pressed={active}
              className={cn(box, 'min-w-12 border px-3 py-2 text-xs transition-colors',
                active ? 'border-foreground bg-foreground text-background' : 'hover:border-foreground', !available && 'text-muted-foreground line-through decoration-1')}>
              {value}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function accordionText(row: ProductAccordion, product: ProductDetail): string {
  if (row.content === 'description') return product.description ?? ''
  if (row.content === 'shipping') return product.shipping_note ?? ''
  if (row.content === 'warranty') return product.warranty ?? ''
  return row.text
}

/** Product Details / Shipping Details / Care, one open at a time. Rows with no text are left out. */
export function ProductAccordions({ rows, product, variant }: { rows: ProductAccordion[]; product: ProductDetail; variant: 'plus' | 'chevron' }) {
  const [open, setOpen] = useState<number | null>(null)
  const preview = isThemePreview()
  const shown = rows.map((row, i) => ({ row, i, text: accordionText(row, product).trim() })).filter((x) => x.row.title.trim() && (x.text || preview))
  if (!shown.length) return null
  return (
    <div className="border-t">
      {shown.map(({ row, i, text }) => {
        const isOpen = open === i
        return (
          <div key={i} className="border-b">
            <button type="button" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}
              className={cn('flex w-full items-center justify-between gap-3 py-4 text-left text-sm', variant === 'chevron' && 'uppercase')}>
              {row.title}
              {variant === 'chevron'
                ? <ChevronDown className={cn('size-4 shrink-0 transition-transform', isOpen && 'rotate-180')} />
                : isOpen ? <Minus className="size-4 shrink-0" /> : <Plus className="size-4 shrink-0" />}
            </button>
            {isOpen && (
              <div className="pb-4 text-[13px] leading-relaxed whitespace-pre-line text-muted-foreground">
                {text || 'Nothing here on this product yet. The text comes from the product, or type it in the theme editor.'}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
function dayRange(from: Date, to: Date): string {
  if (from.toDateString() === to.toDateString()) return day(from)
  return from.getMonth() === to.getMonth() ? `${day(from)} – ${to.getDate()}` : `${day(from)} – ${day(to)}`
}

/** Purchased → Processing → Delivered, dated from today. */
export function DeliveryTimeline({ minDays, maxDays }: { minDays: number; maxDays: number }) {
  const today = new Date()
  const plus = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d }
  const steps: Array<{ icon: ReactNode; date: string; label: string }> = [
    { icon: <ShoppingBag />, date: day(today), label: 'Purchased' },
    { icon: <Truck />, date: day(today), label: 'Processing' },
    { icon: <MapPin />, date: dayRange(plus(minDays), plus(maxDays)), label: 'Delivered' },
  ]
  return (
    <div className={cn(box, 'bg-muted/70 px-4 py-3')}>
      <div className="flex items-center">
        {steps.map((s, i) => (
          <div key={s.label} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
            <span className="[&_svg]:size-6 [&_svg]:stroke-[1.5]">{s.icon}</span>
            {i < steps.length - 1 && (
              <span className="mx-2 flex flex-1 items-center">
                <span className="size-1.5 rounded-full bg-foreground" /><span className="h-0.5 flex-1 bg-foreground" /><span className="size-1.5 rounded-full bg-foreground" />
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs">
        {steps.map((s, i) => (
          <div key={s.label} className={cn(i === 1 ? 'text-center' : i === 2 ? 'text-right' : '')}>
            <p className="text-[11px] font-semibold">{s.date}</p>
            <p>{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function highlightIcon(text: string): ReactNode {
  const t = text.toLowerCase()
  if (/customer|happy|review|people/.test(t)) return <Users />
  if (/deliver|ship|courier/.test(t)) return <Truck />
  if (/return|exchange|refund/.test(t)) return <RotateCcw />
  if (/cash|cod|pay/.test(t)) return <Banknote />
  if (/warrant|secure|original|authentic|guarantee/.test(t)) return <ShieldCheck />
  return <BadgeCheck />
}

/** "600+ Happy Customers", "Delivery Within 48–72 Hours" — the icon follows the words. */
export function Highlights({ items }: { items: string[] }) {
  const list = items.map((x) => x.trim()).filter(Boolean)
  if (!list.length) return null
  return (
    <div className="grid gap-4 py-2" style={{ gridTemplateColumns: `repeat(${list.length}, minmax(0, 1fr))` }}>
      {list.map((text) => (
        <div key={text} className="grid justify-items-center gap-1.5 text-center text-[11px] sm:text-xs">
          <span className="[&_svg]:size-5 [&_svg]:stroke-[1.5]">{highlightIcon(text)}</span>
          {text}
        </div>
      ))}
    </div>
  )
}

/** A small grey note; **words** are bold. */
export function PromoNote({ text }: { text: string }) {
  if (!text.trim()) return null
  const parts = text.split('**')
  return (
    <p className="w-fit bg-muted px-2 py-1.5 text-xs">
      {parts.map((p, i) => (i % 2 ? <strong key={i} className="font-semibold italic">{p}</strong> : <span key={i}>{p}</span>))}
    </p>
  )
}

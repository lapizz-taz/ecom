import { useQuery } from '@tanstack/react-query'
import { Check, ClipboardCopy, Clock, Plus, ShieldCheck, Star, Truck, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useCart } from '@/features/cart/cart-store'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { getProduct, listProducts } from '@/services/storefront'
import type { ProductCard, ProductDetail, ProductVariantPublic } from '@/types/domain'
import {
  activeBlock, bundleApplies, bundlePercent, bundleTiers, bundleUnitPrice, PRODUCT_BLOCKS, type ProductBlock,
} from './product-blocks'
import { SectionFrame } from './sections'

// The product page blocks (product-blocks.ts) as the customer sees them. Each one hides itself
// when it has nothing true to show (no rating typed in, a timer that has ended, no zones with times).

export interface BlockContext {
  product: ProductDetail
  variant: ProductVariantPublic | undefined
  quantity: number
  max: number
  setQuantity: (n: number) => void
  /** Add-on products the customer ticked: added together with the product. */
  addons: ProductCard[]
  setAddons: (cards: ProductCard[]) => void
}

const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const rows = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [])
const box = 'rounded-[var(--radius)]'

/** The blocks above (or below) the buy buttons, in the merchant's order. */
export function ProductBlocks({ blocks, place, ctx }: { blocks: ProductBlock[]; place: 'above' | 'below'; ctx: BlockContext }) {
  const at = blocks.findIndex((b) => b.type === 'buttons')
  const list = place === 'above' ? blocks.slice(0, Math.max(0, at)) : blocks.slice(at + 1)
  return (
    <>
      {list.filter((b) => b.enabled).map((b) => {
        const body = renderBlock(b, ctx)
        return body ? <SectionFrame key={b.id} id={`block:${b.id}`} label={PRODUCT_BLOCKS[b.type as keyof typeof PRODUCT_BLOCKS]?.label ?? b.type}>{body}</SectionFrame> : null
      })}
    </>
  )
}

function renderBlock(b: ProductBlock, ctx: BlockContext): ReactNode {
  const st = b.settings
  switch (b.type) {
    case 'bundles': return <Bundles settings={st} ctx={ctx} />
    case 'pulse_badge': return <PulseBadge settings={st} variant={ctx.variant} />
    case 'countdown': return <Countdown settings={st} />
    case 'coupon': return s(st.code).trim() ? <Coupon code={s(st.code).trim().toUpperCase()} text={s(st.text)} /> : null
    case 'review_summary': return <ReviewSummary settings={st} />
    case 'badges': return <Badges items={rows(st.items).map((r) => s(r.text).trim()).filter(Boolean)} />
    case 'shipping_info': return <ShippingInfo settings={st} />
    case 'benefits_list': return <BenefitsList items={rows(st.items).map((r) => s(r.text).trim()).filter(Boolean)} />
    case 'benefits': return <Benefits settings={st} />
    case 'payment_icons': return <PaymentIcons settings={st} />
    case 'tabs': return <Tabs settings={st} product={ctx.product} />
    case 'addons': return <Addons settings={st} ctx={ctx} />
    case 'upsell': return <Upsell settings={st} product={ctx.product} />
    case 'social_proof': return <SocialProof settings={st} />
    case 'reviews': return <Reviews settings={st} />
    case 'video': return <VideoCarousel settings={st} />
    case 'banner': return <Banner settings={st} />
    case 'space': return <div style={{ height: n(st.height, 16) }} className="flex items-center">{st.line !== false && <div className="h-px w-full bg-border" />}</div>
    default: return null
  }
}

// --- bundles ---------------------------------------------------------------------------------------

function Bundles({ settings, ctx }: { settings: Record<string, unknown>; ctx: BlockContext }) {
  const tiers = bundleTiers(settings).filter((t) => t.quantity <= ctx.max)
  if (tiers.length < 2 || !ctx.variant || !bundleApplies(settings, ctx.product.category?.slug)) return null
  const unit = Number(ctx.variant.price)
  const compare = Number(ctx.variant.compare_at_price ?? 0)
  const grid = settings.style === 'grid'
  return (
    <div className="space-y-2.5">
      {s(settings.heading) && (
        <div className="flex items-center gap-3 text-[calc(11px*var(--fs-body,1))] font-semibold tracking-wider text-muted-foreground uppercase">
          <span className="h-px flex-1 bg-border" />{s(settings.heading)}<span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div role="radiogroup" aria-label={s(settings.heading, 'Bundles')} className={cn(grid ? 'grid grid-cols-2 gap-2 sm:grid-cols-3' : 'grid gap-2')}>
        {tiers.map((t) => {
          const pct = bundlePercent(tiers, t.quantity)
          const each = bundleUnitPrice(unit, pct)
          const total = each * t.quantity
          const regular = Math.max(unit, compare) * t.quantity
          const saves = regular - total
          const on = bundlePercent(tiers, ctx.quantity) === pct && ctx.quantity >= t.quantity && (tiers.find((x) => x.quantity > t.quantity)?.quantity ?? Infinity) > ctx.quantity
          return (
            <button key={t.quantity} type="button" role="radio" aria-checked={on} onClick={() => ctx.setQuantity(t.quantity)}
              className={cn(box, 'relative flex items-center gap-3 border p-3 text-left transition-colors', on ? 'border-foreground bg-foreground/[.04] ring-1 ring-foreground' : 'hover:border-foreground/50',
                grid && 'flex-col items-start gap-1.5')}>
              {t.badge && <span className="absolute -top-2 right-3 rounded-full bg-foreground px-2 py-0.5 text-[calc(10px*var(--fs-body,1))] font-semibold text-background">{t.badge}</span>}
              <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-foreground' : 'border-muted-foreground/50', grid && 'hidden')}>
                {on && <span className="size-2 rounded-full bg-foreground" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t.title || `${t.quantity} ${t.quantity === 1 ? 'piece' : 'pieces'}`}
                  {pct > 0 && saves > 0 && <span className="rounded bg-emerald-600/10 px-1.5 py-0.5 text-[calc(10px*var(--fs-body,1))] font-semibold text-emerald-700 uppercase">Save {formatMoney(saves)}</span>}
                </span>
                {t.subtitle && <span className="mt-0.5 block text-xs text-muted-foreground">{t.subtitle}</span>}
              </span>
              <span className="text-right">
                <span className="block text-sm font-semibold tabular-nums">{formatMoney(total)}</span>
                {saves > 0 && <span className="block text-xs text-muted-foreground line-through tabular-nums">{formatMoney(regular)}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// --- stock, timer, coupon, rating, badges ----------------------------------------------------------

function PulseBadge({ settings, variant }: { settings: Record<string, unknown>; variant: ProductVariantPublic | undefined }) {
  if (!variant) return null
  const low = n(settings.low_at, 5)
  const color = !variant.in_stock ? '#dc2626' : variant.available !== null && variant.available <= low ? '#ea580c' : s(settings.color, '#16a34a')
  const text = !variant.in_stock ? 'Sold out'
    : variant.available !== null && variant.available <= low ? s(settings.low_stock, 'Only {count} left in stock').replace('{count}', String(variant.available))
    : s(settings.in_stock, 'In stock & ready to ship')
  return (
    <p className="flex items-center gap-2.5 text-[calc(13px*var(--fs-body,1))] font-medium" style={{ color }}>
      <span className="relative grid size-2.5 place-items-center">
        <span className="ff-ping absolute inset-0 rounded-full" style={{ background: color }} />
        <span className="relative size-2.5 rounded-full" style={{ background: color }} />
      </span>
      {text}
    </p>
  )
}

/** "2026-11-30 23:59" in Bangladesh time (UTC+6). */
export function parseDhakaTime(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v.trim())
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23) - 6, +(m[5] ?? 59))
  return Number.isFinite(t) ? t : null
}

function Countdown({ settings }: { settings: Record<string, unknown> }) {
  const end = parseDhakaTime(s(settings.ends_at))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!end) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [end])
  if (!end || end <= now) return null
  const left = Math.floor((end - now) / 1000)
  const parts: Array<[number, string]> = [[Math.floor(left / 86400), 'days'], [Math.floor(left / 3600) % 24, 'hrs'], [Math.floor(left / 60) % 60, 'min'], [left % 60, 'sec']]
  const color = s(settings.color, '#b91c1c')
  return (
    <div className={cn(box, 'flex items-center justify-between gap-3 border px-3 py-2.5')} style={{ borderColor: `${color}55` }}>
      <span className="flex items-center gap-2 text-[calc(13px*var(--fs-body,1))] font-medium" style={{ color }}><Clock className="size-4" />{s(settings.heading, 'Sale ends in')}</span>
      <span className="flex gap-1.5" aria-live="off">
        {parts.map(([v, l], i) => (i === 0 && v === 0 ? null : (
          <span key={l} className="grid min-w-10 justify-items-center rounded-md px-1.5 py-1 text-white" style={{ background: color }}>
            <span className="text-sm leading-none font-semibold tabular-nums">{String(v).padStart(2, '0')}</span>
            <span className="text-[calc(9px*var(--fs-body,1))] leading-tight opacity-80">{l}</span>
          </span>
        )))}
      </span>
    </div>
  )
}

function Coupon({ code, text }: { code: string; text: string }) {
  const setCoupon = useCart((st) => st.setCoupon)
  const [done, setDone] = useState(false)
  const copy = () => {
    setCoupon(code)
    navigator.clipboard?.writeText(code).catch(() => undefined)
    setDone(true)
    window.setTimeout(() => setDone(false), 2500)
  }
  return (
    <div className={cn(box, 'flex items-center gap-3 border border-dashed border-foreground/40 bg-foreground/[.03] px-3 py-2.5')}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold tracking-wider">{code}</p>
        {text && <p className="text-xs text-muted-foreground">{text}</p>}
      </div>
      <button type="button" onClick={copy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background">
        {done ? <><Check className="size-3.5" /> Copied</> : <><ClipboardCopy className="size-3.5" /> Copy</>}
      </button>
    </div>
  )
}

function Stars({ value, size = 'size-4' }: { value: number; size?: string }) {
  return (
    <span className="flex" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="relative">
          <Star className={cn(size, 'text-muted-foreground/30')} fill="currentColor" strokeWidth={0} />
          <span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.max(0, Math.min(1, value - i + 1)) * 100}%` }}>
            <Star className={cn(size, 'text-amber-500')} fill="currentColor" strokeWidth={0} />
          </span>
        </span>
      ))}
    </span>
  )
}

function ReviewSummary({ settings }: { settings: Record<string, unknown> }) {
  const rating = Number(s(settings.rating).replace(',', '.'))
  if (!Number.isFinite(rating) || rating <= 0 || rating > 5) return null
  const count = s(settings.count).trim()
  return (
    <p className="flex flex-wrap items-center gap-2 text-[calc(13px*var(--fs-body,1))]">
      {s(settings.label) && <span className="font-semibold">{s(settings.label)}</span>}
      <Stars value={rating} />
      <span className="text-muted-foreground">{rating.toFixed(1)}{count && ` · ${count} reviews`}</span>
    </p>
  )
}

function Badges({ items }: { items: string[] }) {
  if (!items.length) return null
  const tones = ['bg-sky-600/10 text-sky-800', 'bg-emerald-600/10 text-emerald-800', 'bg-rose-600/10 text-rose-800', 'bg-amber-500/15 text-amber-900', 'bg-violet-600/10 text-violet-800']
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t, i) => <span key={t + i} className={cn('rounded-full px-2.5 py-1 text-[calc(11px*var(--fs-body,1))] font-medium', tones[i % tones.length])}>{t}</span>)}
    </div>
  )
}

// --- delivery and promises ----------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' })

function ShippingInfo({ settings }: { settings: Record<string, unknown> }) {
  const { data: config } = useStoreConfig()
  const zones = (config?.delivery.zones ?? []).filter((z) => z.estimated_days?.trim())
  const minD = n(settings.min_days, 1)
  const maxD = Math.max(minD, n(settings.max_days, 3))
  const dates = settings.show_dates !== false
  if (!zones.length && !dates) return null
  const at = (d: number) => dayFmt.format(new Date(Date.now() + d * 86400000))
  return (
    <div className={cn(box, 'grid gap-2 border px-3 py-3 text-[calc(13px*var(--fs-body,1))]')}>
      <p className="flex items-center gap-2 font-medium"><Truck className="size-4" />{s(settings.heading, 'Delivery')}</p>
      {dates && <p className="text-muted-foreground">Order now and get it between <span className="font-medium text-foreground">{at(minD)}</span> and <span className="font-medium text-foreground">{at(maxD)}</span>.</p>}
      {zones.length > 0 && (
        <ul className="grid gap-1">
          {zones.slice(0, 4).map((z) => (
            <li key={z.name} className="flex justify-between gap-3"><span className="text-muted-foreground">{z.name}</span><span>{z.estimated_days}{/\d$/.test(z.estimated_days ?? '') ? ' days' : ''}</span></li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BenefitsList({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul className="grid gap-1.5 text-[calc(13px*var(--fs-body,1))]">
      {items.map((t, i) => <li key={t + i} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />{t}</li>)}
    </ul>
  )
}

function Benefits({ settings }: { settings: Record<string, unknown> }) {
  const items = rows(settings.items).map((r) => ({ title: s(r.title).trim(), text: s(r.text).trim() })).filter((r) => r.title || r.text)
  if (!items.length) return null
  const icons = [Truck, ShieldCheck, Check, Star]
  return (
    <div className={cn('grid gap-3', settings.layout !== 'vertical' && 'sm:grid-cols-2')}>
      {items.map((r, i) => {
        const Icon = icons[i % icons.length]
        return (
          <div key={i} className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/[.06]"><Icon className="size-4" /></span>
            <span><span className="block text-[calc(13px*var(--fs-body,1))] font-medium">{r.title}</span><span className="block text-xs text-muted-foreground">{r.text}</span></span>
          </div>
        )
      })}
    </div>
  )
}

function PaymentIcons({ settings }: { settings: Record<string, unknown> }) {
  const { data: config } = useStoreConfig()
  const pills: Array<[string, string]> = []
  if (settings.cod !== false && config?.payments.cod_enabled !== false) pills.push(['Cash on delivery', 'border text-foreground'])
  if (settings.bkash !== false) pills.push(['bKash', 'bg-[#e2136e] text-white'])
  if (settings.nagad !== false) pills.push(['Nagad', 'bg-[#f6921e] text-white'])
  if (settings.card === true) pills.push(['Visa', 'bg-[#1a1f71] text-white'], ['Mastercard', 'bg-[#eb001b] text-white'])
  if (!pills.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[calc(11px*var(--fs-body,1))]">
      {s(settings.text) && <span className="mr-1 text-muted-foreground">{s(settings.text)}</span>}
      {pills.map(([l, c]) => <span key={l} className={cn('rounded px-2 py-1 font-semibold', c)}>{l}</span>)}
    </div>
  )
}

function Tabs({ settings, product }: { settings: Record<string, unknown>; product: ProductDetail }) {
  const tabs: Array<{ title: string; text: string }> = []
  if (settings.description !== false && product.description?.trim()) tabs.push({ title: 'Description', text: product.description })
  if (settings.shipping !== false && product.shipping_note?.trim()) tabs.push({ title: 'Shipping', text: product.shipping_note })
  for (const r of rows(settings.items)) if (s(r.title).trim() && s(r.text).trim()) tabs.push({ title: s(r.title).trim(), text: s(r.text) })
  const [open, setOpen] = useState(0)
  if (!tabs.length) return null
  const cur = tabs[Math.min(open, tabs.length - 1)]
  return (
    <div>
      <div role="tablist" className="flex gap-4 overflow-x-auto border-b text-[calc(13px*var(--fs-body,1))]">
        {tabs.map((t, i) => (
          <button key={t.title + i} type="button" role="tab" aria-selected={cur === t} onClick={() => setOpen(i)}
            className={cn('-mb-px shrink-0 border-b-2 pb-2 font-medium transition-colors', cur === t ? 'border-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t.title}</button>
        ))}
      </div>
      <p role="tabpanel" className="pt-3 text-[calc(13px*var(--fs-body,1))] leading-relaxed whitespace-pre-line text-muted-foreground">{cur.text}</p>
    </div>
  )
}

// --- other products ---------------------------------------------------------------------------------

function useBlockProducts(settings: Record<string, unknown>, product: ProductDetail): ProductCard[] {
  const source = s(settings.source, 'related')
  const limit = Math.max(1, Math.min(4, n(settings.limit, 2)))
  const q = useQuery({
    queryKey: ['block-products', source, s(settings.category), limit],
    enabled: source !== 'related',
    staleTime: 5 * 60_000,
    queryFn: () => listProducts({ sort: source === 'best_selling' ? 'best_selling' : 'newest', category: source === 'category' ? s(settings.category) || undefined : undefined, limit: limit + 2, inStock: true }),
  })
  const list = source === 'related' ? product.related : q.data?.items ?? []
  return list.filter((p) => p.id !== product.id && p.in_stock).slice(0, limit)
}

/** Adds a product's first in-stock option to the cart (one with several options opens its page instead). */
export async function addCard(card: ProductCard, add: ReturnType<typeof useCart.getState>['add'], open = true): Promise<'added' | 'choose'> {
  const detail = await getProduct(card.slug)
  if (!detail) return 'choose'
  const variants = detail.variants.filter((v) => v.in_stock)
  if (detail.option_names.length && variants.length > 1) return 'choose'
  const v = variants[0]
  if (!v) return 'choose'
  add({
    variantId: v.id, productId: detail.id, slug: detail.slug, name: detail.name, variantTitle: detail.option_names.length ? v.title : null,
    price: Number(v.price), compareAt: v.compare_at_price ? Number(v.compare_at_price) : null, image: detail.image?.url ?? null,
    maxQuantity: Math.max(1, Math.min(detail.max_quantity, v.available ?? detail.max_quantity)),
  }, 1, open)
  return 'added'
}

function Addons({ settings, ctx }: { settings: Record<string, unknown>; ctx: BlockContext }) {
  const list = useBlockProducts(settings, ctx.product)
  if (!list.length) return null
  const picked = new Set(ctx.addons.map((a) => a.id))
  return (
    <div className="space-y-2">
      {s(settings.heading) && <p className="text-[calc(13px*var(--fs-body,1))] font-medium">{s(settings.heading)}</p>}
      {list.map((p) => (
        <label key={p.id} className={cn(box, 'flex cursor-pointer items-center gap-3 border p-2.5 transition-colors', picked.has(p.id) && 'border-foreground')}>
          <input type="checkbox" className="size-4 accent-foreground" checked={picked.has(p.id)}
            onChange={(e) => ctx.setAddons(e.target.checked ? [...ctx.addons, p] : ctx.addons.filter((a) => a.id !== p.id))} />
          {p.image && <img src={imageUrl(p.image.url, 120)} alt="" className="size-11 rounded object-cover" loading="lazy" />}
          <span className="min-w-0 flex-1 truncate text-[calc(13px*var(--fs-body,1))]">{p.name}</span>
          <span className="text-[calc(13px*var(--fs-body,1))] font-medium tabular-nums">+{formatMoney(p.price)}</span>
        </label>
      ))}
    </div>
  )
}

function Upsell({ settings, product }: { settings: Record<string, unknown>; product: ProductDetail }) {
  const list = useBlockProducts(settings, product)
  const add = useCart((st) => st.add)
  const [busy, setBusy] = useState<string | null>(null)
  const [choose, setChoose] = useState<string | null>(null)
  if (!list.length) return null
  return (
    <div className="space-y-2">
      {s(settings.heading) && <p className="text-[calc(13px*var(--fs-body,1))] font-medium">{s(settings.heading)}</p>}
      {list.map((p) => (
        <div key={p.id} className={cn(box, 'flex items-center gap-3 border p-2.5')}>
          <Link to={`/product/${p.slug}`} className="shrink-0">{p.image && <img src={imageUrl(p.image.url, 120)} alt="" className="size-12 rounded object-cover" loading="lazy" />}</Link>
          <span className="min-w-0 flex-1">
            <Link to={`/product/${p.slug}`} className="block truncate text-[calc(13px*var(--fs-body,1))] hover:underline">{p.name}</Link>
            <span className="text-[calc(13px*var(--fs-body,1))] tabular-nums">
              {formatMoney(p.price)}{p.compare_at_price && p.compare_at_price > p.price && <span className="ml-1.5 text-xs text-muted-foreground line-through">{formatMoney(p.compare_at_price)}</span>}
            </span>
          </span>
          {choose === p.id
            ? <Link to={`/product/${p.slug}`} className="text-xs font-medium underline">Choose options</Link>
            : (
              <button type="button" disabled={busy === p.id} onClick={async () => { setBusy(p.id); try { if ((await addCard(p, add)) === 'choose') setChoose(p.id) } finally { setBusy(null) } }}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:opacity-50">
                <Plus className="size-3.5" /> Add
              </button>
            )}
        </div>
      ))}
    </div>
  )
}

// --- people and media -----------------------------------------------------------------------------

function SocialProof({ settings }: { settings: Record<string, unknown> }) {
  const text = s(settings.text).trim()
  if (!text) return null
  const imgs = rows(settings.images).map((r) => s(r.url).trim()).filter((u) => /^(https:\/\/|\/)/.test(u)).slice(0, 4)
  return (
    <div className="flex items-center gap-3 text-[calc(13px*var(--fs-body,1))]">
      {imgs.length > 0 && (
        <span className="flex -space-x-2">
          {imgs.map((u) => <img key={u} src={imageUrl(u, 80)} alt="" className="size-7 rounded-full border-2 border-background object-cover" loading="lazy" />)}
        </span>
      )}
      <span>{text}</span>
    </div>
  )
}

function Reviews({ settings }: { settings: Record<string, unknown> }) {
  const items = rows(settings.items).map((r) => ({ name: s(r.name).trim(), text: s(r.text).trim(), rating: Math.max(1, Math.min(5, Number(s(r.rating)) || 5)) }))
    .filter((r) => r.text)
  if (!items.length) return null
  return (
    <div className="space-y-2.5">
      {s(settings.heading) && <p className="text-[calc(13px*var(--fs-body,1))] font-medium">{s(settings.heading)}</p>}
      <div className="flex snap-x gap-2.5 overflow-x-auto pb-1">
        {items.map((r, i) => (
          <figure key={i} className={cn(box, 'w-64 shrink-0 snap-start border p-3')}>
            <Stars value={r.rating} size="size-3.5" />
            <blockquote className="mt-2 text-[calc(13px*var(--fs-body,1))] leading-relaxed">{r.text}</blockquote>
            {r.name && <figcaption className="mt-2 text-xs text-muted-foreground">{r.name}</figcaption>}
          </figure>
        ))}
      </div>
    </div>
  )
}

function VideoCarousel({ settings }: { settings: Record<string, unknown> }) {
  const urls = rows(settings.items).map((r) => s(r.url).trim()).filter((u) => /^https:\/\/.+/.test(u) || u.startsWith('/files/')).slice(0, 6)
  if (!urls.length) return null
  return (
    <div className="space-y-2.5">
      {s(settings.heading) && <p className="text-[calc(13px*var(--fs-body,1))] font-medium">{s(settings.heading)}</p>}
      <div className="flex snap-x gap-2 overflow-x-auto pb-1">{urls.map((u) => <ClipVideo key={u} src={u} />)}</div>
    </div>
  )
}

function ClipVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(true)
  return (
    <div className={cn(box, 'relative aspect-[9/16] w-36 shrink-0 snap-start overflow-hidden bg-muted')}>
      <video ref={ref} src={src} muted={muted} autoPlay loop playsInline preload="metadata" className="size-full object-cover" />
      <button type="button" aria-label={muted ? 'Sound on' : 'Sound off'} onClick={() => setMuted(!muted)}
        className="absolute right-1.5 bottom-1.5 grid size-7 place-items-center rounded-full bg-black/55 text-white">
        {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
    </div>
  )
}

function Banner({ settings }: { settings: Record<string, unknown> }) {
  const text = s(settings.text).trim()
  if (!text) return null
  const tone = ({ info: 'border-sky-600/30 bg-sky-600/[.07] text-sky-900', success: 'border-emerald-600/30 bg-emerald-600/[.07] text-emerald-900',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-900', neutral: 'border-border bg-muted text-foreground' } as Record<string, string>)[s(settings.tone, 'info')] ?? ''
  return <p className={cn(box, 'border px-3 py-2.5 text-[calc(13px*var(--fs-body,1))] whitespace-pre-line', tone)}>{text}</p>
}

// --- page-wide blocks: sticky bar and wrapper -------------------------------------------------------

/** A bar with the product, its price and "Add to cart" once the buy buttons have scrolled out of view. */
export function StickyAddToCart({ blocks, watch, product, price, disabled, onAdd, label }: {
  blocks: ProductBlock[]; watch: React.RefObject<HTMLElement | null>; product: ProductDetail; price: number; disabled: boolean; onAdd: () => void; label: string
}) {
  const block = activeBlock(blocks, 'sticky_atc')
  const [show, setShow] = useState(false)
  useEffect(() => {
    const el = watch.current
    if (!block || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting && e.boundingClientRect.top < 0))
    io.observe(el)
    return () => io.disconnect()
  }, [block, watch])
  if (!block) return null
  return (
    <div aria-hidden={!show} className={cn('fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] backdrop-blur transition-transform duration-300',
      show ? 'translate-y-0' : 'pointer-events-none translate-y-full', block.settings.mobile_only === true && 'md:hidden')}>
      <div className="mx-auto flex max-w-6xl items-center gap-3">
        {product.image && <img src={imageUrl(product.image.url, 96)} alt="" className="hidden size-10 rounded object-cover sm:block" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[calc(13px*var(--fs-body,1))] font-medium">{product.name}</p>
          <p className="text-[calc(13px*var(--fs-body,1))] tabular-nums text-muted-foreground">{formatMoney(price)}</p>
        </div>
        <button type="button" disabled={disabled} onClick={onAdd} tabIndex={show ? 0 : -1}
          className="inline-flex h-10 items-center rounded-md bg-foreground px-5 text-[calc(13px*var(--fs-body,1))] font-semibold text-background disabled:opacity-40">{label}</button>
      </div>
    </div>
  )
}

/** The product information column, boxed when the Wrapper block is on. */
export function BlockWrapper({ blocks, children, className }: { blocks: ProductBlock[]; children: ReactNode; className?: string }) {
  const block = activeBlock(blocks, 'wrapper')
  const style = useMemo<CSSProperties | undefined>(() => (block ? { padding: n(block.settings.padding, 20) } : undefined), [block])
  if (!block) return <div className={className}>{children}</div>
  return (
    <div className={cn(className, box, block.settings.style === 'filled' ? 'bg-foreground/[.035]' : 'border')} style={style}>{children}</div>
  )
}

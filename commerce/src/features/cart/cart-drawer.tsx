import { useQuery } from '@tanstack/react-query'
import { Lock, Minus, Plus, ShoppingBag, Tag, Trash2, Truck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { addCard } from '@/features/storefront/product-block-views'
import { themeStyle } from '@/features/storefront/theme'
import { useStoreTheme } from '@/features/storefront/theme-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { listProducts } from '@/services/storefront'
import { cartCount, useCart } from './cart-store'
import { useCartQuote } from './use-cart-quote'

// The cart drawer: opens when something is added. Prices come from the server's quote (bundles and
// coupons included), with the cart's own numbers only until it answers. Set up in the theme builder
// (Cart page → Cart drawer): free-delivery bar, "You may also like", savings and a note.

export function QuantityStepper({ value, max, onChange, size = 'sm' }: { value: number; max: number; onChange: (v: number) => void; size?: 'sm' | 'default' }) {
  const btn = size === 'sm' ? 'icon-sm' : 'icon'
  return (
    <div className="inline-flex items-center rounded-md border">
      <Button type="button" variant="ghost" size={btn} onClick={() => onChange(value - 1)} aria-label="Decrease quantity"><Minus /></Button>
      <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">{value}</span>
      <Button type="button" variant="ghost" size={btn} onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Increase quantity"><Plus /></Button>
    </div>
  )
}

export function CartDrawer() {
  const { items, isOpen, setOpen, setQuantity, remove, couponCode, add } = useCart()
  const theme = useStoreTheme()
  const settings = theme.cart
  const { data: config } = useStoreConfig()
  const quote = useCartQuote(items, couponCode)
  const q = quote.data
  const problems = new Map((q?.stock_errors ?? []).map((e) => [e.variant_id, e.message]))
  const lines = new Map((q?.lines ?? []).map((l) => [l.variant_id, l]))

  // Totals: the server's when it has answered, else the cart's own.
  const subtotal = q ? Number(q.subtotal) : items.reduce((t, i) => t + i.price * i.quantity, 0)
  const coupon = Number(q?.coupon_discount ?? 0)
  const regular = items.reduce((t, i) => {
    const l = lines.get(i.variantId)
    const unit = Math.max(Number(i.compareAt ?? 0), Number(l?.regular_unit_price ?? i.price), i.price)
    return t + unit * i.quantity
  }, 0)
  const pay = Math.max(0, subtotal - coupon)
  const savings = Math.max(0, regular - pay)

  const threshold = Number(config?.delivery.free_delivery_threshold ?? 0)
  const bar = settings.free_shipping_bar && threshold > 0
  const missing = Math.max(0, threshold - subtotal)

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[420px]" style={themeStyle(theme)}>
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-lg font-medium">Cart <sup className="text-xs font-normal text-muted-foreground">{cartCount(items)}</sup></SheetTitle>
          <SheetDescription className="sr-only">Items in your cart</SheetDescription>
        </SheetHeader>

        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <ShoppingBag className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Your cart is empty.</p>
            <Button asChild variant="ink" onClick={() => setOpen(false)}><Link to="/shop">Continue shopping</Link></Button>
          </div>
        ) : (
          <>
            {bar && (
              <div className="border-b px-5 py-3.5">
                <p className="text-center text-[13px]">
                  {missing > 0 ? settings.free_shipping_text.split('{amount}').flatMap((part, i) => (i ? [<b key={i} className="font-semibold">{formatMoney(missing)}</b>, part] : [part]))
                    : settings.unlocked_text}
                </p>
                <div className="relative mt-2.5 h-2 rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={threshold} aria-valuenow={Math.min(subtotal, threshold)}>
                  <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${Math.min(100, (subtotal / threshold) * 100)}%` }} />
                  <span className={cn('absolute top-1/2 right-0 grid size-6 -translate-y-1/2 translate-x-1 place-items-center rounded-full border-2 border-background', missing > 0 ? 'bg-muted text-muted-foreground' : 'bg-foreground text-background')}>
                    <Truck className="size-3" />
                  </span>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              <ul className="divide-y px-5">
                {items.map((item) => {
                  const l = lines.get(item.variantId)
                  const unit = Number(l?.unit_price ?? item.price)
                  const was = Math.max(Number(item.compareAt ?? 0), Number(l?.regular_unit_price ?? 0))
                  const off = was > unit ? (was - unit) * item.quantity : 0
                  return (
                    <li key={item.variantId} className="flex gap-3 py-4">
                      <Link to={`/product/${item.slug}`} onClick={() => setOpen(false)} className="shrink-0">
                        <img src={imageUrl(item.image, 160)} alt="" className="size-20 rounded-md bg-muted object-cover" loading="lazy" />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-2">
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-sm">{item.name}</p>
                            {item.variantTitle && <p className="text-xs text-muted-foreground">{item.variantTitle}</p>}
                            {settings.show_savings && off > 0 && (
                              <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Tag className="size-3" />{formatMoney(off)} OFF{l?.bundle_percent ? ` · bundle ${Number(l.bundle_percent)}%` : ''}</p>
                            )}
                          </div>
                          <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1.5 text-muted-foreground" onClick={() => remove(item.variantId)} aria-label={`Remove ${item.name}`}><Trash2 /></Button>
                        </div>
                        {problems.get(item.variantId) && <p className="mt-1 text-xs text-destructive">{problems.get(item.variantId)}</p>}
                        <div className="mt-2 flex items-center justify-between">
                          <QuantityStepper value={item.quantity} max={item.maxQuantity} onChange={(v) => setQuantity(item.variantId, v)} />
                          <div className="text-right">
                            {settings.show_savings && was > unit && <Money value={was * item.quantity} className="block text-xs text-muted-foreground line-through" />}
                            <Money value={unit * item.quantity} className="text-sm font-medium" />
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {settings.upsell && <CartUpsell title={settings.upsell_title} exclude={items.map((i) => i.productId)} onAdd={(card) => addCard(card, add, false)} />}
            </div>

            <div className="grid gap-2 border-t px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] text-sm">
              {settings.show_savings && savings > 0 && (
                <div className="flex justify-between text-muted-foreground"><span>Discount</span><span className="tabular-nums">−{formatMoney(savings)}</span></div>
              )}
              <div className="flex items-baseline justify-between">
                <span>Subtotal</span>
                <span className="flex items-baseline gap-2">
                  {settings.show_savings && savings > 0 && <Money value={regular} className="text-xs text-muted-foreground line-through" />}
                  <Money value={pay} className="font-semibold" />
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{settings.note || 'Delivery is added at checkout.'}</p>
              <Button asChild variant="ink" size="lg" className="mt-1 h-12 text-[15px]" onClick={() => setOpen(false)} disabled={problems.size > 0}>
                <Link to="/checkout"><Lock className="size-4" /> Checkout · {formatMoney(pay)}</Link>
              </Button>
              <Link to="/cart" onClick={() => setOpen(false)} className="text-center text-xs text-muted-foreground underline-offset-2 hover:underline">View cart</Link>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** "You may also like": best sellers not already in the cart, with a quick Add. */
function CartUpsell({ title, exclude, onAdd }: { title: string; exclude: string[]; onAdd: (card: Parameters<typeof addCard>[0]) => Promise<'added' | 'choose'> }) {
  const { data } = useQuery({ queryKey: ['cart-upsell'], queryFn: () => listProducts({ sort: 'best_selling', limit: 6, inStock: true }), staleTime: 5 * 60_000 })
  const [busy, setBusy] = useState<string | null>(null)
  const [choose, setChoose] = useState<string | null>(null)
  const setOpen = useCart((st) => st.setOpen)
  const list = (data?.items ?? []).filter((p) => !exclude.includes(p.id) && p.in_stock).slice(0, 2)
  if (!list.length) return null
  return (
    <div className="px-5 pt-2 pb-5">
      <p className="mb-2.5 text-[13px] font-medium">{title}</p>
      <div className="grid gap-2">
        {list.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border p-2.5">
            {p.image && <img src={imageUrl(p.image.url, 120)} alt="" className="size-12 rounded object-cover" loading="lazy" />}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[13px]">{p.name}</p>
              <p className="text-[13px] tabular-nums">
                {p.compare_at_price && p.compare_at_price > p.price && <span className="mr-1.5 text-xs text-muted-foreground line-through">{formatMoney(p.compare_at_price)}</span>}
                {formatMoney(p.price)}
              </p>
            </div>
            {choose === p.id
              ? <Link to={`/product/${p.slug}`} onClick={() => setOpen(false)} className="text-xs font-medium underline">Choose</Link>
              : (
                <Button type="button" variant="ink" size="sm" disabled={busy === p.id} className="h-8 gap-1 px-3"
                  onClick={async () => { setBusy(p.id); try { if ((await onAdd(p)) === 'choose') setChoose(p.id) } finally { setBusy(null) } }}>
                  <Plus className="size-3.5" /> Add
                </Button>
              )}
          </div>
        ))}
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Lock, Minus, Plus, ShoppingBag, Tag, Trash2, Truck } from 'lucide-react'
import { type CSSProperties, useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { addCard } from '@/features/storefront/product-block-views'
import { CART_TEXT_DEFAULTS, CART_WIDTHS, isThemePreview, onColor, themeData, themeStyle, usePreviewSelection, type CartSettings } from '@/features/storefront/theme'
import { useStoreTheme } from '@/features/storefront/theme-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { listProducts } from '@/services/storefront'
import { cartCount, useCart, type CartItem } from './cart-store'
import { cartBlocker, useCartQuote } from './use-cart-quote'

// The cart drawer: opens when something is added. Prices come from the server's quote (bundles and
// coupons included), with the cart's own numbers only until it answers. Set up in the theme builder
// (Cart page → Cart drawer): free-delivery bar, "You may also like", savings and a note, and its
// look (side, width, spacing, colours, title, text size, photo shape, checkout button). In the
// builder's preview it stays open while "Cart drawer" is selected, with sample items if the cart is empty.

const PAD: Record<CartSettings['spacing'], { x: string; row: string; head: string }> = {
  compact: { x: 'px-4', row: 'py-3', head: 'py-3' },
  comfortable: { x: 'px-5', row: 'py-4', head: 'py-4' },
  spacious: { x: 'px-6', row: 'py-5', head: 'py-5' },
}
const TITLE: Record<CartSettings['title_size'], string> = { small: 'text-base', medium: 'text-lg', large: 'text-2xl' }

/** Shown in the builder's preview when the cart is empty, so the drawer's look can be set. */
export const CART_SAMPLE: CartItem[] = [
  { variantId: 'sample-1', productId: 'sample-1', slug: '', name: 'Sample product', variantTitle: 'Black / M', image: null, price: 1250, compareAt: 1490, quantity: 1, maxQuantity: 9 },
  { variantId: 'sample-2', productId: 'sample-2', slug: '', name: 'Another sample product', variantTitle: null, image: null, price: 890, compareAt: null, quantity: 2, maxQuantity: 9 },
]

export function QuantityStepper({ value, max, onChange, size = 'sm', radius }: { value: number; max: number; onChange: (v: number) => void; size?: 'sm' | 'default'; radius?: number }) {
  const btn = size === 'sm' ? 'icon-sm' : 'icon'
  return (
    <div className="inline-flex items-center overflow-hidden rounded-md border" style={radius === undefined ? undefined : { borderRadius: radius }}>
      <Button type="button" variant="ghost" size={btn} onClick={() => onChange(value - 1)} aria-label="Decrease quantity"><Minus /></Button>
      <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">{value}</span>
      <Button type="button" variant="ghost" size={btn} onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Increase quantity"><Plus /></Button>
    </div>
  )
}

export function CartDrawer() {
  const { items: cartItems, isOpen, setOpen, setQuantity, remove, couponCode, add } = useCart()
  const theme = useStoreTheme()
  const settings = theme.cart
  // The builder shows the drawer while it is selected there (with sample items in an empty cart).
  const preview = isThemePreview()
  const { selected } = usePreviewSelection()
  const previewOpen = preview && selected === 'cart-drawer'
  const sample = previewOpen && cartItems.length === 0
  const items = sample ? CART_SAMPLE : cartItems
  const { data: config } = useStoreConfig()
  const quote = useCartQuote(cartItems, couponCode)
  const q = quote.data
  const problems = new Map((q?.stock_errors ?? []).map((e) => [e.variant_id, e.message]))
  const blocker = sample ? null : cartBlocker(quote.error)
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
  const checkoutLabel = <>{settings.button_lock_icon && <Lock className="size-4" />} {settings.button_label || CART_TEXT_DEFAULTS.button}{settings.button_show_total ? ` · ${formatMoney(pay)}` : ''}</>

  const threshold = Number(config?.delivery.free_delivery_threshold ?? 0)
  const bar = settings.free_shipping_bar && threshold > 0
  const missing = Math.max(0, threshold - subtotal)

  const pad = PAD[settings.spacing]
  // The drawer's own look: its colours over the theme's, its text size, and the button's colours.
  const look = themeStyle({ ...theme, text_size: Math.round(theme.text_size * settings.text_scale / 100) })
  const bg = settings.background || theme.colors.background
  const fg = settings.text || theme.colors.text
  const buttonBg = settings.button_bg || theme.accent
  const style = {
    ...look, '--background': bg, '--foreground': fg, '--popover': bg, '--popover-foreground': fg, background: bg, color: fg,
    '--cart-w': `${CART_WIDTHS[settings.width]}px`,
  } as CSSProperties
  const button: CSSProperties = { background: buttonBg, color: settings.button_text || onColor(buttonBg), borderRadius: settings.button_radius }
  const photo: CSSProperties = { height: settings.image_size, width: settings.image_shape === 'portrait' ? Math.round(settings.image_size * 0.75) : settings.image_size, borderRadius: settings.image_radius }

  return (
    <Sheet open={isOpen || previewOpen} onOpenChange={(v) => { if (!previewOpen) setOpen(v) }} modal={!previewOpen}>
      <SheetContent side={settings.side} data-section-id="cart-drawer" style={style} {...themeData(theme)}
        className="flex w-full flex-col gap-0 p-0 sm:w-full sm:max-w-(--cart-w)"
        onInteractOutside={(e) => { if (previewOpen) e.preventDefault() }}>
        <SheetHeader className={cn('border-b', pad.x, pad.head)}>
          <SheetTitle className={cn('font-medium', TITLE[settings.title_size], settings.title_uppercase && 'tracking-wide uppercase')}>
            {settings.title || 'Cart'} <sup className="text-xs font-normal tracking-normal normal-case opacity-60">{cartCount(items)}</sup>
          </SheetTitle>
          <SheetDescription className="sr-only">Items in your cart</SheetDescription>
        </SheetHeader>

        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <ShoppingBag className="size-8 opacity-50" />
            <p className="text-sm opacity-70">{settings.empty_text || CART_TEXT_DEFAULTS.empty}</p>
            <Button asChild variant="ink" style={button} onClick={() => setOpen(false)}><Link to="/shop">Continue shopping</Link></Button>
          </div>
        ) : (
          <>
            {bar && (
              <div className={cn('border-b py-3.5', pad.x)}>
                <p className="text-center text-[calc(13px*var(--fs-body,1))]">
                  {missing > 0 ? settings.free_shipping_text.split('{amount}').flatMap((part, i) => (i ? [<b key={i} className="font-semibold">{formatMoney(missing)}</b>, part] : [part]))
                    : settings.unlocked_text}
                </p>
                <div className="relative mt-2.5 h-2 rounded-full bg-current/10" role="progressbar" aria-valuemin={0} aria-valuemax={threshold} aria-valuenow={Math.min(subtotal, threshold)}>
                  <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, (subtotal / threshold) * 100)}%`, background: settings.bar_color || fg }} />
                  <span className="absolute top-1/2 right-0 grid size-6 -translate-y-1/2 translate-x-1 place-items-center rounded-full border-2"
                    style={missing > 0 ? { background: bg, borderColor: bg, color: fg, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${fg} 20%, transparent)` } : { background: settings.bar_color || fg, borderColor: bg, color: bg }}>
                    <Truck className="size-3" />
                  </span>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              <ul className={cn('divide-y divide-current/10', pad.x)}>
                {items.map((item) => {
                  const l = lines.get(item.variantId)
                  const unit = Number(l?.unit_price ?? item.price)
                  const was = Math.max(Number(item.compareAt ?? 0), Number(l?.regular_unit_price ?? 0))
                  const off = was > unit ? (was - unit) * item.quantity : 0
                  return (
                    <li key={item.variantId} className={cn('flex gap-3', pad.row)}>
                      <Link to={item.slug ? `/product/${item.slug}` : '/shop'} onClick={() => setOpen(false)} className="shrink-0">
                        {item.image ? <img src={imageUrl(item.image, Math.min(320, settings.image_size * 2))} alt="" className="bg-current/5 object-cover" style={photo} loading="lazy" />
                          : <span aria-hidden className="block bg-current/10" style={photo} />}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-2">
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-sm">{item.name}</p>
                            {item.variantTitle && <p className="text-xs opacity-60">{item.variantTitle}</p>}
                            {settings.show_savings && off > 0 && (
                              <p className="mt-1 inline-flex items-center gap-1 text-[calc(11px*var(--fs-body,1))] opacity-60"><Tag className="size-3" />{formatMoney(off)} OFF{l?.bundle_percent ? ` · bundle ${Number(l.bundle_percent)}%` : ''}</p>
                            )}
                          </div>
                          <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1.5 opacity-60 hover:opacity-100" onClick={() => remove(item.variantId)} aria-label={`Remove ${item.name}`}><Trash2 /></Button>
                        </div>
                        {problems.get(item.variantId) && <p className="mt-1 text-xs text-destructive">{problems.get(item.variantId)}</p>}
                        <div className="mt-2 flex items-center justify-between">
                          <QuantityStepper value={item.quantity} max={item.maxQuantity} radius={settings.stepper_radius} onChange={(v) => setQuantity(item.variantId, v)} />
                          <div className="text-right">
                            {settings.show_savings && was > unit && <Money value={was * item.quantity} className="block text-xs line-through opacity-60" />}
                            <Money value={unit * item.quantity} className="text-sm font-medium" />
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {settings.upsell && <CartUpsell title={settings.upsell_title} padX={pad.x} button={button} photoRadius={settings.image_radius} exclude={items.map((i) => i.productId)} onAdd={(card) => addCard(card, add, false)} />}
            </div>

            <div className={cn('grid gap-2 border-t pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] text-sm', pad.x)}>
              {settings.show_savings && savings > 0 && (
                <div className="flex justify-between opacity-70"><span>Discount</span><span className="tabular-nums">−{formatMoney(savings)}</span></div>
              )}
              <div className="flex items-baseline justify-between">
                <span>Subtotal</span>
                <span className="flex items-baseline gap-2">
                  {settings.show_savings && savings > 0 && <Money value={regular} className="text-xs line-through opacity-60" />}
                  <Money value={pay} className="font-semibold" />
                </span>
              </div>
              <p className="text-xs opacity-60">{settings.note || 'Delivery is added at checkout.'}</p>
              {/* A link can't be disabled: while an item can't be bought, it's a disabled button. */}
              {blocker && <p role="alert" className="text-xs text-destructive">{blocker}</p>}
              {problems.size > 0 || blocker
                ? <Button type="button" variant="ink" size="lg" className="mt-1 h-12 text-[calc(15px*var(--fs-body,1))]" style={button} disabled>{checkoutLabel}</Button>
                : <Button asChild variant="ink" size="lg" className="mt-1 h-12 text-[calc(15px*var(--fs-body,1))]" style={button} onClick={() => setOpen(false)}><Link to="/checkout">{checkoutLabel}</Link></Button>}
              {settings.show_view_cart && <Link to="/cart" onClick={() => setOpen(false)} className="text-center text-xs opacity-60 underline-offset-2 hover:underline">View cart</Link>}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** "You may also like": best sellers not already in the cart, with a quick Add. */
function CartUpsell({ title, padX, button, photoRadius, exclude, onAdd }: { title: string; padX: string; button: CSSProperties; photoRadius: number; exclude: string[]; onAdd: (card: Parameters<typeof addCard>[0]) => Promise<'added' | 'choose'> }) {
  const { data } = useQuery({ queryKey: ['cart-upsell'], queryFn: () => listProducts({ sort: 'best_selling', limit: 6, inStock: true }), staleTime: 5 * 60_000 })
  const [busy, setBusy] = useState<string | null>(null)
  const [choose, setChoose] = useState<string | null>(null)
  const setOpen = useCart((st) => st.setOpen)
  const list = (data?.items ?? []).filter((p) => !exclude.includes(p.id) && p.in_stock).slice(0, 2)
  if (!list.length) return null
  return (
    <div className={cn('pt-2 pb-5', padX)}>
      <p className="mb-2.5 text-[calc(13px*var(--fs-body,1))] font-medium">{title}</p>
      <div className="grid gap-2">
        {list.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border border-current/10 p-2.5">
            {p.image && <img src={imageUrl(p.image.url, 120)} alt="" className="size-12 object-cover" style={{ borderRadius: photoRadius }} loading="lazy" />}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[calc(13px*var(--fs-body,1))]">{p.name}</p>
              <p className="text-[calc(13px*var(--fs-body,1))] tabular-nums">
                {p.compare_at_price && p.compare_at_price > p.price && <span className="mr-1.5 text-xs line-through opacity-60">{formatMoney(p.compare_at_price)}</span>}
                {formatMoney(p.price)}
              </p>
            </div>
            {choose === p.id
              ? <Link to={`/product/${p.slug}`} onClick={() => setOpen(false)} className="text-xs font-medium underline">Choose</Link>
              : (
                <Button type="button" variant="ink" size="sm" disabled={busy === p.id} className="h-8 gap-1 px-3" style={{ ...button, borderRadius: Math.min(Number(button.borderRadius ?? 8), 16) }}
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

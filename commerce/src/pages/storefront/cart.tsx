import { Lock, ShoppingBag, Trash2 } from 'lucide-react'
import { type CSSProperties, useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CART_SAMPLE, QuantityStepper } from '@/features/cart/cart-drawer'
import { useCart } from '@/features/cart/cart-store'
import { cartBlocker, useCartQuote } from '@/features/cart/use-cart-quote'
import { useCartRestore } from '@/features/cart/use-cart-sync'
import { SectionFrame } from '@/features/storefront/sections'
import { CART_PAGE_WIDTHS, CART_TEXT_DEFAULTS, isThemePreview, onColor } from '@/features/storefront/theme'
import { useStoreTheme } from '@/features/storefront/theme-context'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'

// The cart page. Its look is set in the theme builder (Cart → Cart page): title, layout, width,
// photo size and corners, quantity box, coupon box, summary box, checkout button and texts. In the
// builder's preview an empty cart shows sample items, so the page can be designed.

export default function CartPage() {
  const { items: cartItems, setQuantity, remove, couponCode, setCoupon } = useCart()
  const theme = useStoreTheme()
  const k = theme.cart_page
  const sample = isThemePreview() && cartItems.length === 0
  const items = sample ? CART_SAMPLE : cartItems
  const quote = useCartQuote(cartItems, couponCode)
  const [coupon, setCouponInput] = useState(couponCode)
  const problems = new Map((quote.data?.stock_errors ?? []).map((e) => [e.variant_id, e.message]))
  const blocker = sample ? null : cartBlocker(quote.error)
  const lines = new Map((quote.data?.lines ?? []).map((l) => [l.variant_id, l]))
  const couponState = quote.data?.coupon
  const restoring = useCartRestore()
  // The server's total once it answers; the cart's own sum until then (never ৳0 for a full cart).
  const subtotal = quote.data && !sample ? Number(quote.data.subtotal) : items.reduce((t, i) => t + i.price * i.quantity, 0)

  const photo: CSSProperties = { width: k.image_size, height: k.image_size, borderRadius: k.image_radius }
  const buttonBg = k.button_bg || theme.accent
  const button: CSSProperties = { background: buttonBg, color: k.button_text || onColor(buttonBg), borderRadius: k.button_radius }
  // A coloured summary box gets text that reads on it (dark box → light text and fields).
  const summaryText = k.summary_bg ? onColor(k.summary_bg) : ''
  const summary = { borderRadius: k.summary_radius, ...(k.summary_bg && {
    background: k.summary_bg, color: summaryText, '--foreground': summaryText,
    '--muted-foreground': `color-mix(in srgb, ${summaryText} 65%, transparent)`, '--border': `color-mix(in srgb, ${summaryText} 18%, transparent)`,
    '--input': `color-mix(in srgb, ${summaryText} 22%, transparent)`,
  }) } as CSSProperties

  if (restoring) return <div className="px-4 py-24 text-center text-sm text-muted-foreground">Bringing back your cart…</div>
  if (!items.length) {
    return (
      <SectionFrame id="cart-page" label="Cart page">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-24 text-center">
          <ShoppingBag className="size-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{k.empty_title || CART_TEXT_DEFAULTS.empty_title}</h1>
          <Button asChild style={button}><Link to="/shop">{k.empty_button || CART_TEXT_DEFAULTS.empty_button}</Link></Button>
        </div>
      </SectionFrame>
    )
  }

  return (
    <SectionFrame id="cart-page" label="Cart page">
      <div className="mx-auto px-4 py-8" style={{ maxWidth: CART_PAGE_WIDTHS[k.width] }}>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">{k.title || 'Cart'}</h1>
          {k.show_continue && <Link to="/shop" className="text-sm text-muted-foreground underline-offset-4 hover:underline">Continue shopping</Link>}
        </div>
        <div className={cn('grid gap-8', k.layout === 'side' && 'lg:grid-cols-[1fr_360px]')}>
          <ul className="divide-y border-y">
            {items.map((item) => {
              const line = sample ? undefined : lines.get(item.variantId)
              return (
                <li key={item.variantId} className="flex gap-4 py-5">
                  <Link to={item.slug ? `/product/${item.slug}` : '/shop'} className="shrink-0">
                    {item.image ? <img src={imageUrl(item.image, Math.min(400, k.image_size * 2))} alt="" className="bg-muted object-cover" style={photo} />
                      : <span aria-hidden className="block bg-muted" style={photo} />}
                  </Link>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex justify-between gap-3">
                      <div className="min-w-0">
                        <Link to={item.slug ? `/product/${item.slug}` : '/shop'} className="font-medium hover:underline">{item.name}</Link>
                        {item.variantTitle && <p className="text-sm text-muted-foreground">{item.variantTitle}</p>}
                        {k.show_each_price && <p className="text-sm text-muted-foreground"><Money value={line?.unit_price ?? item.price} /> each</p>}
                      </div>
                      <Money value={line?.line_subtotal ?? item.price * item.quantity} className="font-medium" />
                    </div>
                    {problems.get(item.variantId) && <p className="text-sm text-destructive">{problems.get(item.variantId)}</p>}
                    <div className="flex items-center gap-2">
                      <QuantityStepper value={item.quantity} max={item.maxQuantity} radius={k.stepper_radius} onChange={(v) => setQuantity(item.variantId, v)} />
                      <Button variant="ghost" size="sm" onClick={() => remove(item.variantId)}><Trash2 /> Remove</Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className={cn('h-fit space-y-4 p-5', k.summary_border && 'border')} style={summary}>
            {k.summary_title && <h2 className="text-base font-semibold">{k.summary_title}</h2>}
            {k.show_coupon && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setCoupon(coupon) }}>
                <Input value={coupon} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Coupon code" aria-label="Coupon code" />
                <Button type="submit" variant="outline">{k.coupon_button || CART_TEXT_DEFAULTS.coupon}</Button>
              </form>
            )}
            {couponCode && couponState && (
              <p className={couponState.valid ? 'text-sm text-emerald-700' : 'text-sm text-destructive'}>
                {couponState.message}{' '}
                <button className="underline" onClick={() => { setCoupon(''); setCouponInput('') }}>Remove</button>
              </p>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd><Money value={subtotal} /></dd></div>
              {Number(quote.data?.coupon_discount) > 0 && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-(quote.data?.coupon_discount ?? 0)} /></dd></div>
              )}
              <div className="flex justify-between"><dt className="text-muted-foreground">Delivery</dt><dd className="text-muted-foreground">Calculated at checkout</dd></div>
            </dl>
            {/* A link can't be disabled: while an item can't be bought, it's a disabled button. */}
            {blocker && <p role="alert" className="text-sm text-destructive">{blocker}</p>}
            {problems.size > 0 || blocker
              ? <Button type="button" size="lg" className="w-full" style={button} disabled>{k.button_lock_icon && <Lock />}{k.button_label || CART_TEXT_DEFAULTS.button}</Button>
              : <Button asChild size="lg" className="w-full" style={button}><Link to="/checkout">{k.button_lock_icon && <Lock />}{k.button_label || CART_TEXT_DEFAULTS.button}</Link></Button>}
            {k.note && <p className="text-center text-xs text-muted-foreground">{k.note}</p>}
          </div>
        </div>
      </div>
    </SectionFrame>
  )
}

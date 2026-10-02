import { ShoppingBag, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { QuantityStepper } from '@/features/cart/cart-drawer'
import { useCart } from '@/features/cart/cart-store'
import { useCartQuote } from '@/features/cart/use-cart-quote'
import { imageUrl } from '@/services/catalog'

export default function CartPage() {
  const { items, setQuantity, remove, couponCode, setCoupon } = useCart()
  const quote = useCartQuote(items, couponCode)
  const [coupon, setCouponInput] = useState(couponCode)
  const problems = new Map((quote.data?.stock_errors ?? []).map((e) => [e.variant_id, e.message]))
  const lines = new Map((quote.data?.lines ?? []).map((l) => [l.variant_id, l]))
  const couponState = quote.data?.coupon

  if (!items.length) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-24 text-center">
        <ShoppingBag className="size-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Your cart is empty</h1>
        <Button asChild><Link to="/shop">Start shopping</Link></Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Cart</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <ul className="divide-y border-y">
          {items.map((item) => {
            const line = lines.get(item.variantId)
            return (
              <li key={item.variantId} className="flex gap-4 py-5">
                <Link to={`/product/${item.slug}`}><img src={imageUrl(item.image, 200)} alt="" className="size-24 rounded-md bg-muted object-cover" /></Link>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/product/${item.slug}`} className="font-medium hover:underline">{item.name}</Link>
                      {item.variantTitle && <p className="text-sm text-muted-foreground">{item.variantTitle}</p>}
                      <p className="text-sm text-muted-foreground"><Money value={line?.unit_price ?? item.price} /> each</p>
                    </div>
                    <Money value={line?.line_subtotal ?? item.price * item.quantity} className="font-medium" />
                  </div>
                  {problems.get(item.variantId) && <p className="text-sm text-destructive">{problems.get(item.variantId)}</p>}
                  <div className="flex items-center gap-2">
                    <QuantityStepper value={item.quantity} max={item.maxQuantity} onChange={(v) => setQuantity(item.variantId, v)} />
                    <Button variant="ghost" size="sm" onClick={() => remove(item.variantId)}><Trash2 /> Remove</Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        <Card className="h-fit">
          <CardContent className="space-y-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setCoupon(coupon) }}>
              <Input value={coupon} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Coupon code" aria-label="Coupon code" />
              <Button type="submit" variant="outline">Apply</Button>
            </form>
            {couponCode && couponState && (
              <p className={couponState.valid ? 'text-sm text-emerald-700' : 'text-sm text-destructive'}>
                {couponState.message}{' '}
                <button className="underline" onClick={() => { setCoupon(''); setCouponInput('') }}>Remove</button>
              </p>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd><Money value={quote.data?.subtotal ?? 0} /></dd></div>
              {Number(quote.data?.coupon_discount) > 0 && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-(quote.data?.coupon_discount ?? 0)} /></dd></div>
              )}
              <div className="flex justify-between"><dt className="text-muted-foreground">Delivery</dt><dd className="text-muted-foreground">Calculated at checkout</dd></div>
            </dl>
            <Button asChild size="lg" className="w-full" disabled={problems.size > 0}>
              <Link to="/checkout">Checkout</Link>
            </Button>
            <p className="text-center text-xs text-muted-foreground">Cash on delivery available</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

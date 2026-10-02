import { Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { imageUrl } from '@/services/catalog'
import { cartCount, useCart } from './cart-store'
import { useCartQuote } from './use-cart-quote'

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
  const { items, isOpen, setOpen, setQuantity, remove, couponCode } = useCart()
  const quote = useCartQuote(items, couponCode)
  const problems = new Map((quote.data?.stock_errors ?? []).map((e) => [e.variant_id, e.message]))

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Your cart ({cartCount(items)})</SheetTitle>
          <SheetDescription className="sr-only">Items in your cart</SheetDescription>
        </SheetHeader>
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <ShoppingBag className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Your cart is empty.</p>
            <Button asChild onClick={() => setOpen(false)}><Link to="/shop">Continue shopping</Link></Button>
          </div>
        ) : (
          <>
            <ul className="flex-1 divide-y overflow-y-auto px-4">
              {items.map((item) => (
                <li key={item.variantId} className="flex gap-3 py-4">
                  <Link to={`/product/${item.slug}`} onClick={() => setOpen(false)} className="shrink-0">
                    <img src={imageUrl(item.image, 160)} alt="" className="size-20 rounded-md bg-muted object-cover" loading="lazy" />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        {item.variantTitle && <p className="text-xs text-muted-foreground">{item.variantTitle}</p>}
                      </div>
                      <Money value={item.price * item.quantity} className="text-sm" />
                    </div>
                    {problems.get(item.variantId) && <p className="mt-1 text-xs text-destructive">{problems.get(item.variantId)}</p>}
                    <div className="mt-2 flex items-center justify-between">
                      <QuantityStepper value={item.quantity} max={item.maxQuantity} onChange={(v) => setQuantity(item.variantId, v)} />
                      <Button variant="ghost" size="icon-sm" onClick={() => remove(item.variantId)} aria-label={`Remove ${item.name}`}><Trash2 /></Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <SheetFooter className="border-t">
              <div className="flex justify-between text-sm">
                <span>Subtotal</span>
                <Money value={quote.data?.subtotal ?? items.reduce((s, i) => s + i.price * i.quantity, 0)} className="font-medium" />
              </div>
              <p className="text-xs text-muted-foreground">Delivery and discounts are calculated at checkout.</p>
              <Button asChild size="lg" onClick={() => setOpen(false)} disabled={problems.size > 0}>
                <Link to="/checkout">Checkout</Link>
              </Button>
              <Button asChild variant="outline" onClick={() => setOpen(false)}><Link to="/cart">View cart</Link></Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from '@/hooks/use-debounce'
import { quoteCart } from '@/services/storefront'
import { cartLines, type CartItem } from './cart-store'

/** Server-side price preview for the cart (subtotal, coupon, stock problems). */
export function useCartQuote(items: CartItem[], coupon: string, district?: string | null) {
  const lines = useDebounce(cartLines(items), 250)
  return useQuery({
    queryKey: ['cart-quote', lines, coupon, district],
    enabled: lines.length > 0,
    placeholderData: keepPreviousData,
    queryFn: () => quoteCart(lines, district, coupon || null),
  })
}

/** Why the cart can't go to checkout as it is, from the server's refusal to price it (e.g. "You can
 *  order at most 20 of Linen Shirt"). Network trouble is not a reason: it never blocks checkout. */
export function cartBlocker(error: unknown): string | null {
  const e = error as { code?: string; message?: string } | null
  if (!e?.message || (e.code !== '22023' && !/^VALIDATION:/.test(e.message))) return null
  const m = e.message.replace(/^VALIDATION:\s*/, '').trim()
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : null
}

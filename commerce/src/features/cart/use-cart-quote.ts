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

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { storeKey } from '@/lib/merchant'

// The cart only remembers what the customer picked. Prices shown here are a
// preview; the server recalculates everything at checkout.
export interface CartItem {
  variantId: string
  productId: string
  slug: string
  name: string
  variantTitle: string | null
  price: number
  /** The regular price when the product is on sale (shows what the customer saves). */
  compareAt?: number | null
  image: string | null
  quantity: number
  maxQuantity: number
}

interface CartState {
  items: CartItem[]
  couponCode: string
  isOpen: boolean
  /** Adds to the cart and opens the cart drawer (unless open is false). */
  add: (item: Omit<CartItem, 'quantity'>, quantity?: number, open?: boolean) => void
  setQuantity: (variantId: string, quantity: number) => void
  remove: (variantId: string) => void
  clear: () => void
  setCoupon: (code: string) => void
  setOpen: (open: boolean) => void
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      items: [],
      couponCode: '',
      isOpen: false,
      add: (item, quantity = 1, open = true) =>
        set((state) => {
          const existing = state.items.find((i) => i.variantId === item.variantId)
          if (existing) {
            return {
              isOpen: open || state.isOpen,
              items: state.items.map((i) =>
                i.variantId === item.variantId ? { ...i, ...item, quantity: Math.min(i.quantity + quantity, item.maxQuantity) } : i,
              ),
            }
          }
          return { isOpen: open || state.isOpen, items: [...state.items, { ...item, quantity: Math.min(quantity, item.maxQuantity) }] }
        }),
      setQuantity: (variantId, quantity) =>
        set((state) => ({
          items: state.items
            .map((i) => (i.variantId === variantId ? { ...i, quantity: Math.max(0, Math.min(quantity, i.maxQuantity)) } : i))
            .filter((i) => i.quantity > 0),
        })),
      remove: (variantId) => set((state) => ({ items: state.items.filter((i) => i.variantId !== variantId) })),
      clear: () => set({ items: [], couponCode: '' }),
      setCoupon: (code) => set({ couponCode: code.trim().toUpperCase() }),
      setOpen: (open) => set({ isOpen: open }),
    }),
    // One cart per store (storeKey: stores opened by path share the platform's origin).
    { name: storeKey('cart-v1'), partialize: (s) => ({ items: s.items, couponCode: s.couponCode }) },
  ),
)

export const cartCount = (items: CartItem[]) => items.reduce((sum, i) => sum + i.quantity, 0)
export const cartLines = (items: CartItem[]) => items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity }))

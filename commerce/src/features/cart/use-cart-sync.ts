import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from '@/lib/toast'
import { currentAttribution, sessionId, visitorId } from '@/lib/attribution'
import { supabase } from '@/lib/supabase'
import { type CartItem, useCart } from './cart-store'

/**
 * Keeps a copy of the cart on the server so a cart left behind can be followed
 * up (Web Orders → Abandoned Carts). Only variant ids and quantities are sent;
 * the server takes names and prices from the catalog. Fire-and-forget.
 */
export function useCartSync() {
  const items = useCart((s) => s.items)
  const key = items.map((i) => `${i.variantId}:${i.quantity}`).join(',')
  const last = useRef<string | null>(null)
  useEffect(() => {
    // Nothing to report until the visitor has had a cart.
    if (last.current === null && !key) { last.current = ''; return }
    if (key === last.current) return
    const t = window.setTimeout(() => {
      last.current = key
      const lines = useCart.getState().items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity }))
      void supabase.rpc('storefront_cart_sync' as never, {
        p_visitor_id: visitorId(), p_session_id: sessionId(), p_items: lines, p_attribution: lines.length ? currentAttribution() : null,
      } as never).then(({ error }) => { if (error && import.meta.env.DEV) console.warn('storefront_cart_sync', error.message) })
    }, 2000)
    return () => window.clearTimeout(t)
  }, [key])
}

/** "Finish your order" links from staff: /cart?restore=<cart id> puts the same items back in the cart. */
export function useCartRestore(): boolean {
  const [params, setParams] = useSearchParams()
  const id = params.get('restore')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return
    let cancelled = false
    setBusy(true)
    void supabase.rpc('storefront_cart_restore' as never, { p_id: id } as never).then(({ data, error }) => {
      if (cancelled) return
      setBusy(false)
      const next = new URLSearchParams(params)
      next.delete('restore')
      setParams(next, { replace: true })
      const restored = (data ?? []) as unknown as CartItem[]
      if (error || !restored.length) {
        toast.info('This cart link has expired', { description: 'The items may be sold out or already ordered.' })
        return
      }
      const cart = useCart.getState()
      for (const item of restored) {
        const have = cart.items.find((i) => i.variantId === item.variantId)
        const { quantity, ...rest } = item
        if (!have) cart.add(rest, quantity)
      }
      cart.setOpen(false)
      toast.success('Your cart is back', { description: 'Check the items and continue to checkout.' })
    })
    return () => { cancelled = true }
  }, [id])
  return busy
}

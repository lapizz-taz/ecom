import { type Attribution, sessionId, visitorId } from '@/lib/attribution'
import { invokeFunction } from '@/lib/functions'
import { asJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type {
  CategoryPublic, MyOrdersPage, PaymentInitResponse, PaymentMethod, PaymentRequirement, ProductDetail, ProductList,
  PublicOrder, Quote,
} from '@/types/domain'

export interface ProductQuery {
  category?: string
  search?: string
  sort?: string
  minPrice?: number
  maxPrice?: number
  inStock?: boolean
  tag?: string
  featured?: boolean
  limit?: number
  offset?: number
}

export async function listProducts(q: ProductQuery): Promise<ProductList> {
  const { data, error } = await supabase.rpc('storefront_list_products', {
    p_category: q.category,
    p_search: q.search,
    p_sort: q.sort ?? 'newest',
    p_min_price: q.minPrice,
    p_max_price: q.maxPrice,
    p_in_stock: q.inStock ?? false,
    p_tag: q.tag,
    p_featured: q.featured ?? false,
    p_limit: q.limit ?? 24,
    p_offset: q.offset ?? 0,
  })
  if (error) throw error
  return data as unknown as ProductList
}

export async function getProduct(slug: string): Promise<ProductDetail | null> {
  const { data, error } = await supabase.rpc('storefront_get_product', { p_slug: slug })
  if (error) throw error
  return (data as unknown as ProductDetail | null) ?? null
}

export async function getCategories(): Promise<CategoryPublic[]> {
  const { data, error } = await supabase.rpc('storefront_categories')
  if (error) throw error
  return (data as unknown as CategoryPublic[]) ?? []
}

export interface CartLineInput {
  variant_id: string
  quantity: number
}

/** Price preview for the cart (no phone → no risk check). */
export async function quoteCart(items: CartLineInput[], district?: string | null, coupon?: string | null): Promise<Quote> {
  const { data, error } = await supabase.rpc('storefront_quote', {
    p_items: asJson(items),
    p_district: district ?? undefined,
    p_coupon_code: coupon ?? undefined,
  })
  if (error) throw error
  return data as unknown as Quote
}

export interface CheckoutQuoteInput {
  items: CartLineInput[]
  district?: string | null
  area?: string | null
  delivery_method: string
  coupon_code?: string | null
  phone?: string | null
  payment_method: PaymentMethod
  lead?: { customer_name?: string | null; address?: string | null } | null
  attribution?: Attribution | null
}

export function checkoutQuote(input: CheckoutQuoteInput) {
  return invokeFunction<{ quote: Quote; payment_requirement: PaymentRequirement | null }>('checkout', { action: 'quote', ...input })
}

export interface PlaceOrderInput {
  customer: { full_name: string; phone: string; email?: string | null }
  shipping: { address: string; area?: string | null; city?: string | null; district: string; postal_code?: string | null }
  items: CartLineInput[]
  delivery_method: string
  payment_method: PaymentMethod
  coupon_code?: string | null
  customer_note?: string | null
  idempotency_key: string
  advance_payment?: { channel: 'BKASH' | 'NAGAD' | 'ROCKET'; sender_phone: string; transaction_id: string } | null
  attribution?: Attribution | null
}

export function placeOrder(input: PlaceOrderInput) {
  return invokeFunction<{ order: PublicOrder & { merged?: boolean }; payment: { status: string; amount: number } | null; payment_error: string | null }>(
    'checkout', { action: 'place', ...input })
}

export async function trackOrder(orderNumber: string, phone: string): Promise<PublicOrder | null> {
  const { data, error } = await supabase.rpc('track_order', { p_order_number: orderNumber, p_phone: phone })
  if (error) throw error
  return (data as unknown as PublicOrder | null) ?? null
}

export async function myOrders(limit = 20, offset = 0): Promise<MyOrdersPage> {
  const { data, error } = await supabase.rpc('customer_my_orders', { p_limit: limit, p_offset: offset })
  if (error) throw error
  return (data as unknown as MyOrdersPage | null) ?? { total: 0, items: [] }
}

export async function myOrder(id: string): Promise<PublicOrder | null> {
  const { data, error } = await supabase.rpc('customer_get_order', { p_order_id: id })
  if (error) throw error
  return (data as unknown as PublicOrder | null) ?? null
}

export function initiatePayment(input: { order_number: string; phone: string; provider: string; purpose: 'ADVANCE' | 'FULL' | 'BALANCE' }) {
  return invokeFunction<PaymentInitResponse>('payments', { action: 'initiate', ...input })
}

export function submitManualPayment(input: {
  order_number: string
  phone: string
  channel: 'BKASH' | 'NAGAD' | 'ROCKET' | 'BANK_TRANSFER' | 'OTHER'
  sender_phone: string
  transaction_id: string
  amount: number
}) {
  return invokeFunction<{ payment: { reference: string; status: string; amount: number } }>('payments', { action: 'submit_manual', ...input })
}

export async function submitContact(input: { name: string; phone?: string; email?: string; subject?: string; message: string }) {
  const { error } = await supabase.rpc('submit_contact_message', {
    p_name: input.name, p_phone: input.phone ?? '', p_email: input.email ?? '', p_subject: input.subject ?? '', p_message: input.message,
  })
  if (error) throw error
}

// First-party analytics (journey + conversion rate). Fire-and-forget.
export function trackEvent(type: 'PAGE_VIEW' | 'VIEW_PRODUCT' | 'ADD_TO_CART' | 'BEGIN_CHECKOUT' | 'PURCHASE', productId?: string): void {
  void supabase.rpc('track_visit_event', {
    p_visitor_id: visitorId(),
    p_session_id: sessionId(),
    p_event_type: type,
    p_product_id: productId,
    p_page: `${window.location.pathname}${window.location.search}`.slice(0, 300),
  }).then(({ error }) => { if (error && import.meta.env.DEV) console.warn('track_visit_event', error.message) })
}

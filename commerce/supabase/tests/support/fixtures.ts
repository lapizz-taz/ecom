import { randomUUID } from 'node:crypto'
import { asService, asSystem, one, value, type Db } from './db'

export async function createStaff(db: Db, roleCode: string, email = `${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`): Promise<string> {
  await asSystem(db)
  const id = randomUUID()
  await db.query(`insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    email,
    JSON.stringify({ full_name: `Test ${roleCode}` }),
  ])
  await db.query(`select public.admin_set_user_role($1, $2, true)`, [id, roleCode])
  return id
}

export async function createCustomerUser(db: Db, email = `customer-${randomUUID().slice(0, 8)}@example.com`): Promise<string> {
  await asSystem(db)
  const id = randomUUID()
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, email])
  return id
}

export interface ProductInput {
  name?: string
  price: number
  cost?: number
  stock?: number
  trackInventory?: boolean
  requiresProduction?: boolean
  variants?: Array<{ sku: string; title: string; price?: number; cost?: number; stock?: number }>
}

export interface ProductFixture {
  productId: string
  variantIds: string[]
}

export async function createProduct(db: Db, input: ProductInput): Promise<ProductFixture> {
  await asSystem(db)
  const name = input.name ?? `Product ${randomUUID().slice(0, 6)}`
  const suffix = randomUUID().slice(0, 6).toUpperCase()
  const variants = input.variants ?? [{ sku: `SKU-${suffix}`, title: 'Default', stock: input.stock ?? 10 }]
  const product = await one<{ id: string }>(db, `select id from public.admin_save_product($1)`, [
    JSON.stringify({
      name,
      slug: `${name}-${suffix}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      status: 'ACTIVE',
      price: input.price,
      cost_price: input.cost ?? 0,
      track_inventory: input.trackInventory ?? true,
      requires_production: input.requiresProduction ?? false,
      variants: variants.map((v) => ({
        sku: v.sku,
        title: v.title,
        price: v.price,
        cost_price: v.cost,
        initial_stock: v.stock ?? input.stock ?? 10,
      })),
    }),
  ])
  const ids = await db.query<{ id: string }>(
    `select id from public.product_variants where product_id = $1 order by position`,
    [product.id],
  )
  return { productId: product.id, variantIds: ids.rows.map((r) => r.id) }
}

export interface OrderInput {
  phone?: string
  name?: string
  district?: string
  area?: string
  items: Array<{ variantId: string; quantity: number; unitPrice?: number }>
  paymentMethod?: 'COD' | 'ADVANCE' | 'FULL_PAYMENT'
  coupon?: string
  deliveryMethod?: string
  idempotencyKey?: string
}

export function orderPayload(input: OrderInput): Record<string, unknown> {
  return {
    customer: { full_name: input.name ?? 'Test Customer', phone: input.phone ?? '01711000001', email: null },
    shipping: { address: 'House 1, Road 2, Dhanmondi', district: input.district ?? 'Dhaka', area: input.area ?? null },
    items: input.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity, unit_price: i.unitPrice })),
    payment_method: input.paymentMethod ?? 'COD',
    coupon_code: input.coupon ?? null,
    delivery_method: input.deliveryMethod ?? 'standard',
    idempotency_key: input.idempotencyKey ?? null,
  }
}

export interface OrderRow {
  id: string
  order_number: string
  status: string
  subtotal: string
  discount_total: string
  delivery_charge: string
  delivery_discount: string
  total_amount: string
  advance_required: string
  amount_paid: string
  cod_amount: string
  cost_total: string
  payment_status: string
  customer_id: string
  fraud_check_id: string | null
}

/** Creates an order exactly like the storefront does (no risk check). */
export async function createOrder(db: Db, input: OrderInput): Promise<OrderRow> {
  await asSystem(db)
  return one<OrderRow>(db, `select * from public._create_order($1, 'STOREFRONT')`, [JSON.stringify(orderPayload(input))])
}

/** Storefront checkout: record a fraud check then place the order atomically. */
export async function placeOrder(db: Db, input: OrderInput, providerCounts?: Record<string, number>): Promise<OrderRow & { requirement: Record<string, unknown> }> {
  await asService(db)
  const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [
    JSON.stringify({
      phone: input.phone ?? '01711000001',
      provider: providerCounts ? 'http' : 'internal',
      provider_counts: providerCounts ?? {},
    }),
  ])
  const placed = await value<Record<string, unknown>>(db, `select public.place_storefront_order($1, $2)`, [
    JSON.stringify(orderPayload(input)),
    check.id,
  ])
  await asSystem(db)
  const order = await one<OrderRow>(db, `select * from public.orders where id = $1`, [placed.id])
  return { ...order, requirement: placed.payment_requirement as Record<string, unknown> }
}

export async function transition(db: Db, orderId: string, to: string, note = 'test'): Promise<OrderRow> {
  await asSystem(db)
  return one<OrderRow>(db, `select * from public._transition_order($1, $2::public.order_status, $3)`, [orderId, to, note])
}

/** Walks an order through the pipeline to the given status. */
export async function advanceOrder(db: Db, orderId: string, path: string[]): Promise<OrderRow> {
  let order: OrderRow | undefined
  for (const status of path) order = await transition(db, orderId, status)
  return order as OrderRow
}

export async function inventory(db: Db, variantId: string): Promise<{ on_hand: number; reserved: number; available: number; damaged: number }> {
  await asSystem(db)
  const row = await one<Record<string, string>>(db, `select on_hand, reserved, available, damaged from public.inventory where variant_id = $1`, [variantId])
  return {
    on_hand: Number(row.on_hand),
    reserved: Number(row.reserved),
    available: Number(row.available),
    damaged: Number(row.damaged),
  }
}

export async function setSetting(db: Db, key: string, patch: Record<string, unknown>): Promise<void> {
  await asSystem(db)
  await db.query(`update public.settings set value = value || $2::jsonb where key = $1`, [key, JSON.stringify(patch)])
}

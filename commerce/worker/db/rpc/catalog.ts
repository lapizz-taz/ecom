// Products and stock: the catalog editor, quick and bulk edits, stock movements and
// adjustments, plan limits and the stock insights page. Ported from the Postgres
// functions of the same names; every stock change is one movement row plus the
// inventory update, in the same transaction.
import { raise } from '../errors.ts'
import { Q } from '../q.ts'
import { logAudit, type Values, type WriteEnv } from '../writer.ts'
import { asOwner, bool, int, isArray, nonEmpty, numeric, settingBool, settingNumeric, slugify, text, textArray, trimmed, uuid, type Json } from './helpers.ts'
import type { RpcImpl } from './index.ts'

type Movement = Values & { id: string; on_hand_after: number; reserved_after: number; damaged_after: number }
type Inventory = { variant_id: string; product_id: string; on_hand: number; reserved: number; available: number; damaged: number }
type Product = Values & { id: string; slug: string; sku: string | null; category_id: string | null }

const MANUAL_TYPES = ['ADJUSTMENT', 'PURCHASE', 'DAMAGE', 'LOSS', 'TRANSFER']

// ---------------------------------------------------------------- plan limits

/** public.merchant_limits: the plan's limits plus add-ons. */
export function merchantLimits(env: WriteEnv, merchant: string | null = env.ctx.merchantId()): Record<string, number> {
  const q = asOwner(env, 'postgres')
  const base = q.value<string>(`SELECT p.limits FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.merchant_id = ? AND s.ended_at IS NULL`, [merchant])
  if (!base) return {}
  const extra = new Map<string, number>()
  for (const r of q.raw(`SELECT a.grants, sa.quantity FROM subscription_addons sa JOIN plan_addons a ON a.id = sa.addon_id
      WHERE sa.merchant_id = ? AND sa.ended_at IS NULL`, [merchant])) {
    for (const [k, v] of Object.entries(JSON.parse(String(r.grants)) as Json)) {
      extra.set(k, (extra.get(k) ?? 0) + Number(v) * Number(r.quantity))
    }
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(JSON.parse(base) as Json)) {
    if (v === null) continue
    out[k] = Number(v) + (extra.get(k) ?? 0)
  }
  return out
}

/** public.merchant_usage */
export function merchantUsage(env: WriteEnv, merchant: string | null = env.ctx.merchantId()): Record<string, number> {
  const q = asOwner(env, 'postgres')
  const month = `${env.ctx.now.slice(0, 7)}-01T00:00:00.000Z`
  const count = (sql: string, params: Array<string | null> = []) => Number(q.value(sql, [merchant, ...params]))
  return {
    stores: count("SELECT count(*) FROM sales_channels WHERE merchant_id = ? AND status <> 'DISCONNECTED'"),
    staff: count('SELECT count(*) FROM profiles WHERE merchant_id = ? AND is_active = 1'),
    products: count("SELECT count(*) FROM products WHERE merchant_id = ? AND status <> 'ARCHIVED'"),
    orders_per_month: count('SELECT count(*) FROM orders WHERE merchant_id = ? AND created_at >= ?', [month]),
  }
}

/** public.require_limit */
export function requireLimit(env: WriteEnv, key: string): void {
  const limit = merchantLimits(env)[key]
  const used = merchantUsage(env)[key]
  if (limit !== undefined && used >= limit) {
    raise(`LIMIT_REACHED: your plan allows ${limit} ${key.replaceAll('_', ' ')}; upgrade the plan or ask for an add-on`)
  }
}

// ---------------------------------------------------------------- stock

/** public.variant_cost */
export function variantCost(q: Q, variantId: string): number | null {
  const r = q.one<{ cost: number | null }>(`SELECT coalesce(v.cost_price, p.cost_price, 0) AS cost
    FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, [variantId])
  return r ? r.cost : null
}

/** public.allow_overselling: while importing a store's orders, or when the store allows it. */
export function allowOverselling(q: Q): boolean {
  return q.ctx.flags.get('store_order_import') === 'on' || settingBool(q, 'inventory', ['allow_overselling'], false)
}

export interface MovementInput {
  variantId: string
  type: string
  onHand: number
  reserved: number
  damaged: number
  referenceType: string | null
  referenceId: string | null
  referenceLabel: string | null
  note: string | null
  unitCost?: number | null
  allowNegative?: boolean
}

/** public._apply_inventory_movement: changes the stock counters and records the movement. */
export function applyInventoryMovement(env: WriteEnv, m: MovementInput): Movement {
  const q = asOwner(env)
  if (!m.onHand && !m.reserved && !m.damaged) raise('VALIDATION: stock movement without a quantity', '22023')
  if (!q.exists('SELECT 1 FROM inventory WHERE variant_id = ?', [m.variantId])) {
    const v = q.one<{ id: string; product_id: string }>('SELECT id, product_id FROM product_variants WHERE id = ?', [m.variantId])
    if (v) q.insert('inventory', { variant_id: v.id, product_id: v.product_id })
  }
  const inv = q.one<Inventory>('SELECT * FROM inventory WHERE variant_id = ?', [m.variantId], 'inventory')
  if (!inv) return raise(`NOT_FOUND: variant ${m.variantId} does not exist`, 'P0002')
  if (inv.on_hand + m.onHand < 0 && !(m.allowNegative || allowOverselling(q))) raise('INSUFFICIENT_STOCK: physical stock cannot go below zero')
  if (inv.reserved + m.reserved < 0) raise('VALIDATION: reserved stock cannot go below zero', '22023')
  if (inv.damaged + m.damaged < 0) raise('VALIDATION: damaged stock cannot go below zero', '22023')
  q.update('inventory', {
    on_hand: inv.on_hand + m.onHand, reserved: inv.reserved + m.reserved, damaged: inv.damaged + m.damaged, updated_at: q.now,
  }, { keys: [[m.variantId]] })
  const after = q.one<Inventory>('SELECT * FROM inventory WHERE variant_id = ?', [m.variantId], 'inventory')!
  return q.insertOne<Movement>('inventory_movements', {
    product_id: after.product_id, variant_id: m.variantId, movement_type: m.type,
    quantity: Math.max(Math.abs(m.onHand), Math.abs(m.reserved), Math.abs(m.damaged)),
    on_hand_change: m.onHand, reserved_change: m.reserved, damaged_change: m.damaged,
    on_hand_after: after.on_hand, reserved_after: after.reserved, damaged_after: after.damaged,
    unit_cost: m.unitCost ?? null, reference_type: m.referenceType, reference_id: m.referenceId, reference_label: m.referenceLabel,
    note: m.note, created_by: env.ctx.uid,
  })
}

/** public.adjust_stock */
export function adjustStock(env: WriteEnv, variantId: string, type: string, quantity: number | null, note: string | null, mode: string | null = 'ADD', unitCost: number | null = null): Movement {
  const q = asOwner(env)
  env.ctx.requirePermission('inventory.adjust')
  const upper = (mode ?? '').toUpperCase()
  if (quantity === null || quantity < 0 || (quantity === 0 && upper !== 'SET')) raise('VALIDATION: quantity must be a positive number', '22023')
  if (!(note ?? '').trim()) raise('VALIDATION: a reason/note is required for stock adjustments', '22023')
  const inv = q.one<Inventory>('SELECT * FROM inventory WHERE variant_id = ?', [variantId], 'inventory')
  if (!inv) return raise(`NOT_FOUND: variant ${variantId} has no inventory record`, 'P0002')
  const qty = quantity!
  const move = (t: string, onHand: number, damaged: number, cost: number | null = null) =>
    applyInventoryMovement(env, { variantId, type: t, onHand, reserved: 0, damaged, referenceType: 'ADJUSTMENT', referenceId: null, referenceLabel: null, note, unitCost: cost })
  if (!MANUAL_TYPES.includes(type)) raise(`VALIDATION: ${type} cannot be recorded manually`, '22023')
  let mov: Movement
  if (type === 'ADJUSTMENT') {
    const delta = upper === 'ADD' ? qty : upper === 'REMOVE' ? -qty : upper === 'SET' ? qty - inv.on_hand : null
    if (delta === null) return raise('VALIDATION: mode must be ADD, REMOVE or SET', '22023')
    if (delta === 0) raise(`VALIDATION: stock is already ${qty}`, '22023')
    if (delta < 0 && inv.available + delta < 0 && !allowOverselling(q)) {
      raise(`INSUFFICIENT_STOCK: only ${inv.available} available (${inv.reserved} reserved for orders)`)
    }
    mov = move('ADJUSTMENT', delta, 0, unitCost)
  } else if (type === 'PURCHASE') {
    mov = move('PURCHASE', qty, 0, unitCost)
  } else if (type === 'DAMAGE' || type === 'LOSS') {
    if (inv.available - qty < 0 && !allowOverselling(q)) raise(`INSUFFICIENT_STOCK: only ${inv.available} available`)
    mov = type === 'DAMAGE' ? move('DAMAGE', -qty, qty) : move('LOSS', -qty, 0)
  } else {
    mov = move('TRANSFER', qty, -qty)
  }
  logAudit(q.env, 'stock.adjusted', 'product_variant', variantId,
    { on_hand: inv.on_hand, damaged: inv.damaged }, { on_hand: mov.on_hand_after, damaged: mov.damaged_after },
    { type, mode, quantity, note, movement_id: mov.id })
  return mov
}

/** public.inventory_bulk_adjust */
function inventoryBulkAdjust(env: WriteEnv, items: unknown, note: string | null): Json {
  env.ctx.requirePermission('inventory.adjust')
  if (!isArray(items) || items.length === 0) raise('VALIDATION: nothing to change', '22023')
  if ((items as unknown[]).length > 1000) raise('VALIDATION: change at most 1000 variants at a time', '22023')
  if ((note ?? '').trim().length < 2) raise('VALIDATION: add a short note (why the stock changes)', '22023')
  let n = 0
  for (const raw of items as Json[]) {
    const item = (raw ?? {}) as Json
    const mode = (text(item.mode) ?? 'ADD').toUpperCase()
    const qty = int(item.quantity)
    if (!['ADD', 'REMOVE', 'SET'].includes(mode) || qty === null || qty < 0) {
      raise('VALIDATION: each line needs a quantity of 0 or more and ADD, REMOVE or SET', '22023')
    }
    if (qty === 0 && mode !== 'SET') continue
    adjustStock(env, uuid(item.variant_id)!, 'ADJUSTMENT', qty, note!.trim(), mode, null)
    n++
  }
  return { changed: n }
}

// ---------------------------------------------------------------- products

const variantList = (v: unknown): Json[] => (isArray(v) ? (v as Json[]) : [])

/** public.admin_save_product */
export function saveProduct(env: WriteEnv, p: Json): Product {
  const q = asOwner(env)
  env.ctx.requirePermission('products.manage')
  const id = uuid(nonEmpty(p.id))
  if (id === null) requireLimit(env, 'products')
  if (!(text(p.name) ?? '').trim()) raise('VALIDATION: product name is required', '22023')
  const price = numeric(p.price)
  if (price === null || price < 0) raise('VALIDATION: price must be zero or more', '22023')
  const slug = slugify(text(p.slug)) || slugify(text(p.name))
  if (!slug) raise('VALIDATION: product slug is required', '22023')

  const fields: Values = {
    name: text(p.name)!.trim(),
    slug,
    sku: trimmed(p.sku),
    description: text(p.description),
    category_id: uuid(nonEmpty(p.category_id)),
    brand: nonEmpty(p.brand),
    tags: textArray(p.tags ?? []),
    option_names: textArray(p.option_names ?? []),
    cost_price: numeric(p.cost_price) ?? 0,
    price,
    compare_at_price: numeric(nonEmpty(p.compare_at_price)),
    weight_grams: int(nonEmpty(p.weight_grams)),
    low_stock_threshold: int(nonEmpty(p.low_stock_threshold)),
    seo_title: nonEmpty(p.seo_title),
    seo_description: nonEmpty(p.seo_description),
  }
  let product: Product
  if (id === null) {
    product = q.insertOne<Product>('products', {
      ...fields,
      status: nonEmpty(p.status) ?? 'DRAFT',
      track_inventory: bool(p.track_inventory) ?? true,
      requires_production: bool(p.requires_production) ?? false,
      is_featured: bool(p.is_featured) ?? false,
      created_by: env.ctx.uid,
    })
  } else {
    const current = q.one<Values>('SELECT status, track_inventory, requires_production, is_featured FROM products WHERE id = ?', [id], 'products')
    if (!current) return raise(`NOT_FOUND: product ${id} does not exist`, 'P0002')
    q.update('products', {
      ...fields,
      status: nonEmpty(p.status) ?? current.status,
      track_inventory: bool(p.track_inventory) ?? current.track_inventory,
      requires_production: bool(p.requires_production) ?? current.requires_production,
      is_featured: bool(p.is_featured) ?? current.is_featured,
    }, { keys: [[id]] })
    product = q.byKey<Product>('products', [id])!
  }

  // A product always has at least one variant (the "Default" variant).
  let variants = variantList(p.variants ?? [])
  if (variants.length === 0) {
    variants = q.rows<Json>('SELECT id, sku, title, is_active FROM product_variants WHERE product_id = ? AND is_default = 1', [product.id], 'product_variants')
    if (variants.length === 0) {
      variants = [{ sku: product.sku ?? `${product.slug.slice(0, 24).toUpperCase()}-${product.id.slice(0, 6)}`, title: 'Default' }]
    }
  }

  const keep: string[] = []
  let pos = 0
  for (const v of variants) {
    const variantId = uuid(nonEmpty(v.id))
    if (!(text(v.sku) ?? '').trim()) raise('VALIDATION: every variant needs a SKU', '22023')
    const common = {
      sku: text(v.sku)!.trim(),
      size: nonEmpty(v.size),
      color: nonEmpty(v.color),
      price: numeric(nonEmpty(v.price)),
      compare_at_price: numeric(nonEmpty(v.compare_at_price)),
      cost_price: numeric(nonEmpty(v.cost_price)),
      weight_grams: int(nonEmpty(v.weight_grams)),
      barcode: nonEmpty(v.barcode),
      position: int(v.position) ?? pos,
      is_active: bool(v.is_active) ?? true,
    }
    let saved: string
    if (variantId === null) {
      const [key] = q.insert('product_variants', {
        ...common, product_id: product.id, title: trimmed(v.title) ?? 'Default',
        option_values: v.option_values ?? {}, is_default: pos === 0,
      })
      saved = key[0] as string
      const initial = int(nonEmpty(v.initial_stock)) ?? 0
      if (initial < 0) raise('VALIDATION: opening stock cannot be negative', '22023')
      if (initial > 0) {
        applyInventoryMovement(env, {
          variantId: saved, type: 'ADJUSTMENT', onHand: initial, reserved: 0, damaged: 0, referenceType: 'ADJUSTMENT',
          referenceId: null, referenceLabel: null, note: 'Opening stock', unitCost: variantCost(q, saved),
        })
      }
    } else {
      const current = q.one<Values>('SELECT title, option_values FROM product_variants WHERE id = ? AND product_id = ?', [variantId, product.id], 'product_variants')
      if (!current) return raise(`NOT_FOUND: variant ${variantId} does not belong to this product`, 'P0002')
      q.update('product_variants', {
        ...common, title: trimmed(v.title) ?? current.title, option_values: v.option_values ?? current.option_values,
      }, { keys: [[variantId]] })
      saved = variantId
    }
    keep.push(saved)
    pos++
  }

  q.update('product_variants', { is_active: false }, {
    sql: 'product_id = ? AND id NOT IN (SELECT value FROM json_each(?)) AND is_active = 1', params: [product.id, JSON.stringify(keep)],
  })
  // Exactly one default variant: the first kept one.
  q.update('product_variants', { is_default: false }, { sql: 'product_id = ? AND id <> ? AND is_default = 1', params: [product.id, keep[0]] })
  q.update('product_variants', { is_default: true }, { sql: 'id = ? AND is_default = 0', params: [keep[0]] })
  return q.byKey<Product>('products', [product.id])!
}

/** public.admin_save_product_full */
function saveProductFull(env: WriteEnv, p: Json): Product {
  const q = asOwner(env)
  env.ctx.requirePermission('products.manage')
  const product = saveProduct(env, p)
  const wanted = textArray(p.extra_category_ids ?? [])
  const cats = wanted.length
    ? q.raw('SELECT DISTINCT id FROM categories WHERE id IN (SELECT value FROM json_each(?)) AND id IS NOT ?', [JSON.stringify(wanted), product.category_id])
      .map((r) => String(r.id))
    : []
  const clean = (v: unknown) => (text(v) ?? '').trim() || null
  q.update('products', {
    short_description: clean(p.short_description), shipping_note: clean(p.shipping_note), warranty: clean(p.warranty),
    admin_note: clean(p.admin_note), extra_category_ids: cats,
  }, { keys: [[product.id]] })
  return q.byKey<Product>('products', [product.id])!
}

/** public.admin_product_quick_update */
function quickUpdate(env: WriteEnv, id: string, p: Json): Json {
  const q = asOwner(env)
  env.ctx.requirePermission('products.manage')
  const row = q.one<Values>('SELECT * FROM products WHERE id = ?', [id], 'products')
  if (!row) return raise('NOT_FOUND: product not found', 'P0002')
  const has = (k: string) => Object.hasOwn(p, k)
  const cost = has('cost_price') ? numeric(p.cost_price) : null
  const price = has('price') ? numeric(p.price) : null
  if (has('cost_price') && (cost === null || cost < 0)) raise('VALIDATION: cost price must be zero or more', '22023')
  if (has('price') && (price === null || price < 0)) raise('VALIDATION: selling price must be zero or more', '22023')
  const single = Number(q.value('SELECT count(*) FROM product_variants WHERE product_id = ? AND is_active = 1', [id])) === 1
  const set: Values = {}
  if (has('cost_price')) set.cost_price = cost
  if (has('price')) set.price = price
  if (has('active')) {
    set.status = bool(p.active) ? 'ACTIVE' : row.status === 'ACTIVE' ? 'ARCHIVED' : row.status
  }
  if (has('track_inventory')) set.track_inventory = bool(p.track_inventory)
  q.update('products', set, { keys: [[id]] })
  if (single) {
    const vset: Values = {}
    if (has('cost_price')) vset.cost_price = null
    if (has('price')) vset.price = null
    if (Object.keys(vset).length) q.update('product_variants', vset, { sql: 'product_id = ? AND is_active = 1', params: [id] })
  }
  const after = q.byKey<Values>('products', [id])!
  return { id: after.id, cost_price: after.cost_price, price: after.price, status: after.status, track_inventory: after.track_inventory }
}

/** public.admin_products_bulk_update */
function bulkUpdate(env: WriteEnv, ids: string[] | null, p: Json | null): Json {
  const q = asOwner(env)
  env.ctx.requirePermission('products.manage')
  const changes = p ?? {}
  const { category_id: _category, ...quick } = changes
  if (!ids?.length) raise('VALIDATION: choose at least one product', '22023')
  if (ids!.length > 500) raise('VALIDATION: edit at most 500 products at a time', '22023')
  const hasCategory = Object.hasOwn(changes, 'category_id')
  const category = hasCategory ? uuid(nonEmpty(changes.category_id)) : null
  if (hasCategory && category !== null && !q.exists('SELECT 1 FROM categories WHERE id = ?', [category])) raise('VALIDATION: category not found', '22023')
  let n = 0
  for (const id of ids!) {
    if (!q.exists('SELECT 1 FROM products WHERE id = ?', [id])) raise('NOT_FOUND: product not found', 'P0002')
    if (Object.keys(quick).length) quickUpdate(env, id, quick)
    if (hasCategory) q.update('products', { category_id: category }, { keys: [[id]] })
    n++
  }
  logAudit(q.env, 'products.bulk_update', 'product', null, null, { ids, changes: p })
  return { updated: n }
}

/** public.admin_reorder_product_images */
function reorderImages(env: WriteEnv, productId: string, imageIds: string[], primaryId: string | null): null {
  const q = asOwner(env)
  env.ctx.requirePermission('products.manage')
  const own = new Set(q.raw('SELECT id FROM product_images WHERE product_id = ?', [productId]).map((r) => String(r.id)))
  if (imageIds.some((i) => !own.has(i))) raise('VALIDATION: image does not belong to this product', '22023')
  const primary = primaryId ?? imageIds[0] ?? null
  q.update('product_images', { is_primary: false }, { sql: 'product_id = ? AND is_primary = 1', params: [productId] })
  imageIds.forEach((imageId, i) => {
    q.update('product_images', { position: i, is_primary: imageId === primary }, { sql: 'id = ? AND product_id = ?', params: [imageId, productId] })
  })
  return null
}

/** public.admin_product_stats */
function productStats(env: WriteEnv): Json {
  const q = asOwner(env)
  env.ctx.requirePermission('products.view')
  const threshold = settingNumeric(q, 'inventory', ['low_stock_threshold'], 5)
  const one = (sql: string, params: Array<string | number | null> = []) => Number(q.value(sql, params) ?? 0)
  const tracked = `SELECT p.status, max(coalesce(i.on_hand, 0), 0) AS qty, coalesce(v.price, p.price) AS price,
      coalesce(v.cost_price, p.cost_price, 0) AS cost
    FROM products p JOIN product_variants v ON v.product_id = p.id AND v.is_active = 1
    LEFT JOIN inventory i ON i.variant_id = v.id WHERE p.track_inventory = 1`
  return {
    products: one("SELECT count(*) FROM products WHERE status <> 'ARCHIVED'"),
    active: one("SELECT count(*) FROM products WHERE status = 'ACTIVE'"),
    inactive: one("SELECT count(*) FROM products WHERE status <> 'ACTIVE'"),
    variants: one("SELECT count(*) FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.is_active = 1 AND p.status <> 'ARCHIVED'"),
    stock: one(`SELECT coalesce(sum(qty), 0) FROM (${tracked}) WHERE status <> 'ARCHIVED'`),
    sell_value: one(`SELECT coalesce(total(qty * price), 0) FROM (${tracked}) WHERE status <> 'ARCHIVED'`),
    cost_value: one(`SELECT coalesce(total(qty * cost), 0) FROM (${tracked}) WHERE status <> 'ARCHIVED'`),
    low_stock: one(`SELECT count(*) FROM products p WHERE p.status = 'ACTIVE' AND p.track_inventory = 1
      AND coalesce((SELECT sum(i.available) FROM product_variants v JOIN inventory i ON i.variant_id = v.id
                    WHERE v.product_id = p.id AND v.is_active = 1), 0) <= coalesce(p.low_stock_threshold, ?)`, [threshold]),
  }
}

// ---------------------------------------------------------------- insights

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d
const daysAgo = (now: string, days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString()

/** public.inventory_insights: sales speed, cover, reorder suggestions, ABC class and dead stock per variant. */
function inventoryInsights(env: WriteEnv, leadDays: number | null, coverDays: number | null, deadDays: number | null): Json {
  const q = asOwner(env)
  env.ctx.requirePermission('inventory.view')
  const clamp = (v: number | null, d: number, lo: number, hi: number) => Math.min(Math.max(v ?? d, lo), hi)
  const lead = clamp(leadDays, 7, 0, 120)
  const cover = clamp(coverDays, 30, 1, 365)
  const dead = clamp(deadDays, 60, 7, 730)
  const now = q.now
  const rows = q.raw(`
    WITH sold AS (
      SELECT i.variant_id,
        coalesce(sum(i.quantity - i.returned_quantity) FILTER (WHERE o.confirmed_at >= ?), 0) AS sold_7,
        coalesce(sum(i.quantity - i.returned_quantity) FILTER (WHERE o.confirmed_at >= ?), 0) AS sold_30,
        coalesce(sum(i.quantity - i.returned_quantity), 0) AS sold_90,
        coalesce(total(i.line_subtotal), 0) AS revenue_90
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.confirmed_at >= ? AND o.merged_into IS NULL AND o.status NOT IN ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')
      GROUP BY i.variant_id
    ), last_sale AS (
      SELECT i.variant_id, max(o.confirmed_at) AS last_sale_at
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.confirmed_at IS NOT NULL AND o.status NOT IN ('CANCELLED', 'REJECTED_FRAUD')
      GROUP BY i.variant_id
    ), first_in AS (
      SELECT variant_id, min(created_at) AS first_in_at FROM inventory_movements WHERE on_hand_change > 0 GROUP BY variant_id
    ), incoming AS (
      SELECT pi.variant_id, sum(max(pi.quantity - pi.received_quantity, 0)) AS qty, min(po.expected_date) AS expected
      FROM purchase_order_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id
      WHERE po.status IN ('ORDERED', 'PARTIALLY_RECEIVED') GROUP BY pi.variant_id
    )
    SELECT io.variant_id, io.product_id, io.product_name, io.variant_title, io.sku, io.category_name,
      (SELECT pim.url FROM product_images pim WHERE pim.product_id = io.product_id ORDER BY pim.is_primary DESC, pim.position LIMIT 1) AS image_url,
      io.on_hand, io.reserved, io.available, io.damaged, io.unit_cost, io.unit_price, io.stock_value, io.low_stock_threshold, io.stock_status,
      coalesce(s.sold_7, 0) AS sold_7, coalesce(s.sold_30, 0) AS sold_30, coalesce(s.sold_90, 0) AS sold_90,
      coalesce(s.revenue_90, 0) AS revenue_90, ls.last_sale_at, fi.first_in_at,
      coalesce(inc.qty, 0) AS incoming, inc.expected AS incoming_expected
    FROM inventory_overview io
    LEFT JOIN sold s ON s.variant_id = io.variant_id
    LEFT JOIN last_sale ls ON ls.variant_id = io.variant_id
    LEFT JOIN first_in fi ON fi.variant_id = io.variant_id
    LEFT JOIN incoming inc ON inc.variant_id = io.variant_id
    WHERE io.track_inventory = 1 AND io.variant_active = 1 AND io.product_status <> 'ARCHIVED'`,
  [daysAgo(now, 7), daysAgo(now, 30), daysAgo(now, 90)])

  const base = rows.map((r) => {
    const num = (k: string) => Number(r[k] ?? 0)
    const daily = round((num('sold_7') / 7) * 0.4 + (num('sold_30') / 30) * 0.4 + (num('sold_90') / 90) * 0.2, 3)
    return { r, daily, revenue: num('revenue_90') }
  })
  // ABC: share of the 90-day revenue, best sellers first.
  const totalRevenue = base.reduce((s, b) => s + b.revenue, 0)
  const ranked = [...base].sort((a, b) => b.revenue - a.revenue || String(a.r.variant_id).localeCompare(String(b.r.variant_id)))
  const abc = new Map<unknown, string | null>()
  let before = 0
  for (const b of ranked) {
    if (b.revenue <= 0 || totalRevenue <= 0) {
      abc.set(b.r.variant_id, null)
      continue
    }
    const share = before / totalRevenue
    abc.set(b.r.variant_id, share < 0.8 ? 'A' : share < 0.95 ? 'B' : 'C')
    before += b.revenue
  }
  const deadBefore = daysAgo(now, dead)
  const items = base.map(({ r, daily, revenue }) => {
    const available = Number(r.available)
    const coverDaysLeft = daily > 0 ? round(Math.max(available, 0) / daily, 1) : null
    const suggest = daily > 0 ? Math.max(Math.ceil(daily * (lead + cover)) - Math.max(available, 0) - Number(r.incoming), 0) : null
    const isDead = Number(r.on_hand) > 0 && String(r.last_sale_at ?? r.first_in_at ?? now) < deadBefore
    const status = available <= 0 ? 'OUT'
      : coverDaysLeft !== null && coverDaysLeft < lead ? 'CRITICAL'
        : r.stock_status === 'LOW_STOCK' || (coverDaysLeft !== null && coverDaysLeft < lead + 7) ? 'LOW'
          : isDead ? 'DEAD' : 'OK'
    return {
      variant_id: r.variant_id, product_id: r.product_id, product_name: r.product_name, variant_title: r.variant_title, sku: r.sku,
      category: r.category_name, image_url: r.image_url, on_hand: r.on_hand, reserved: r.reserved, available: r.available,
      unit_cost: r.unit_cost, unit_price: r.unit_price, stock_value: r.stock_value, low_stock_threshold: r.low_stock_threshold,
      sold_7: r.sold_7, sold_30: r.sold_30, sold_90: r.sold_90, revenue_90: revenue, daily,
      last_sale_at: r.last_sale_at ?? null, incoming: r.incoming, incoming_expected: r.incoming_expected ?? null,
      cover_days: coverDaysLeft, suggest, abc: abc.get(r.variant_id) ?? null, dead: isDead, status,
    }
  }).sort((a, b) => b.revenue_90 - a.revenue_90 || String(a.product_name).localeCompare(String(b.product_name)))
  return { lead_days: lead, cover_days: cover, dead_days: dead, generated_at: now, items }
}

// ---------------------------------------------------------------- registry

const ids = (v: unknown) => (v as string[] | null) ?? null

export const catalog: Record<string, RpcImpl> = {
  slugify: ({ args }) => slugify(args.p_text as string | null),
  variant_cost: ({ env, args }) => variantCost(asOwner(env), args.p_variant_id as string),
  allow_overselling: ({ env }) => allowOverselling(asOwner(env)),
  setting_bool: ({ env, args }) => settingBool(asOwner(env), String(args.p_key), (args.p_path as string[]) ?? [], args.p_default as boolean),
  setting_numeric: ({ env, args }) => settingNumeric(asOwner(env), String(args.p_key), (args.p_path as string[]) ?? [], args.p_default as number),
  merchant_limits: ({ env, args }) => merchantLimits(env, (args.p_merchant as string | undefined) ?? env.ctx.merchantId()),
  merchant_usage: ({ env, args }) => merchantUsage(env, (args.p_merchant as string | undefined) ?? env.ctx.merchantId()),
  require_limit: ({ env, args }) => {
    requireLimit(env, String(args.p_key))
    return null
  },
  adjust_stock: ({ env, args }) => adjustStock(env, args.p_variant_id as string, String(args.p_type), args.p_quantity as number | null,
    args.p_note as string | null, (args.p_mode as string | undefined) ?? 'ADD', (args.p_unit_cost as number | undefined) ?? null),
  inventory_bulk_adjust: ({ env, args }) => inventoryBulkAdjust(env, args.p_items, args.p_note as string | null),
  inventory_insights: ({ env, args }) => inventoryInsights(env, (args.p_lead_days as number | undefined) ?? 7,
    (args.p_cover_days as number | undefined) ?? 30, (args.p_dead_days as number | undefined) ?? 60),
  admin_save_product: ({ env, args }) => saveProduct(env, (args.p_payload ?? {}) as Json),
  admin_save_product_full: ({ env, args }) => saveProductFull(env, (args.p_payload ?? {}) as Json),
  admin_product_quick_update: ({ env, args }) => quickUpdate(env, args.p_id as string, (args.p ?? {}) as Json),
  admin_products_bulk_update: ({ env, args }) => bulkUpdate(env, ids(args.p_ids), (args.p ?? null) as Json | null),
  admin_reorder_product_images: ({ env, args }) => reorderImages(env, args.p_product_id as string, ids(args.p_image_ids) ?? [], (args.p_primary_id as string | undefined) ?? null),
  admin_product_stats: ({ env }) => productStats(env),
}

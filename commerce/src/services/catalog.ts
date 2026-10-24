import { env } from '@/lib/env'
import { deleteFile, isR2Path, uploadFile } from '@/lib/files'
import { asJson } from '@/lib/json'
import { merchantFolder } from '@/lib/merchant'
import { supabase } from '@/lib/supabase'
import type { Enums, TablesInsert, TablesUpdate } from '@/types/database'

export interface AdminProductFilters {
  q?: string
  status?: Enums<'product_status'> | ''
  statuses?: Enums<'product_status'>[]
  categoryId?: string
  sort?: 'newest' | 'oldest' | 'name' | 'price_desc' | 'price_asc' | 'cost_desc'
  page: number
  pageSize: number
}

export async function listAdminProducts(f: AdminProductFilters) {
  let query = supabase
    .from('products')
    .select('id, name, slug, sku, status, price, compare_at_price, cost_price, is_featured, requires_production, track_inventory, low_stock_threshold, description, short_description, extra_category_ids, created_at, categories(name), product_variants(id, sku, title, is_active, inventory(on_hand, reserved, available)), product_images(url, is_primary, position)', { count: 'exact' })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  const [col, asc] = ({ newest: ['created_at', false], oldest: ['created_at', true], name: ['name', true], price_desc: ['price', false], price_asc: ['price', true], cost_desc: ['cost_price', false] } as const)[f.sort ?? 'newest']
  query = query.order(col, { ascending: asc }).order('name').order('id')
  if (f.statuses?.length) query = query.in('status', f.statuses)
  if (f.q) query = query.or(`name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,sku.ilike.%${f.q.replace(/[%,()]/g, ' ')}%`)
  if (f.status) query = query.eq('status', f.status)
  if (f.categoryId) query = query.or(`category_id.eq.${f.categoryId},extra_category_ids.cs.{${f.categoryId}}`)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type AdminProductRow = Awaited<ReturnType<typeof listAdminProducts>>['items'][number]

export async function getAdminProduct(id: string) {
  const { data, error } = await supabase
    .from('products')
    .select('*, product_variants(*, inventory(on_hand, reserved, available, damaged)), product_images(*)')
    .eq('id', id)
    .order('position', { referencedTable: 'product_variants' })
    .order('position', { referencedTable: 'product_images' })
    .maybeSingle()
  if (error) throw error
  return data
}
export type AdminProduct = NonNullable<Awaited<ReturnType<typeof getAdminProduct>>>

export interface ProductPayload {
  id?: string
  name: string
  slug?: string
  sku?: string | null
  description?: string | null
  category_id?: string | null
  brand?: string | null
  tags: string[]
  status: Enums<'product_status'>
  option_names: string[]
  cost_price: number
  price: number
  compare_at_price?: number | null
  weight_grams?: number | null
  low_stock_threshold?: number | null
  track_inventory: boolean
  requires_production: boolean
  is_featured: boolean
  seo_title?: string | null
  seo_description?: string | null
  short_description?: string | null
  extra_category_ids?: string[]
  shipping_note?: string | null
  warranty?: string | null
  admin_note?: string | null
  variants: Array<{
    id?: string
    sku: string
    title: string
    size?: string | null
    color?: string | null
    option_values?: Record<string, string>
    price?: number | null
    compare_at_price?: number | null
    cost_price?: number | null
    weight_grams?: number | null
    barcode?: string | null
    is_active?: boolean
    initial_stock?: number
  }>
}

export async function saveProduct(payload: ProductPayload) {
  const { data, error } = await supabase.rpc('admin_save_product_full', { p_payload: asJson(payload) })
  if (error) throw error
  return data
}

/** One-field edits from the product list (server checks products.manage). */
export async function quickUpdateProduct(id: string, changes: { cost_price?: number; price?: number; active?: boolean; track_inventory?: boolean }) {
  const { data, error } = await supabase.rpc('admin_product_quick_update', { p_id: id, p: asJson(changes) })
  if (error) throw error
  return data as unknown as { id: string; cost_price: number; price: number; status: Enums<'product_status'>; track_inventory: boolean }
}

/** Same change for many products at once (all or nothing; server checks products.manage). */
export async function bulkUpdateProducts(ids: string[], changes: { price?: number; cost_price?: number; active?: boolean; track_inventory?: boolean; category_id?: string | null }) {
  const { data, error } = await supabase.rpc('admin_products_bulk_update', { p_ids: ids, p: asJson(changes) })
  if (error) throw error
  return data as unknown as { updated: number }
}

export interface ProductStats { products: number; active: number; inactive: number; variants: number; stock: number; sell_value: number; cost_value: number; low_stock: number }
export async function productStats(): Promise<ProductStats> {
  const { data, error } = await supabase.rpc('admin_product_stats')
  if (error) throw error
  return data as unknown as ProductStats
}

// Categories ----------------------------------------------------------------
export async function listCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('sort_order').order('name')
  if (error) throw error
  return data ?? []
}

export async function saveCategory(values: TablesInsert<'categories'> & { id?: string }) {
  const { id, ...rest } = values
  const { data, error } = id
    ? await supabase.from('categories').update(rest as TablesUpdate<'categories'>).eq('id', id).select().single()
    : await supabase.from('categories').insert(rest).select().single()
  if (error) throw error
  return data
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw error
}

// Images (product-images: Supabase Storage, or Cloudflare R2 on Cloudflare builds) ----
const BUCKET = 'product-images'

/** Stores an image in the store's folder; returns its stored path and public address. */
async function storeImage(folder: string, file: File): Promise<{ path: string; url: string }> {
  if (env.filesOnR2) {
    const saved = await uploadFile(BUCKET, folder, file)
    return { path: saved.path, url: saved.url! }
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  const path = `${merchantFolder()}/${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { cacheControl: '31536000', contentType: file.type })
  if (error) throw error
  return { path, url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl }
}

async function removeImage(path: string) {
  if (isR2Path(path)) await deleteFile(BUCKET, path)
  else await supabase.storage.from(BUCKET).remove([path])
}

export async function uploadProductImage(productId: string, file: File, position: number, primary: boolean) {
  if (!file.type.startsWith('image/')) throw new Error('VALIDATION: please choose an image file')
  if (file.size > 5 * 1024 * 1024) throw new Error('VALIDATION: images must be smaller than 5 MB')
  const stored = await storeImage(productId, file)
  const { error } = await supabase.from('product_images').insert({
    product_id: productId, storage_path: stored.path, url: stored.url, alt: file.name.replace(/\.[^.]+$/, ''), position, is_primary: primary,
  })
  if (error) {
    await removeImage(stored.path)
    throw error
  }
}

/** Uploads an image for the store theme (hero, banners) and returns its public address. */
export async function uploadThemeImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('VALIDATION: please choose an image file')
  if (file.size > 8 * 1024 * 1024) throw new Error('VALIDATION: images must be smaller than 8 MB')
  return (await storeImage('theme', file)).url
}

/** Adds an image by address (no upload). */
export async function addProductImageUrl(productId: string, url: string, position: number, primary: boolean) {
  const clean = url.trim()
  if (!/^https:\/\/\S+$/i.test(clean)) throw new Error('VALIDATION: image address must start with https://')
  const { error } = await supabase.from('product_images').insert({ product_id: productId, url: clean, position, is_primary: primary, alt: null })
  if (error) throw error
}

export async function deleteProductImage(image: { id: string; storage_path: string | null }) {
  const { error } = await supabase.from('product_images').delete().eq('id', image.id)
  if (error) throw error
  if (image.storage_path) await removeImage(image.storage_path)
}

export async function reorderProductImages(productId: string, ids: string[], primaryId?: string) {
  const { error } = await supabase.rpc('admin_reorder_product_images', { p_product_id: productId, p_image_ids: ids, p_primary_id: primaryId })
  if (error) throw error
}

/** Thumbnail URL via Supabase image transformations when available. */
export function imageUrl(url: string | null | undefined, width = 400): string | undefined {
  if (!url) return undefined
  if (url.includes('/storage/v1/object/public/')) {
    return `${url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')}?width=${width}&resize=contain&quality=75`
  }
  return url
}

// Variant search for orders and purchase orders --------------------------------
/** A variant to put on an order (order_catalog): the cost only for staff who may see costs, the
 *  stock count only for staff who may see stock; everyone gets whether it is in stock. */
export interface VariantSearchRow {
  variant_id: string
  product_id: string
  product_name: string
  product_slug: string
  product_status: string
  variant_title: string | null
  sku: string
  variant_active: boolean
  track_inventory: boolean
  unit_price: number | null
  unit_cost: number | null
  available: number | null
  in_stock: boolean
  image_url: string | null
}

export async function searchVariants(q: string, limit = 12): Promise<VariantSearchRow[]> {
  const { data, error } = await supabase.rpc('order_catalog', { p_search: q.trim() || undefined, p_limit: limit })
  if (error) throw error
  return (data ?? []) as unknown as VariantSearchRow[]
}

export async function variantsByIds(ids: string[]): Promise<VariantSearchRow[]> {
  if (!ids.length) return []
  const { data, error } = await supabase.rpc('order_catalog', { p_variant_ids: ids })
  if (error) throw error
  return (data ?? []) as unknown as VariantSearchRow[]
}

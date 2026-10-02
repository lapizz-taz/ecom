import { asJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums, TablesInsert, TablesUpdate } from '@/types/database'

export interface AdminProductFilters {
  q?: string
  status?: Enums<'product_status'> | ''
  categoryId?: string
  page: number
  pageSize: number
}

export async function listAdminProducts(f: AdminProductFilters) {
  let query = supabase
    .from('products')
    .select('id, name, slug, sku, status, price, compare_at_price, cost_price, is_featured, requires_production, track_inventory, created_at, categories(name), product_variants(id, sku, is_active, inventory(on_hand, reserved, available)), product_images(url, is_primary, position)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.q) query = query.or(`name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,sku.ilike.%${f.q.replace(/[%,()]/g, ' ')}%`)
  if (f.status) query = query.eq('status', f.status)
  if (f.categoryId) query = query.eq('category_id', f.categoryId)
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
  const { data, error } = await supabase.rpc('admin_save_product', { p_payload: asJson(payload) })
  if (error) throw error
  return data
}

export async function setProductStatus(id: string, status: Enums<'product_status'>) {
  const { error } = await supabase.from('products').update({ status }).eq('id', id)
  if (error) throw error
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw error
}

// Categories ----------------------------------------------------------------
export async function listCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('sort_order').order('name')
  if (error) throw error
  return data ?? []
}

export async function saveCategory(values: TablesInsert<'categories'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id
    ? await supabase.from('categories').update(rest as TablesUpdate<'categories'>).eq('id', id)
    : await supabase.from('categories').insert(rest)
  if (error) throw error
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw error
}

// Images (Supabase Storage: product-images bucket) ------------------------------
const BUCKET = 'product-images'

export async function uploadProductImage(productId: string, file: File, position: number, primary: boolean) {
  if (!file.type.startsWith('image/')) throw new Error('VALIDATION: please choose an image file')
  if (file.size > 5 * 1024 * 1024) throw new Error('VALIDATION: images must be smaller than 5 MB')
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  const path = `${productId}/${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { cacheControl: '31536000', contentType: file.type })
  if (uploadError) throw uploadError
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
  const { error } = await supabase.from('product_images').insert({
    product_id: productId, storage_path: path, url: pub.publicUrl, alt: file.name.replace(/\.[^.]+$/, ''), position, is_primary: primary,
  })
  if (error) {
    await supabase.storage.from(BUCKET).remove([path])
    throw error
  }
}

export async function deleteProductImage(image: { id: string; storage_path: string | null }) {
  const { error } = await supabase.from('product_images').delete().eq('id', image.id)
  if (error) throw error
  if (image.storage_path) await supabase.storage.from(BUCKET).remove([image.storage_path])
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
export async function searchVariants(q: string, limit = 12) {
  const term = q.replace(/[%,()]/g, ' ').trim()
  let query = supabase
    .from('inventory_overview')
    .select('variant_id, product_id, product_name, variant_title, sku, unit_price, unit_cost, available, track_inventory, product_status, variant_active')
    .eq('variant_active', true)
    .order('product_name')
    .limit(limit)
  if (term) query = query.or(`product_name.ilike.%${term}%,sku.ilike.%${term}%`)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type VariantSearchRow = Awaited<ReturnType<typeof searchVariants>>[number]

export async function variantsByIds(ids: string[]): Promise<VariantSearchRow[]> {
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('inventory_overview')
    .select('variant_id, product_id, product_name, variant_title, sku, unit_price, unit_cost, available, track_inventory, product_status, variant_active')
    .in('variant_id', ids)
  if (error) throw error
  return data ?? []
}

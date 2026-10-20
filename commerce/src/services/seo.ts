import { supabase } from '@/lib/supabase'

// The store's SEO (supabase/migrations/20261121002000_store_seo.sql): settings and modes, one
// item's SEO for its editor panel, bulk changes, redirects and the audit. Every call is checked
// on the server (staff of this store; settings.manage / products.manage to change things).

export type SeoMode = 'automatic' | 'manual' | 'hybrid'
export type SeoItemType = 'product' | 'collection' | 'page'
/** Where a shown value came from: written by the merchant, stored from generation, worked out now, or none. */
export type SeoSource = 'manual' | 'generated' | 'auto' | 'missing'

export interface SeoSettings {
  mode: SeoMode
  generate: { title: boolean; description: boolean; alt_text: boolean }
  templates: Record<'product_title' | 'product_description' | 'collection_title' | 'collection_description'
    | 'page_title' | 'page_description' | 'home_title' | 'home_description', string>
  title_suffix: string
  social: { og_image: string; twitter_site: string }
  structured_data: { product: boolean; breadcrumbs: boolean; organization: boolean; website: boolean }
  sitemap: { enabled: boolean; products: boolean; collections: boolean; pages: boolean }
  indexing: { store: boolean; products: boolean; collections: boolean; pages: boolean; search: boolean }
  new_items: { products: 'auto' | 'fill'; collections: 'auto' | 'fill' }
  ai: { enabled: boolean }
}

export interface SeoSettingsState {
  settings: SeoSettings
  saved: Partial<SeoSettings> | null
  saved_at: string | null
  base_url: string | null
  store: Record<string, string | null>
  template_vars: string[]
  counts: { products: number; collections: number; pages: number; manual_titles: number }
  /** No AI provider is connected to the platform yet. */
  ai_available: boolean
}

export interface SeoImage { id: string; url: string; alt: string | null; suggested_alt: string | null }

export interface SeoItem {
  type: SeoItemType
  key: string
  name: string
  path: string
  slug: string | null
  active: boolean
  title: string
  description: string | null
  title_source: SeoSource
  description_source: SeoSource
  auto_title: string | null
  auto_description: string | null
  stored_title: string | null
  stored_description: string | null
  sources: Record<string, string>
  canonical_url: string | null
  custom_canonical: string | null
  noindex: boolean
  robots: string
  focus_keyword: string | null
  og_image: string | null
  custom_og_image: string | null
  image: string | null
  updated_at: string | null
  mode: SeoMode
  base_url: string | null
  images: SeoImage[] | null
}

export interface SeoItemChanges {
  title?: string | null
  description?: string | null
  slug?: string
  canonical_url?: string | null
  noindex?: boolean
  focus_keyword?: string | null
  og_image?: string | null
  image_alts?: Array<{ id: string; alt: string | null }>
}

export type SeoSeverity = 'error' | 'warning' | 'info'

export interface SeoIssue {
  severity: SeoSeverity
  code: string
  type: SeoItemType | 'theme' | 'store'
  key: string
  name: string
  path: string
  field: string | null
  message: string
}

export interface SeoAudit {
  checked_at: string
  mode: SeoMode
  base_url: string | null
  health: { checks: number; failed: number; score: number; errors: number; warnings: number; notes: number }
  counts: { products: number; collections: number; pages: number; indexable: number }
  technical: {
    sitemap: { enabled: boolean; url: string | null; urls: number }
    robots: { url: string | null; store_indexable: boolean }
    structured_data: SeoSettings['structured_data']
  }
  external: string[]
  issues: SeoIssue[]
  items: SeoAuditItem[]
}

/** One public item as the audit checked it. */
export interface SeoAuditItem {
  type: SeoItemType
  key: string
  name: string
  path: string
  title: string
  description: string | null
  title_source: SeoSource
  description_source: SeoSource
  robots: string
  noindex: boolean
  focus_keyword: string | null
}

export interface SeoRedirect { id: string; from_path: string; to_path: string; source: string; created_at: string }

export type SeoBulkAction = 'generate' | 'reset' | 'alt_text' | 'index'

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) throw error
  return data as unknown as T
}

/** What a store page puts in its head (the store's own pages; anyone may ask). */
export interface PageSeo {
  status: number
  redirect?: string
  path?: string
  type?: string
  lang?: string
  title?: string | null
  description?: string | null
  canonical?: string | null
  robots?: string | null
  og?: Record<string, string>
  twitter?: Record<string, string>
  jsonld?: unknown[]
}

export const getPageSeo = (path: string) => call<PageSeo>('storefront_seo', { p_path: path })
export const getSeoSettings = () => call<SeoSettingsState>('seo_settings_get')
export const saveSeoSettings = (value: Partial<SeoSettings>) => call<SeoSettings>('seo_settings_save', { p_value: value })
export const getSeoItem = (type: SeoItemType, key: string) => call<SeoItem>('seo_item_get', { p_type: type, p_key: key })
export const saveSeoItem = (type: SeoItemType, key: string, value: SeoItemChanges) =>
  call<SeoItem>('seo_item_save', { p_type: type, p_key: key, p_value: value })
/** items null: every product, collection and page. */
export const runSeoBulk = (action: SeoBulkAction, items: Array<{ type: SeoItemType; key: string }> | null, includeManual = false) =>
  call<{ action: SeoBulkAction; changed: number; skipped_manual: number }>('seo_bulk', { p_action: action, p_items: items, p_include_manual: includeManual })
export const getSeoAudit = () => call<SeoAudit>('seo_audit')
export const listSeoRedirects = () => call<SeoRedirect[]>('seo_redirects_list')
export const saveSeoRedirect = (from: string, to: string) => call<SeoRedirect[]>('seo_redirect_save', { p_from: from, p_to: to })
export const deleteSeoRedirect = (id: string) => call<SeoRedirect[]>('seo_redirect_delete', { p_id: id })

/** The modes, as the settings page and the panels explain them. */
export const SEO_MODES: Record<SeoMode, { label: string; summary: string; detail: string }> = {
  automatic: {
    label: 'Automatic',
    summary: 'Fullfilio writes every title and description from your templates.',
    detail: 'Titles and descriptions follow your products, collections and pages as they change. Anything written by hand is kept but not shown while this mode is on.',
  },
  manual: {
    label: 'Manual',
    summary: 'Only what you write is used.',
    detail: 'Nothing is generated. A page without a written title uses its name; a page without a written description has none, and the audit lists it.',
  },
  hybrid: {
    label: 'Hybrid',
    summary: 'Generated by default; anything you write is kept as written.',
    detail: 'Each field is generated until you write it. Written fields are locked: bulk generation and imports never change them, and “Reset to automatic” hands a field back.',
  },
}

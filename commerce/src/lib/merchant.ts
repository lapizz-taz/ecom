// Which business (merchant) this browser is talking to.
//
// Staff: the database knows their merchant from their account, so the header
// below is ignored for them; we keep it only to name upload folders.
// Storefront visitors and customers: the store is chosen by the web address
// (a merchant's own domain, or the platform's default store) and sent with
// every request as x-merchant-id, which the database uses to scope the store.

/**
 * What this web address shows (from storefront_resolve):
 * - store: a business's store (its own domain, <name>.<root domain>, or
 *   <platform address>/s/<name>);
 * - platform: the Fullfilio website itself (marketing, sign-in, sign-up);
 * - missing: a store address that does not exist or whose store is off.
 */
export interface SiteInfo {
  kind: 'store' | 'platform' | 'missing'
  merchant_id?: string | null
  name?: string
  status?: string
  slug?: string | null
  /** This address is not the store's primary domain: send visitors there. */
  redirect_to?: string | null
}

/** A store opened by path on the platform address: /s/<store name>/… */
const STORE_PATH = /^\/s\/([a-z0-9][a-z0-9-]{1,40})(?=\/|$)/

/** The store name in the address, when the store is opened by path. */
function storeSlugInPath(pathname = typeof location === 'undefined' ? '' : location.pathname): string | null {
  return STORE_PATH.exec(pathname)?.[1] ?? null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cacheKey = () => (typeof location === 'undefined' ? 'site:v2' : `site:v2:${location.host}:${storeSlugInPath() ?? ''}`)

/**
 * True inside the theme editor's preview frame: a frame on this site opened
 * with ?theme_preview=1 (kept for the pages the frame moves to). The frame
 * shows the signed-in staff's own store, so it never uses or fills the
 * remembered answer for this address.
 */
export function isPreviewFrame(): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  try {
    return new URLSearchParams(window.location.search).has('theme_preview') || !!sessionStorage.getItem('theme_preview')
  } catch {
    return false
  }
}

function readCache(): SiteInfo | null {
  if (isPreviewFrame()) return null
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey()) ?? 'null') as SiteInfo | null
    if (!value || !['store', 'platform', 'missing'].includes(value.kind)) return null
    if (value.kind === 'store' && !(value.merchant_id && UUID.test(value.merchant_id))) return null
    return value
  } catch {
    return null
  }
}

function writeCache(site: SiteInfo) {
  if (isPreviewFrame()) return
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ kind: site.kind, merchant_id: site.merchant_id ?? null, name: site.name, slug: site.slug ?? null }))
  } catch {
    // Private mode: the address is resolved again on the next visit.
  }
}

let site: SiteInfo | null = readCache()

/** What this address shows (the remembered answer until the lookup returns). */
export function currentSite(): SiteInfo {
  return site ?? { kind: 'platform' }
}

/** The router's base path: "/s/<name>" for a store opened by path, else "". */
export function storeBasename(): string {
  const slug = storeSlugInPath()
  return slug ? `/s/${slug}` : ''
}

let storefrontMerchantId: string | null = site?.kind === 'store' ? site.merchant_id ?? null : null
let staffMerchantId: string | null = null

/** The merchant for requests from this browser (staff merchant first). */
export function currentMerchantId(): string | null {
  return staffMerchantId ?? storefrontMerchantId
}

/** The signed-in staff member's merchant (from get_my_access), or null when signed out. */
export function setStaffMerchant(id: string | null) {
  staffMerchantId = id && UUID.test(id) ? id : null
}

/** Folder that holds this merchant's files in storage ("<merchant id>/..."). */
export function merchantFolder(): string {
  const id = staffMerchantId
  if (!id) throw new Error('PERMISSION_DENIED: sign in again before uploading files')
  return id
}

/** fetch() that names the merchant on every request to the API. */
export const merchantFetch: typeof fetch = (input, init) => {
  const id = currentMerchantId()
  if (!id) return fetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!headers.has('x-merchant-id')) headers.set('x-merchant-id', id)
  return fetch(input, { ...init, headers })
}

let resolving: Promise<SiteInfo> | null = null

/**
 * Asks what this web address shows. Uses the remembered answer straight away
 * when there is one and refreshes it in the background; if the answer changed
 * (a store was moved or switched off), the page reloads once with the new one.
 * The theme editor's preview frame asks for the staff's own store instead.
 */
export function resolveSite(lookup: (host: string, slug: string | null, preview: boolean) => Promise<SiteInfo | null>): Promise<SiteInfo> {
  const remembered = site
  resolving ??= lookup(location.host, storeSlugInPath(), isPreviewFrame()).then((found) => {
    const next: SiteInfo = found && found.kind ? found : found?.merchant_id ? { ...found, kind: 'store' } : { kind: 'platform' }
    if (next.kind === 'store' && !(next.merchant_id && UUID.test(next.merchant_id))) next.kind = 'missing'
    site = next
    storefrontMerchantId = next.kind === 'store' ? next.merchant_id! : null
    writeCache(next)
    if (remembered && (remembered.kind !== next.kind || (remembered.merchant_id ?? null) !== (next.merchant_id ?? null))) location.reload()
    return next
  })
  return resolving
}

/** True when an earlier visit already told us what this address shows (no need to wait). */
export function hasRememberedSite(): boolean {
  return site !== null
}

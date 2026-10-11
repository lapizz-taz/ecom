// Which business (merchant) this browser is talking to.
//
// Staff: the database knows their merchant from their account, so the header
// below is ignored for them; we keep it only to name upload folders.
// Storefront visitors and customers: the store is chosen by the web address
// (a merchant's own domain, or the platform's default store) and sent with
// every request as x-merchant-id, which the database uses to scope the store.

export interface StorefrontMerchant {
  merchant_id: string
  name: string
  status: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cacheKey = () => `merchant:${typeof location === 'undefined' ? '' : location.host}`

function readCache(): string | null {
  try {
    const value = localStorage.getItem(cacheKey())
    return value && UUID.test(value) ? value : null
  } catch {
    return null
  }
}

function writeCache(id: string | null) {
  try {
    if (id) localStorage.setItem(cacheKey(), id)
    else localStorage.removeItem(cacheKey())
  } catch {
    // Private mode: the store is resolved again on the next visit.
  }
}

let storefrontMerchantId: string | null = readCache()
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

let resolving: Promise<StorefrontMerchant | null> | null = null

/**
 * Asks which store this web address belongs to. Uses the remembered answer
 * straight away when there is one and refreshes it in the background.
 */
export function resolveStorefrontMerchant(
  lookup: (host: string) => Promise<StorefrontMerchant | null>,
): Promise<StorefrontMerchant | null> {
  resolving ??= lookup(location.host).then((found) => {
    const id = found?.merchant_id && UUID.test(found.merchant_id) ? found.merchant_id : null
    storefrontMerchantId = id
    writeCache(id)
    return found
  })
  return resolving
}

/** True when an earlier visit already told us the store (no need to wait). */
export function hasRememberedStorefront(): boolean {
  return storefrontMerchantId !== null
}

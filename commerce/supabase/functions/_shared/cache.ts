// A cache shared by every server instance, for public values that can always
// be fetched again (never secrets, never orders, stock or money). On Cloudflare
// the Worker plugs in Workers KV; elsewhere there is none and callers keep
// their in-memory copy only.

export interface SharedCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
}

let shared: SharedCache | null = null

export function setSharedCache(cache: SharedCache | null): void {
  shared = cache
}

/** Reads a cached value; a cache that fails counts as empty. */
export async function cacheGet(key: string): Promise<string | null> {
  try {
    return shared ? await shared.get(key) : null
  } catch {
    return null
  }
}

/** Stores a value for a while; a cache that fails is ignored. */
export async function cachePut(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    if (shared) await shared.put(key, value, ttlSeconds)
  } catch {
    // The value is fetched again next time.
  }
}

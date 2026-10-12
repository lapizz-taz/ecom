// Retries for READ-ONLY calls to outside services (ad platforms, BD Courier
// lookups): a busy provider (HTTP 429), a passing outage (502/503/504) or a
// dropped connection gets a couple more tries with growing waits, honouring
// Retry-After. The waits are capped so one slow provider never holds a
// request (or the other accounts in a sync) for long.
//
// Never use this for calls that create something (sending an SMS, booking a
// parcel, charging a payment): those are retried by their own queues, which
// know whether the first attempt already went through.

type FetchFn = typeof fetch

export interface RetryOptions {
  /** Tries in total, the first included. */
  attempts?: number
  /** Wait before the second try; doubles each time. */
  baseDelayMs?: number
  /** The longest single wait, Retry-After included. */
  maxDelayMs?: number
  /** Replaced in tests. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const RETRY_STATUS = new Set([429, 502, 503, 504])

/** Seconds or an HTTP date, as servers send it; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** A fetch that tries again on 429/502/503/504 and network errors, then returns the last answer (or throws the last error). */
export function fetchWithRetry(fetchFn: FetchFn = fetch, opts: RetryOptions = {}): FetchFn {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = opts.baseDelayMs ?? 400
  const max = opts.maxDelayMs ?? 4000
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const random = opts.random ?? Math.random
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // A Request body can be read once only: send a fresh copy each time.
        const response = await fetchFn(input instanceof Request ? input.clone() : input, init)
        if (!RETRY_STATUS.has(response.status) || attempt === attempts) return response
        const wait = retryAfterMs(response.headers.get('retry-after'))
        await response.body?.cancel().catch(() => undefined)
        await sleep(Math.min(max, wait ?? base * 2 ** (attempt - 1) * (0.75 + random() / 2)))
      } catch (error) {
        // A timeout we set ourselves is final; anything else (a dropped connection) is tried again.
        if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError' || attempt === attempts) throw error
        lastError = error
        await sleep(Math.min(max, base * 2 ** (attempt - 1) * (0.75 + random() / 2)))
      }
    }
    throw lastError ?? new Error('fetchWithRetry: no attempt made')
  }) as FetchFn
}

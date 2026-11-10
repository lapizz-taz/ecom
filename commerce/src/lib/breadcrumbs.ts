// The last steps before an error: pages opened, buttons pressed, calls to the server with their
// outcome, and error messages shown. Kept in memory only and sent with an error report to the
// Super Admin error tracker, so the cause can be found without asking the person what they did.
// Never recorded: what was typed, query strings, request or response bodies.

export type Crumb =
  | { t: 'nav'; at: number; to: string }
  | { t: 'click'; at: number; label: string }
  | { t: 'call'; at: number; name: string; status: number | 'failed'; ms: number; x?: number; request_id?: string }
  | { t: 'toast'; at: number; text: string }
  | { t: 'error'; at: number; text: string }

type WithoutAt<T> = T extends unknown ? Omit<T, 'at'> : never
type New = WithoutAt<Crumb>

const MAX = 30
const crumbs: Crumb[] = []

/** Phone numbers and other long numbers are not kept in labels. */
export const maskDigits = (s: string) => s.replace(/\d{5,}/g, (d) => '•'.repeat(Math.min(d.length, 11)))

export function crumb(c: New, at = Date.now()) {
  const last = crumbs[crumbs.length - 1]
  // A call repeated with the same outcome (polling) is one line with a count.
  if (c.t === 'call' && last?.t === 'call' && last.name === c.name && last.status === c.status && typeof c.status === 'number' && c.status < 400) {
    last.x = (last.x ?? 1) + 1
    last.at = at
    last.ms = c.ms
    return
  }
  crumbs.push({ ...c, at } as Crumb)
  // Full: a routine successful call goes first, so pages, presses, failures and messages stay longest.
  while (crumbs.length > MAX) {
    const routine = crumbs.findIndex((x) => x.t === 'call' && typeof x.status === 'number' && x.status < 400)
    crumbs.splice(routine >= 0 ? routine : 0, 1)
  }
}

/** The steps so far, oldest first, with clock times (to line up with server errors). */
export function trail(): Array<Record<string, unknown>> {
  return crumbs.map(({ at, ...c }) => ({ ...c, at: new Date(at).toISOString() }))
}

/** The last call that failed within the last few seconds: what a "Something went wrong" was most likely about. */
export function lastFailedCall(withinMs = 15_000): Extract<Crumb, { t: 'call' }> | null {
  const now = Date.now()
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const c = crumbs[i]
    if (now - c.at > withinMs) return null
    if (c.t === 'call' && (c.status === 'failed' || c.status >= 400)) return c
  }
  return null
}

/** Adds the server's request id to the call it belongs to (from a function's error answer). */
export function noteRequestId(name: string, requestId: string) {
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const c = crumbs[i]
    if (c.t === 'call' && c.name.startsWith(name)) { c.request_id = requestId; return }
  }
}

export function clearCrumbs() { crumbs.length = 0 }

/**
 * A short name for an API call: "rpc approve_orders", "read orders", "fn inbox/history_import",
 * "auth token". The action of a backend function is read from its JSON body; nothing else is.
 */
export function callName(url: string, method = 'GET', body?: unknown): string | null {
  let u: URL
  try { u = new URL(url, typeof window === 'undefined' ? 'http://local' : window.location.origin) } catch { return null }
  const p = u.pathname
  let m: RegExpExecArray | null
  if ((m = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/.exec(p))) return `rpc ${m[1]}`
  if ((m = /\/rest\/v1\/([A-Za-z0-9_]+)/.exec(p))) {
    const verb = method === 'GET' || method === 'HEAD' ? 'read' : method === 'POST' ? 'insert' : method === 'PATCH' ? 'update' : method === 'DELETE' ? 'delete' : method.toLowerCase()
    return `${verb} ${m[1]}`
  }
  if ((m = /\/functions\/v1\/([A-Za-z0-9_-]+)/.exec(p))) {
    const action = typeof body === 'string' && body.length < 200_000 ? /"action"\s*:\s*"([A-Za-z0-9_]{1,60})"/.exec(body)?.[1] : undefined
    return `fn ${m[1]}${action ? `/${action}` : ''}`
  }
  if ((m = /\/auth\/v1\/([A-Za-z0-9_-]+)/.exec(p))) return `auth ${m[1]}`
  if (/\/storage\/v1\//.test(p)) return 'storage'
  if (/\/realtime\/v1\//.test(p)) return null
  return null
}

/** fetch() that writes each API call to the trail (name, status, time taken). */
export function trackedFetch(fetchFn: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let name: string | null = null
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    name = callName(url, method, init?.body)
  } catch { name = null }
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const result = fetchFn(input, init)
  if (name) {
    const ms = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
    result.then((res) => crumb({ t: 'call', name: name!, status: res.status, ms: ms() }), () => crumb({ t: 'call', name: name!, status: 'failed', ms: ms() }))
  }
  return result
}

let watching = false

/** Page changes and button presses. Called once when the app starts. */
export function watchSteps() {
  if (watching || typeof window === 'undefined') return
  watching = true
  let lastPath = window.location.pathname
  crumb({ t: 'nav', to: lastPath })
  const onNav = () => {
    const to = window.location.pathname
    if (to !== lastPath) { lastPath = to; crumb({ t: 'nav', to }) }
  }
  for (const k of ['pushState', 'replaceState'] as const) {
    const original = history[k]
    history[k] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = original.apply(this, args)
      try { onNav() } catch { /* never break navigation */ }
      return r
    } as History['pushState']
  }
  window.addEventListener('popstate', onNav)
  document.addEventListener('click', (e) => {
    try {
      const el = (e.target as Element | null)?.closest?.('button, [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"], a[href]')
      if (!el) return
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') ?? ''
        if (href.startsWith('/')) crumb({ t: 'click', label: `link ${href.split(/[?#]/)[0]}` })
        return
      }
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
      if (label) crumb({ t: 'click', label: maskDigits(label.slice(0, 40)) })
    } catch { /* never break a click */ }
  }, { capture: true, passive: true })
}

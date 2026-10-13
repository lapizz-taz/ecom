// SSRF guard for server-side fetches to operator- or merchant-supplied URLs.
//
// Staff can configure where we call out: a payment gateway base URL, a courier
// base URL, a WooCommerce store URL, a PBX click-to-call template. A private or
// loopback target would turn one of those into a request against the platform's
// own network (cloud metadata, internal services). This rejects any address
// that is not a public host before the fetch is built. It does not resolve DNS,
// so a public name that resolves to a private address is out of scope here; the
// edge/worker runtimes do not route to RFC1918 in the first place, and this is a
// bounded, allocation-free check.

/** An IPv4 literal in a private, loopback, link-local, CGNAT or unspecified range. */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true // malformed → treat as unsafe
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||          // link-local (cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) ||          // RFC1918
    (a === 100 && b >= 64 && b <= 127)   // CGNAT (RFC6598)
  )
}

/** A private/loopback/link-local/ULA IP literal (v4 or v6). For guarding a probe
 * against a merchant domain that RESOLVES to an internal address. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '')
  if (!v) return true
  if (!v.includes(':')) return isPrivateV4(v)
  if (v === '::1' || v === '::') return true
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true // fe80::/10
  if (v.startsWith('fc') || v.startsWith('fd')) return true // fc00::/7 (ULA)
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v) // IPv4-mapped
  if (mapped) return isPrivateV4(mapped[1])
  return false
}

/** True only for an http(s) URL whose host is a public name or public IP. */
export function isPublicHttpUrl(raw: string, options: { allowHttp?: boolean } = {}): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) return false
  if (url.username || url.password) return false // no credentials smuggled in the authority
  const host = url.hostname.toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host.startsWith('[')) return false // literal IPv6 (covers ::1, fc00::/7, fe80::/10)
  if (isPrivateV4(host)) return false
  return true
}

/** Throws a VALIDATION HttpError-shaped message when the URL is not a public http(s) address. */
export function assertPublicHttpUrl(raw: string, label = 'address', options: { allowHttp?: boolean } = {}): string {
  if (!isPublicHttpUrl(raw, options)) {
    throw new Error(`The ${label} must be a public ${options.allowHttp ? 'http(s)' : 'https'}:// address (private, loopback and internal hosts are not allowed)`)
  }
  return raw
}

/**
 * A staff-supplied override base URL, checked for SSRF. Empty/absent → undefined
 * (the caller falls back to its platform default); a non-empty value must be a
 * public https host or it is rejected.
 */
export function checkedBaseUrl(raw: string | null | undefined, label: string): string | undefined {
  const v = (raw ?? '').trim()
  if (!v) return undefined
  return assertPublicHttpUrl(v, label)
}

/**
 * fetch() that follows redirects MANUALLY, re-validating each hop's Location with
 * isPublicHttpUrl. Validating only the first URL is not enough: a merchant- or
 * operator-controlled host can answer a 3xx pointing at 169.254.169.254 or an
 * RFC1918 address, and a plain redirect:'follow' would chase it from inside the
 * platform's network (SSRF). The caller validates the initial URL; this guards
 * every subsequent hop. A non-public Location is refused, not followed.
 */
export async function safeFetch(
  input: string,
  init: RequestInit = {},
  options: { allowHttp?: boolean; maxRedirects?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const max = options.maxRedirects ?? 5
  let url = input
  let step = init
  for (let i = 0; i <= max; i++) {
    const res = await doFetch(url, { ...step, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    const next = new URL(loc, url).toString()
    if (!isPublicHttpUrl(next, { allowHttp: options.allowHttp })) {
      throw new Error('The server redirected to a non-public address')
    }
    url = next
    // 303 (and, per the Fetch standard, the common 301/302-on-POST case) switches
    // to GET and drops the body; keep method/body otherwise (307/308 semantics).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && (step.method ?? 'GET').toUpperCase() === 'POST')) {
      step = { ...step, method: 'GET', body: undefined }
    }
  }
  throw new Error('Too many redirects')
}

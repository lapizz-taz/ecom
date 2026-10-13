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

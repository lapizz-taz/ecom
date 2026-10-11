// Custom domain diagnosis, the way Shopify shows it: which DNS records the
// domain has and whether each one points at the store, whether visitors in
// every region resolve it, whether HTTPS works, and anything that will get in
// the way (a Cloudflare proxy, extra A/AAAA records, a CAA record that blocks
// the certificate).
//
// DNS answers come from public DNS-over-HTTPS resolvers. "Regions" are asked
// through Google Public DNS with a client subnet from that region (EDNS Client
// Subnet), which is how a resolver near a visitor there would be answered.

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'TXT'
export interface FoundRecord { type: RecordType; name: string; value: string; ok: boolean; note?: string }
export interface RegionCheck { code: string; name: string; ok: boolean; answers: string[] }
export interface ResolverCheck { name: string; ok: boolean; answers: string[] }
export interface DomainIssue { code: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string }
export interface Diagnosis {
  checked_at: string
  kind: 'apex' | 'subdomain'
  pointed: boolean
  live_everywhere: boolean
  records: FoundRecord[]
  regions: RegionCheck[]
  resolvers: ResolverCheck[]
  tls: { ok: boolean; detail: string; served_by_store: boolean | null; status: number | null }
  issues: DomainIssue[]
}

/** Where a domain must point. Vercel's current values first, older ones still accepted. */
export const TARGET = { a: '76.76.21.21', cname: 'cname.vercel-dns.com' }
const VERCEL_A = [/^76\.76\.21\.\d+$/, /^216\.198\.79\.\d+$/, /^64\.29\.17\.\d+$/, /^66\.33\.60\.\d+$/]
const VERCEL_CNAME = [/(^|\.)vercel-dns\.com\.?$/i, /(^|\.)vercel-dns-\d+\.com\.?$/i, /(^|\.)vercel\.app\.?$/i]

export const REGIONS: Array<{ code: string; name: string; subnet: string }> = [
  { code: 'na', name: 'North America', subnet: '73.162.0.0/24' },
  { code: 'sa', name: 'South America', subnet: '177.67.80.0/24' },
  { code: 'eu', name: 'Europe', subnet: '81.2.69.0/24' },
  { code: 'af', name: 'Africa', subnet: '41.203.64.0/24' },
  { code: 'as', name: 'Asia', subnet: '103.4.145.0/24' },
  { code: 'oc', name: 'Australia', subnet: '1.120.0.0/24' },
]

// Cloudflare's published proxy ranges (https://www.cloudflare.com/ips/).
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22']
const CLOUDFLARE_V6 = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c', '2c0f:f248:']

const ip4 = (ip: string) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0
export function isCloudflare(ip: string): boolean {
  if (ip.includes(':')) return CLOUDFLARE_V6.some((p) => ip.toLowerCase().startsWith(p))
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
  const n = ip4(ip)
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split('/')
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0
    return (n & mask) === (ip4(base) & mask)
  })
}
export const isVercelA = (ip: string) => VERCEL_A.some((r) => r.test(ip))
export const isVercelCname = (host: string) => VERCEL_CNAME.some((r) => r.test(host))

export function domainKind(domain: string): 'apex' | 'subdomain' {
  // Two-label names, and three-label names under a two-letter country second level (shop.com.bd), are apex.
  const parts = domain.split('.')
  if (parts.length === 2) return 'apex'
  if (parts.length === 3 && /^(com|net|org|co|gov|edu|ac)$/.test(parts[1]) && parts[2].length === 2) return 'apex'
  return 'subdomain'
}
export function apexOf(domain: string): string {
  const parts = domain.split('.')
  const cc = parts.length >= 3 && /^(com|net|org|co|gov|edu|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2
  return parts.slice(cc ? -3 : -2).join('.')
}
/** The record name as a registrar shows it ("@" for the apex, "www" for www.shop.com). */
export function hostLabel(domain: string): string {
  const apex = apexOf(domain)
  return domain === apex ? '@' : domain.slice(0, -(apex.length + 1))
}

const TYPE_CODE: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 }
interface DohAnswer { name: string; type: number; data: string }
type Fetch = typeof fetch

/** One DNS-over-HTTPS JSON query; null when the resolver could not be reached. */
export async function doh(fetcher: Fetch, base: string, name: string, type: RecordType, subnet?: string): Promise<DohAnswer[] | null> {
  const url = new URL(base)
  url.searchParams.set('name', name)
  url.searchParams.set('type', type)
  if (subnet) url.searchParams.set('edns_client_subnet', subnet)
  try {
    const res = await fetcher(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const body = await res.json() as { Status?: number; Answer?: DohAnswer[] }
    if (body.Status !== 0 && body.Status !== 3) return null
    return (body.Answer ?? []).map((a) => ({ ...a, data: String(a.data).replace(/^"|"$/g, '').replace(/\.$/, '') }))
  } catch {
    return null
  }
}

export const RESOLVERS = [
  { name: 'Google', url: 'https://dns.google/resolve' },
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'AdGuard', url: 'https://dns.adguard-dns.com/resolve' },
]

const only = (answers: DohAnswer[] | null, type: RecordType) => (answers ?? []).filter((a) => a.type === TYPE_CODE[type]).map((a) => a.data)

/** True when these answers (the CNAME chain and/or addresses) lead to the store. */
function answersPoint(kind: 'apex' | 'subdomain', answers: DohAnswer[] | null): boolean {
  if (!answers?.length) return false
  const cnames = only(answers, 'CNAME')
  const as = only(answers, 'A')
  if (cnames.some(isVercelCname)) return true
  // A subdomain may also use A records (some providers cannot set a CNAME).
  return as.length > 0 && as.every(isVercelA) && (kind === 'apex' || cnames.length === 0)
}

export async function diagnose(domain: string, opts: { fetcher?: Fetch; now?: Date; vercelPointed?: boolean | null } = {}): Promise<Diagnosis> {
  const fetcher = opts.fetcher ?? fetch
  const kind = domainKind(domain)
  const [a, aaaa, cname, caa, apexCaa] = await Promise.all([
    doh(fetcher, RESOLVERS[0].url, domain, 'A'),
    doh(fetcher, RESOLVERS[0].url, domain, 'AAAA'),
    doh(fetcher, RESOLVERS[0].url, domain, 'CNAME'),
    doh(fetcher, RESOLVERS[0].url, domain, 'CAA'),
    domain === apexOf(domain) ? Promise.resolve(null) : doh(fetcher, RESOLVERS[0].url, apexOf(domain), 'CAA'),
  ])
  const name = hostLabel(domain)
  const cnameValues = only(cname, 'CNAME').concat(only(a, 'CNAME')).filter((v, i, all) => all.indexOf(v) === i)
  const aValues = only(a, 'A')
  const aaaaValues = only(aaaa, 'AAAA')
  const proxied = aValues.some(isCloudflare) || aaaaValues.some(isCloudflare)

  // HTTPS: does the domain open over TLS, and is it our hosting answering?
  const tls = await (async (): Promise<Diagnosis['tls']> => {
    try {
      const res = await fetcher(`https://${domain}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      await res.body?.cancel().catch(() => undefined)
      const ours = res.headers.has('x-vercel-id') || /vercel/i.test(res.headers.get('server') ?? '')
      return { ok: true, status: res.status, served_by_store: ours, detail: ours ? 'TLS certificate provisioned for secure connections' : 'HTTPS works, but another server answered (not the store)' }
    } catch (error) {
      const msg = String((error as Error)?.message ?? error)
      const cert = /certificate|tls|ssl|handshake/i.test(msg)
      return { ok: false, status: null, served_by_store: null, detail: cert ? 'The certificate is not ready yet (it is issued once DNS points at the store)' : 'The domain did not answer over HTTPS yet' }
    }
  })()

  const servedByUs = tls.served_by_store === true
  const records: FoundRecord[] = []
  for (const v of cnameValues) {
    const ok = isVercelCname(v)
    records.push({ type: 'CNAME', name, value: v, ok, note: ok ? undefined : `Should be ${TARGET.cname}` })
  }
  // With a CNAME, the A/AAAA answers belong to its target, not to this name.
  const own = cnameValues.length === 0
  for (const v of own ? aValues : []) {
    const ok = isVercelA(v) || (isCloudflare(v) && servedByUs)
    records.push({ type: 'A', name, value: v, ok, note: ok ? (isCloudflare(v) ? 'Cloudflare proxy' : undefined) : isCloudflare(v) ? 'Cloudflare proxy (not reaching the store)' : `Should be ${TARGET.a}` })
  }
  for (const v of own ? aaaaValues : []) {
    const ok = isCloudflare(v) && servedByUs
    records.push({ type: 'AAAA', name, value: v, ok, note: ok ? 'Cloudflare proxy' : 'Remove: the store has no IPv6 address' })
  }

  const pointedByDns = answersPoint(kind, a) || cnameValues.some(isVercelCname) || (proxied && servedByUs)
  const pointed = opts.vercelPointed ?? pointedByDns

  // Every region and every resolver should see the same thing.
  const regionAnswers = await Promise.all(REGIONS.map((r) => doh(fetcher, RESOLVERS[0].url, domain, 'A', r.subnet)))
  const regions = REGIONS.map((r, i) => {
    const ans = regionAnswers[i]
    const ok = answersPoint(kind, ans) || (proxied && servedByUs && only(ans, 'A').some(isCloudflare))
    return { code: r.code, name: r.name, ok, answers: only(ans, 'A').concat(only(ans, 'CNAME')) }
  })
  const resolverAnswers = await Promise.all(RESOLVERS.map((r) => doh(fetcher, r.url, domain, 'A')))
  const resolvers = RESOLVERS.map((r, i) => {
    const ans = resolverAnswers[i]
    const ok = answersPoint(kind, ans) || (proxied && servedByUs && only(ans, 'A').some(isCloudflare))
    return { name: r.name, ok, answers: only(ans, 'A').concat(only(ans, 'CNAME')) }
  })

  const issues: DomainIssue[] = []
  // Nothing answered at all: say so instead of claiming the records are missing.
  const reached = [a, aaaa, cname].some((x) => x !== null)
  if (!reached) {
    issues.push({ code: 'CHECK_FAILED', severity: 'error', title: 'Could not check DNS right now', detail: 'The DNS resolvers did not answer. Try again in a minute.' })
  } else if (!aValues.length && !cnameValues.length) {
    issues.push({ code: 'NO_RECORDS', severity: 'error', title: 'No DNS records found',
      detail: kind === 'apex' ? `Add an A record for @ pointing to ${TARGET.a} at your domain provider.` : `Add a CNAME record for ${name} pointing to ${TARGET.cname} at your domain provider.` })
  } else if (!pointedByDns) {
    issues.push({ code: 'WRONG_TARGET', severity: 'error', title: 'DNS records point somewhere else',
      detail: kind === 'apex' ? `Change the A record for @ to ${TARGET.a} and delete any other A records for @.` : `Change the CNAME record for ${name} to ${TARGET.cname}.` })
  }
  if (proxied) {
    issues.push({ code: 'CLOUDFLARE_PROXY', severity: servedByUs ? 'warning' : 'error', title: 'Your domain has a Cloudflare proxy',
      detail: servedByUs
        ? 'The store opens through it, but the proxy can delay certificate renewals and cache pages. In Cloudflare, set the record to "DNS only" (grey cloud).'
        : 'The proxy is not passing visitors to the store. In Cloudflare, set the record to "DNS only" (grey cloud).' })
  }
  const strayA = aValues.filter((v) => !isVercelA(v) && !isCloudflare(v))
  if (own && strayA.length && aValues.some(isVercelA)) {
    issues.push({ code: 'EXTRA_A', severity: 'error', title: 'Extra A records',
      detail: `Some visitors will reach ${strayA.join(', ')} instead of the store. Delete those A records.` })
  }
  if (own && aaaaValues.length && !proxied) {
    issues.push({ code: 'AAAA', severity: 'warning', title: 'IPv6 (AAAA) records found',
      detail: 'Visitors on IPv6 may reach another server. Delete the AAAA records for this name.' })
  }
  const caaValues = only(caa, 'CAA').concat(only(apexCaa, 'CAA'))
  if (caaValues.length && !caaValues.some((v) => /letsencrypt\.org/i.test(v))) {
    issues.push({ code: 'CAA', severity: 'error', title: 'A CAA record blocks the certificate',
      detail: 'Add a CAA record allowing letsencrypt.org, or the store cannot get an HTTPS certificate.' })
  }
  if (pointedByDns && !tls.ok) {
    issues.push({ code: 'TLS_PENDING', severity: 'info', title: 'Certificate on the way', detail: 'DNS is correct. The HTTPS certificate is usually ready within a few minutes.' })
  }
  const okRegions = regions.filter((r) => r.ok).length
  if (pointedByDns && okRegions < regions.length) {
    issues.push({ code: 'PROPAGATING', severity: 'info', title: 'Still spreading around the world',
      detail: `${okRegions} of ${regions.length} regions see the new records. DNS changes can take up to 48 hours to reach everyone.` })
  }

  return {
    checked_at: (opts.now ?? new Date()).toISOString(),
    kind,
    pointed,
    live_everywhere: okRegions === regions.length && resolvers.every((r) => r.ok),
    records,
    regions,
    resolvers,
    tls,
    issues,
  }
}

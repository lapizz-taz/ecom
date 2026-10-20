// Custom domain diagnosis, the way Shopify shows it: which DNS records the
// domain has and whether each one points at the store, whether visitors in
// every region resolve it, whether HTTPS works, and anything that will get in
// the way (a Cloudflare proxy, extra A/AAAA records, a CAA record that blocks
// the certificate).
//
// DNS answers come from public DNS-over-HTTPS resolvers. "Regions" are asked
// through Google Public DNS with a client subnet from that region (EDNS Client
// Subnet), which is how a resolver near a visitor there would be answered.

import { isPrivateIp } from './net.ts'

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
  /**
   * Who answers DNS for the domain (its nameservers, as the registry has them), so the steps can
   * name the right panel. moving_from: the nameservers DNS servers still remember after a switch.
   */
  dns_host?: { provider: string | null; nameservers: string[]; mixed: boolean; moving_from?: { provider: string | null; nameservers: string[] }; source?: 'registry' | 'resolvers' }
  /** What the hosting itself says (Cloudflare for SaaS): ownership and certificate status. */
  hosting?: { status: string; ssl_status: string | null; error: string | null }
}

/** A record the hosting asked for (ownership / certificate TXT) and whether it is there yet. */
export interface ExpectedRecord { type: 'TXT'; name: string; value: string }

// Where a domain's DNS is managed, from its nameservers.
const DNS_HOSTS: Array<[RegExp, string]> = [
  [/dns-parking\.com$|hostinger\./i, 'Hostinger'], [/registrar-servers\.com$/i, 'Namecheap'], [/domaincontrol\.com$/i, 'GoDaddy'],
  [/ns\.cloudflare\.com$/i, 'Cloudflare'], [/awsdns/i, 'Amazon Route 53'], [/googledomains\.com$|google\.com$/i, 'Google'],
  [/wixdns\.net$/i, 'Wix'], [/squarespacedns\.com$/i, 'Squarespace'], [/porkbun\.com$/i, 'Porkbun'], [/name\.com$/i, 'Name.com'],
  [/exabytes\./i, 'Exabytes'], [/hostgator\./i, 'HostGator'], [/bluehost\.com$/i, 'Bluehost'], [/dnsowl\.com$/i, 'NameSilo'],
  [/digitalocean\.com$/i, 'DigitalOcean'], [/vercel-dns\.com$/i, 'Vercel'], [/ultradns|nsone\.net$/i, 'Managed DNS'],
]
export function dnsHostOf(ns: string): string | null {
  const host = ns.toLowerCase().replace(/\.$/, '')
  return DNS_HOSTS.find(([re]) => re.test(host))?.[1] ?? null
}
/** The company behind a nameserver, or its own domain when unknown (ns1.example.net → example.net). */
const nsOwner = (ns: string) => dnsHostOf(ns) ?? ns.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.')
/** The one company behind these nameservers, else null. */
const companyOf = (ns: string[]) => {
  const owners = [...new Set(ns.map(nsOwner))]
  return owners.length === 1 ? owners[0] : null
}
const nsName = (ns: string) => ns.toLowerCase().replace(/\.$/, '')
const isCloudflareNs = (ns: string) => /\.ns\.cloudflare\.com$/.test(nsName(ns))

// Addresses of other website builders: a domain still pointing there shows the old site.
const OLD_HOSTS: Array<[RegExp, string]> = [
  [/^23\.227\.38\.\d+$/, 'Shopify'], [/^2\.57\.91\.\d+$/, 'Hostinger (website or parking page)'],
  [/^185\.230\.63\.\d+$/, 'Wix'], [/^198\.185\.159\.\d+$|^198\.49\.23\.\d+$/, 'Squarespace'], [/^76\.76\.21\.\d+$/, 'Vercel'],
  [/^(34\.102\.136\.180|15\.197\.142\.173|3\.33\.152\.147)$/, 'GoDaddy (parking or forwarding)'],
]
export const oldHostOf = (ip: string) => OLD_HOSTS.find(([re]) => re.test(ip))?.[1] ?? null

/**
 * Where a store's domain must point. On Vercel: an A record (apex) or a CNAME
 * to Vercel. On Cloudflare (Cloudflare for SaaS): a CNAME to our own target
 * hostname, also at the apex where the DNS provider allows it (CNAME
 * flattening / ALIAS); Cloudflare has no fixed address for an A record.
 */
export interface HostingTarget { provider: 'vercel' | 'cloudflare' | 'proxy'; a: string | null; cname: string; aaaa?: string | null }
/**
 * A root domain through our own proxy server (deploy/root-proxy): an A record to its
 * fixed address works at every DNS company, like Shopify's 23.227.38.65.
 */
export const proxyTarget = (ip: string, cname: string, ipv6?: string | null): HostingTarget =>
  ({ provider: 'proxy', a: ip.trim(), aaaa: ipv6?.trim() || null, cname: cname.toLowerCase().replace(/\.$/, '') })
export const VERCEL_TARGET: HostingTarget = { provider: 'vercel', a: '76.76.21.21', cname: 'cname.vercel-dns.com' }
export const cloudflareTarget = (cname: string): HostingTarget => ({ provider: 'cloudflare', a: null, cname: cname.toLowerCase().replace(/\.$/, '') })
/** Header every page of the site carries on Cloudflare (public/_headers), so a check can tell it is our store answering. */
export const STORE_HEADER = 'x-fullfilio'
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

// Country second levels a store domain sits under (shop.com.bd, shop.co.uk, shop.ne.jp); a short list, not the whole public suffix list.
const SLD = /^(com|net|org|co|gov|edu|ac|me|ltd|plc|ne|or|go|mil)$/
const bare = (d: string) => d.toLowerCase().replace(/\.$/, '')
export function domainKind(domain: string): 'apex' | 'subdomain' {
  return bare(domain) === apexOf(domain) ? 'apex' : 'subdomain'
}
export function apexOf(domain: string): string {
  const parts = bare(domain).split('.')
  const cc = parts.length >= 3 && SLD.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2
  return parts.slice(cc ? -3 : -2).join('.')
}
/** The record name as a registrar shows it ("@" for the apex, "www" for www.shop.com). */
export function hostLabel(domain: string): string {
  const apex = apexOf(domain)
  return bare(domain) === apex ? '@' : bare(domain).slice(0, -(apex.length + 1))
}

const TYPE_CODE: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 }
interface DohAnswer { name: string; type: number; data: string }
/** The answers, and the nameserver addresses Google says they came from ("Response from …"). */
type DohAnswers = DohAnswer[] & { from?: string[]; servfail?: boolean; nxdomain?: boolean }
type Fetch = typeof fetch

/** One DNS-over-HTTPS JSON query; null when the resolver could not be reached. */
export async function doh(fetcher: Fetch, base: string, name: string, type: RecordType, subnet?: string): Promise<DohAnswers | null> {
  const url = new URL(base)
  url.searchParams.set('name', name)
  url.searchParams.set('type', type)
  if (subnet) url.searchParams.set('edns_client_subnet', subnet)
  try {
    const res = await fetcher(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const body = await res.json() as { Status?: number; Answer?: DohAnswer[]; Comment?: unknown }
    if (body.Status === 2) return Object.assign([] as DohAnswer[], { servfail: true })
    if (body.Status !== 0 && body.Status !== 3) return null
    const answers: DohAnswers = (body.Answer ?? []).map((a) => ({ ...a, data: String(a.data).replace(/^"|"$/g, '').replace(/\.$/, '') }))
    const from = [body.Comment].flat().join(' ').match(/Response from (.*)/)?.[1]
    if (body.Status === 3) answers.nxdomain = true
    if (from) answers.from = from.split(/[\s,]+/).map((ip) => ip.replace(/\.$/, '').toLowerCase()).filter((ip) => /^[\d.]+$|:/.test(ip))
    return answers
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

/**
 * What the registry has for the domain (RDAP): its nameservers, who really answers its DNS even
 * while DNS servers still remember the old ones, and when the domain last changed there. Null
 * when the registry does not say (some country domains have no RDAP).
 */
export async function registryRecord(domain: string, fetcher: Fetch = fetch): Promise<{ nameservers: string[]; changed_at: string | null } | null> {
  const apex = apexOf(domain)
  // The registry's own RDAP server first (from IANA's list), then the rdap.org redirector:
  // rdap.org can turn away requests from cloud servers.
  const base = await rdapBase(apex, fetcher)
  for (const url of [...(base ? [`${base}domain/${encodeURIComponent(apex)}`] : []), `https://rdap.org/domain/${encodeURIComponent(apex)}`]) {
    const found = await rdapDomain(url, fetcher)
    if (found) return found
  }
  return null
}

const RDAP_HEADERS = { accept: 'application/rdap+json, application/json', 'user-agent': 'Fullfilio-domain-check/1.0 (+https://fullfilio.com)' }

async function rdapDomain(url: string, fetcher: Fetch): Promise<{ nameservers: string[]; changed_at: string | null } | null> {
  try {
    const res = await fetcher(url, { headers: RDAP_HEADERS, signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const body = await res.json() as { nameservers?: Array<{ ldhName?: unknown }>; events?: Array<{ eventAction?: unknown; eventDate?: unknown }> }
    const ns = [...new Set((Array.isArray(body?.nameservers) ? body.nameservers : []).map((n) => nsName(String(n?.ldhName ?? ''))).filter(Boolean))].sort()
    const changed = (Array.isArray(body?.events) ? body.events : []).find((e) => e?.eventAction === 'last changed')?.eventDate
    return ns.length ? { nameservers: ns, changed_at: typeof changed === 'string' && !Number.isNaN(Date.parse(changed)) ? changed : null } : null
  } catch {
    return null
  }
}

// IANA's list of each top-level domain's RDAP server, kept for a day once read.
let rdapServers: { at: number; byTld: Map<string, string> } | null = null
async function rdapBase(apex: string, fetcher: Fetch): Promise<string | null> {
  if (!rdapServers || Date.now() - rdapServers.at > 86_400_000) {
    try {
      const res = await fetcher('https://data.iana.org/rdap/dns.json', { headers: RDAP_HEADERS, signal: AbortSignal.timeout(6_000) })
      const body = res.ok ? await res.json() as { services?: unknown } : null
      const byTld = new Map<string, string>()
      for (const service of Array.isArray(body?.services) ? body.services : []) {
        const [tlds, urls] = Array.isArray(service) ? service as unknown[] : []
        const url = Array.isArray(urls) ? urls.find((u): u is string => typeof u === 'string' && u.startsWith('https://')) : undefined
        if (url && Array.isArray(tlds)) for (const t of tlds) if (typeof t === 'string') byTld.set(t.toLowerCase(), url.endsWith('/') ? url : `${url}/`)
      }
      // Only a list that came back is kept; otherwise it is asked again next time.
      if (byTld.size) rdapServers = { at: Date.now(), byTld }
    } catch {
      // rdap.org below
    }
  }
  return rdapServers?.byTld.get(apex.split('.').pop() ?? '') ?? null
}

/** How long after a change at the registry resolvers may still hold the old DNS company's records. */
const SWITCH_WINDOW_MS = 72 * 3600_000

/**
 * Which DNS really answers for the domain, and which public resolver already uses it. Right after
 * a nameserver switch, resolvers remember the old DNS company for a while (up to 48 hours) and
 * answer with its records, which no longer count.
 */
export interface DnsView {
  /** The registry's nameservers, else the ones the resolvers answer with. */
  nameservers: string[]
  /** Where the nameservers came from. */
  source: 'registry' | 'resolvers'
  /** Nameservers the registry no longer lists that resolvers still use (a switch in progress). */
  old: string[]
  /** Where to read the records: the first resolver already on the registry's nameservers. */
  resolver: string
  /** No resolver is on the new nameservers yet: the records they answer are the old DNS company's. */
  stale: boolean
  /**
   * The addresses of the registry's nameservers, while the domain changed there recently: an
   * answer Google got from another nameserver is the old DNS company's, from its cache.
   */
  servers: string[]
}

export async function dnsView(domain: string, fetcher: Fetch = fetch, now: Date = new Date()): Promise<DnsView> {
  const apex = apexOf(domain)
  const asked = RESOLVERS.slice(0, 2)
  const [record, ...answers] = await Promise.all([registryRecord(apex, fetcher), ...asked.map((r) => doh(fetcher, r.url, apex, 'NS'))])
  const registry = record?.nameservers ?? null
  const seen = answers.map((ans) => [...new Set(only(ans, 'NS').map(nsName))])
  const registryOwners = new Set((registry ?? []).map(nsOwner))
  // Still on nameservers the registry no longer lists: another company's, or another Cloudflare
  // account's (a Cloudflare zone answers with exactly the pair the registry has). The same company
  // under other names is a zone listing its own nameservers, not a switch.
  const behind = seen.map((ns) => !!registry && ns.length > 0 && !ns.some((n) => registry.includes(n))
    && (ns.some((n) => !registryOwners.has(nsOwner(n))) || ns.every(isCloudflareNs)))
  const current = seen.findIndex((ns, i) => ns.length > 0 && !behind[i])
  const old = [...new Set(seen.filter((_, i) => behind[i]).flat())].sort()
  // Just changed (or still switching): where the registry's nameservers are, to tell their answers from cached old ones.
  const recent = old.length > 0 || (!!record?.changed_at && now.getTime() - Date.parse(record.changed_at) < SWITCH_WINDOW_MS)
  const servers = registry && recent
    ? (await Promise.all(registry.flatMap((n) => (['A', 'AAAA'] as const).map((t) => doh(fetcher, RESOLVERS[0].url, n, t)))))
      .flatMap((ans, i) => only(ans, i % 2 ? 'AAAA' : 'A').map((ip) => ip.toLowerCase()))
    : []
  return {
    nameservers: registry ?? [...new Set(seen.flat())].sort(),
    source: registry ? 'registry' : 'resolvers',
    old,
    resolver: asked[Math.max(current, 0)].url,
    stale: old.length > 0 && current === -1,
    servers,
  }
}

/** Google got this answer from a nameserver the registry no longer lists: the old DNS company's, from its cache. */
const cachedFromOld = (answers: DohAnswers | null, view: DnsView) =>
  view.servers.length > 0 && !!answers?.from?.length && !answers.from.some((ip) => view.servers.includes(ip))

/** A record row read while resolvers still answer from the old DNS company. */
const fromOldDns = (r: FoundRecord, view: DnsView): FoundRecord =>
  ({ ...r, ok: false, note: `From your old DNS (${companyOf(view.old) ?? view.old.join(', ')}), which no longer counts` })

/** The CNAME / A checks for one hosting target. */
function matchers(target: HostingTarget) {
  if (target.provider === 'vercel') return { cname: isVercelCname, a: isVercelA }
  const cname = (host: string) => host.toLowerCase().replace(/\.$/, '') === target.cname
  // On our proxy only its address counts: a CNAME to the Cloudflare target never reaches it
  // (no custom hostname is made for a name on the proxy). A chain that ends at the address does.
  if (target.provider === 'proxy') return { cname: (_host: string) => false, a: (ip: string) => ip === target.a || (!!target.aaaa && ip === target.aaaa) }
  return { cname, a: (_ip: string) => false }
}

/** True when these answers (the CNAME chain and/or addresses) lead to the store. */
function answersPoint(kind: 'apex' | 'subdomain', answers: DohAnswer[] | null, target: HostingTarget = VERCEL_TARGET): boolean {
  if (!answers?.length) return false
  const m = matchers(target)
  const cnames = only(answers, 'CNAME')
  const as = only(answers, 'A')
  if (cnames.some(m.cname)) return true
  // On our proxy, any chain that ends at its address does (www CNAME to the root).
  if (target.provider === 'proxy' && as.length > 0 && as.every(m.a)) return true
  // A subdomain may also use A records (some providers cannot set a CNAME).
  return as.length > 0 && as.every(m.a) && (kind === 'apex' || cnames.length === 0)
}

/**
 * www.<root> on the root-domain proxy: it opens the store too (visitors move on to the root)
 * once it leads to the proxy, by an A record or a CNAME to the root. Gives the www records
 * found, and a warning while it does not lead there; null when DNS could not be asked
 * (nothing shown on a guess).
 */
export async function inspectWww(domain: string, target: HostingTarget, fetcher: Fetch = fetch, view?: DnsView): Promise<{ records: FoundRecord[]; issue: DomainIssue | null } | null> {
  if (target.provider !== 'proxy' || !target.a || domainKind(domain) !== 'apex') return null
  const www = `www.${domain}`
  let answers = await doh(fetcher, view?.resolver ?? RESOLVERS[0].url, www, 'A')
  // Google's cache still holds the old DNS company's answer: ask Cloudflare's resolver instead.
  if (view && cachedFromOld(answers, view)) answers = await doh(fetcher, RESOLVERS[1].url, www, 'A')
  if (answers === null || answers.servfail) return null
  const ips = only(answers, 'A')
  const cname = only(answers, 'CNAME')
  const toRoot = cname[0]?.toLowerCase() === domain.toLowerCase()
  const reaches = ips.length > 0 && ips.every((ip) => ip === target.a)
  const ok = toRoot || reaches
  // Its own A record proxied by Cloudflare (a CNAME to a name on Cloudflare also answers with Cloudflare's addresses).
  const orange = !cname.length && ips.length > 0 && ips.every(isCloudflare) && !!view?.nameservers.length && view.nameservers.every(isCloudflareNs)
  const fix = orange ? 'Cloudflare proxy (orange cloud): set www to "DNS only"' : `Should be A ${target.a}`
  const records: FoundRecord[] = cname.length
    ? cname.slice(0, 1).map((v) => ({ type: 'CNAME', name: 'www', value: v, ok, note: ok ? (reaches ? `Leads to the store through ${v}` : 'Follows @: fixed once the A record for @ is') : `${fix} (or a CNAME to ${domain})` }))
    : ips.length
      ? ips.map((v) => ({ type: 'A', name: 'www', value: v, ok: v === target.a, note: v === target.a ? undefined : fix }))
      : [{ type: 'A', name: 'www', value: '—', ok: false, note: `Not found yet — add an A record for www pointing to ${target.a}` }]
  // Answered by the old DNS company: the switch itself is the issue (see diagnose).
  if (view?.stale) return { records: records.map((r) => fromOldDns(r, view)), issue: null }
  if (ok) return { records, issue: null }
  const now = cname.length ? `a CNAME to ${cname[0]}` : ips.length ? `an A record to ${ips.join(', ')}` : null
  return {
    records,
    issue: {
      code: 'WWW_SETUP', severity: 'warning', title: `${www} is not set up yet`,
      detail: orange ? `In Cloudflare → ${domain} → DNS → Records, set the www record (A ${target.a}, or a CNAME to ${domain}) to Proxy status "DNS only" (grey cloud).`
        : !cname.length && ips.includes(target.a) ? `Delete the A record for www pointing to ${ips.filter((ip) => ip !== target.a).join(', ')}: visitors who type ${www} sometimes reach it instead of the store.`
        : now
        ? `${www} has ${now}. Replace it with an A record for www pointing to ${target.a}, so visitors who type www reach the store (they are sent on to ${domain}).`
        : `Add an A record for www pointing to ${target.a}, so visitors who type ${www} reach the store (they are sent on to ${domain}).`,
    },
  }
}

export async function diagnose(domain: string, opts: { fetcher?: Fetch; now?: Date; vercelPointed?: boolean | null; target?: HostingTarget; expect?: ExpectedRecord[]; view?: DnsView } = {}): Promise<Diagnosis> {
  const fetcher = opts.fetcher ?? fetch
  const target = opts.target ?? VERCEL_TARGET
  const onCloudflare = target.provider === 'cloudflare'
  const m = matchers(target)
  const kind = domainKind(domain)
  const ask = (resolver: string) => Promise.all((['A', 'AAAA', 'CNAME'] as const).map((t) => doh(fetcher, resolver, domain, t)))
  const [view, first, caa, apexCaa, targetA, targetAaaa] = await Promise.all([
    opts.view ?? dnsView(domain, fetcher, opts.now),
    ask(opts.view?.resolver ?? RESOLVERS[0].url),
    doh(fetcher, RESOLVERS[0].url, domain, 'CAA'),
    domain === apexOf(domain) ? Promise.resolve(null) : doh(fetcher, RESOLVERS[0].url, apexOf(domain), 'CAA'),
    // The addresses our own target has: an ALIAS / flattened root answers with exactly these.
    onCloudflare ? doh(fetcher, RESOLVERS[0].url, target.cname, 'A') : Promise.resolve(null),
    onCloudflare ? doh(fetcher, RESOLVERS[0].url, target.cname, 'AAAA') : Promise.resolve(null),
  ])
  // Google still remembers the old DNS company: read the records from a resolver that has the new one.
  let [a, aaaa, cname] = opts.view || view.resolver === RESOLVERS[0].url ? first : await ask(view.resolver)
  if ([a, aaaa, cname].some((x) => cachedFromOld(x, view))) [a, aaaa, cname] = await ask(RESOLVERS[1].url)
  const ourA = new Set(only(targetA, 'A'))
  const ourAaaa = new Set(only(targetAaaa, 'AAAA'))
  const isOurs = (ip: string) => ourA.has(ip) || ourAaaa.has(ip)
  // Another builder's address, unless it is the hosting this domain should point at.
  const oldOf = (ip: string) => (m.a(ip) || isOurs(ip) ? null : oldHostOf(ip))
  const name = hostLabel(domain)
  const cnameValues = only(cname, 'CNAME').concat(only(a, 'CNAME')).filter((v, i, all) => all.indexOf(v) === i)
  const aValues = only(a, 'A')
  const aaaaValues = only(aaaa, 'AAAA')
  const proxied = aValues.length ? aValues.every(isCloudflare) : aaaaValues.some(isCloudflare)

  // HTTPS: does the domain open over TLS, and is it our hosting answering?
  // Skip the probe when the domain resolves to a private/internal address: a
  // merchant could otherwise point their domain's A/AAAA record at 169.254.x or
  // an RFC1918 host and use this diagnostic as an SSRF oracle into our network.
  const resolvesPrivate = aValues.some(isPrivateIp) || aaaaValues.some(isPrivateIp)
  const tls = await (async (): Promise<Diagnosis['tls']> => {
    if (resolvesPrivate) return { ok: false, status: null, served_by_store: null, detail: 'The domain points at a private or internal address' }
    try {
      const res = await fetcher(`https://${domain}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      await res.body?.cancel().catch(() => undefined)
      const ours = target.provider === 'vercel' ? res.headers.has('x-vercel-id') || /vercel/i.test(res.headers.get('server') ?? '') : res.headers.has(STORE_HEADER)
      // Our proxy answering an error page: the store behind it hiccupped, not another server.
      if (!ours && target.provider === 'proxy' && res.status >= 500) {
        return { ok: true, status: res.status, served_by_store: null, detail: `The store did not answer just now (HTTP ${res.status})` }
      }
      return { ok: true, status: res.status, served_by_store: ours, detail: ours ? 'TLS certificate provisioned for secure connections' : 'HTTPS works, but another server answered (not the store)' }
    } catch (error) {
      const msg = String((error as Error)?.message ?? error)
      const cert = /certificate|tls|ssl|handshake/i.test(msg)
      return { ok: false, status: null, served_by_store: null, detail: cert ? 'The certificate is not ready yet (it is issued once DNS points at the store)' : 'The domain did not answer over HTTPS yet' }
    }
  })()

  const servedByUs = tls.served_by_store === true
  // A root ALIAS / CNAME flattening answers with our target's own addresses.
  const flattened = onCloudflare && aValues.length > 0 && aValues.every(isOurs)
  // Nameservers: who answers DNS for the domain.
  const nameservers = view.nameservers
  const onCloudflareDns = nameservers.length > 0 && nameservers.every(isCloudflareNs)
  // The domain's own Cloudflare zone proxies the name (orange cloud): visitors reach that zone,
  // not the store, and the certificate cannot be issued. Public DNS shows only the proxy's addresses.
  const orangeCloud = (onCloudflare || target.provider === 'proxy') && onCloudflareDns && cnameValues.length === 0 && proxied && !servedByUs && !flattened
  const records: FoundRecord[] = []
  // On our proxy a CNAME is fine when its chain ends at the proxy's address (www → the root).
  const chainToProxy = target.provider === 'proxy' && aValues.length > 0 && aValues.every(m.a)
  for (const v of cnameValues) {
    const ok = m.cname(v) || chainToProxy
    records.push({ type: 'CNAME', name, value: v, ok,
      note: ok ? (chainToProxy && !m.cname(v) ? `Leads to the store through ${v}` : undefined) : `Should be ${target.a ? `an A record to ${target.a}` : target.cname}` })
  }
  // With a CNAME, the A/AAAA answers belong to its target, not to this name.
  const own = cnameValues.length === 0
  for (const v of own ? aValues : []) {
    const ok = m.a(v) || isOurs(v) || (proxied && servedByUs)
    const wrong = target.a ? `Should be ${target.a}` : `Use a CNAME (or ALIAS) to ${target.cname} instead`
    const old = oldOf(v)
    const note = old ? `Still points to ${old} — ${target.a && !aValues.some(m.a) ? `change it to ${target.a}` : 'delete this record'}`
      : orangeCloud ? 'Your Cloudflare proxy (orange cloud) answers here, not the store'
      : target.provider === 'proxy' ? (ok ? undefined : wrong)
      : onCloudflare
      ? (ok ? 'Points to Fullfilio (ALIAS / flattening)' : isCloudflare(v) ? 'Another Cloudflare site answers here, not the store' : wrong)
      : (ok ? (isCloudflare(v) ? 'Cloudflare proxy' : undefined) : isCloudflare(v) ? 'Cloudflare proxy (not reaching the store)' : wrong)
    records.push({ type: 'A', name, value: v, ok, note })
  }
  for (const v of own ? aaaaValues : []) {
    const ok = isOurs(v) || m.a(v) || (proxied && isCloudflare(v) && servedByUs)
    records.push({ type: 'AAAA', name, value: v, ok, note: ok ? (onCloudflare ? 'Points to Fullfilio (ALIAS / flattening)' : isCloudflare(v) ? 'Cloudflare proxy' : undefined)
      : orangeCloud ? 'Your Cloudflare proxy (orange cloud) answers here, not the store' : target.aaaa ? `Should be ${target.aaaa}` : 'Remove: the store has no IPv6 address' })
  }
  // Records the hosting asked for (ownership / certificate): are they there yet? On Cloudflare
  // DNS they do not count (Cloudflare verifies through the CNAME there), so none are asked for.
  // (Our own ownership record, _fullfilio.<domain>, is asked for on any DNS.)
  const expected = (opts.expect ?? []).filter((e) => !(onCloudflare && onCloudflareDns) || e.name.startsWith('_fullfilio.'))
  const txtValues = (ans: DohAnswers | null) => only(ans, 'TXT').map((v) => v.replace(/"/g, '').trim())
  const txtAnswers = await Promise.all(expected.map((e) => doh(fetcher, view.resolver, e.name, 'TXT')))
  // Typed with the full name at a DNS company that adds the domain itself (_fullfilio.shop.com.shop.com).
  const doubled = await Promise.all(expected.map((e, i) => txtValues(txtAnswers[i]).some((v) => v.includes(e.value)) || !e.name.startsWith('_fullfilio.')
    ? Promise.resolve(null) : doh(fetcher, view.resolver, `${e.name}.${apexOf(domain)}`, 'TXT')))
  const missingTxt: ExpectedRecord[] = []
  const staleTxt: string[] = []
  const typoTxt: string[] = []
  expected.forEach((e, i) => {
    const values = txtValues(txtAnswers[i])
    const found = values.some((v) => v.includes(e.value))
    const typo = !found && txtValues(doubled[i]).some((v) => v.includes(e.value)) ? `${e.name}.${apexOf(domain)}` : null
    // A record at this name with another value: an old code, or one typed wrong.
    const stale = found ? [] : values.filter((v) => v.length > 0)
    if (!found) missingTxt.push(e)
    if (typo) typoTxt.push(typo)
    staleTxt.push(...stale)
    records.push({ type: 'TXT', name: e.name === domain ? name : e.name.replace(new RegExp(`\\.${apexOf(domain).replace(/\./g, '\\.')}$`), ''), value: e.value, ok: found,
      note: found ? 'Found' : typo ? `Found at ${typo}: enter only the name shown here` : stale.length ? `Has another value (${stale[0]}) — change it to this one` : 'Not found yet — add it at your domain provider' })
  })

  // Records only the old DNS company still answers with do not count: they go away with its cache.
  const pointedByDns = !view.stale && (answersPoint(kind, a, target) || cnameValues.some(m.cname) || flattened || (proxied && servedByUs))
  const pointed = opts.vercelPointed ?? pointedByDns

  // Every region and every resolver should see the same thing.
  const regionAnswers = await Promise.all(REGIONS.map((r) => doh(fetcher, RESOLVERS[0].url, domain, 'A', r.subnet)))
  const reachesUs = (ans: DohAnswer[] | null) => onCloudflare && only(ans, 'A').length > 0 && only(ans, 'A').every(isOurs)
  const regions = REGIONS.map((r, i) => {
    const ans = regionAnswers[i]
    const ok = answersPoint(kind, ans, target) || reachesUs(ans) || (proxied && servedByUs && only(ans, 'A').some(isCloudflare))
    return { code: r.code, name: r.name, ok, answers: only(ans, 'A').concat(only(ans, 'CNAME')) }
  })
  const resolverAnswers = await Promise.all(RESOLVERS.map((r) => doh(fetcher, r.url, domain, 'A')))
  const resolvers = RESOLVERS.map((r, i) => {
    const ans = resolverAnswers[i]
    const ok = answersPoint(kind, ans, target) || reachesUs(ans) || (proxied && servedByUs && only(ans, 'A').some(isCloudflare))
    return { name: r.name, ok, answers: only(ans, 'A').concat(only(ans, 'CNAME')) }
  })

  let issues: DomainIssue[] = []
  // Nameservers: who answers for the domain. Two different companies means half the
  // visitors get one set of records and half the other (old site, then new, then old).
  const owners = [...new Set(nameservers.map(nsOwner))]
  const dnsHost: NonNullable<Diagnosis['dns_host']> = { provider: owners.length === 1 ? owners[0] : null, nameservers, mixed: owners.length > 1, source: view.source }
  if (view.old.length) {
    // Just switched DNS company: the registry has the new nameservers, resolvers still the old ones.
    const now = dnsHost.provider ?? nameservers.join(', ')
    const before = companyOf(view.old) ?? view.old.join(', ')
    dnsHost.moving_from = { provider: companyOf(view.old), nameservers: view.old }
    for (let i = 0; view.stale && i < records.length; i++) records[i] = fromOldDns(records[i], view)
    issues.push(view.stale
      ? { code: 'NS_SWITCHING', severity: 'error', title: `Your DNS moved to ${now} — add the records there`,
        detail: `${apexOf(domain)} now uses ${now} (${nameservers.join(', ')}), but DNS servers still answer from your old DNS (${before}) for up to 48 hours, so the records seen here are the old ones, not ${now}'s. Add the records below at ${now}: that is where your DNS is now. We keep checking by ourselves and see them once DNS servers catch up. Setting the same records at ${before} too lets those visitors reach the store meanwhile.` }
      : { code: 'NS_SWITCHING', severity: 'warning', title: `Your DNS just moved to ${now}`,
        detail: `Some DNS servers still answer from your old DNS (${before}) for up to 48 hours, so some visitors may get the old records until then. The records shown here are ${now}'s, the ones that count now. Setting the same records at ${before} too lets those visitors reach the store meanwhile.` })
  }
  // A root domain connects only when its DNS is on Cloudflare (a CNAME at @, which Cloudflare
  // flattens). Elsewhere it never verifies: Hostinger and others cannot hold a CNAME at @.
  if (kind === 'apex' && onCloudflare && nameservers.length > 0 && !onCloudflareDns) {
    issues.push({ code: 'NEEDS_CLOUDFLARE', severity: 'error', title: 'Main domain works only with Cloudflare DNS',
      detail: `${domain} can connect only when its DNS is on Cloudflare (free)${dnsHost.provider ? `; it is on ${dnsHost.provider} now, which cannot` : ''}. Move the DNS to Cloudflare with the steps below, or use www.${domain}, which works at any DNS company.` })
  }
  if (dnsHost.mixed) {
    const cf = nameservers.filter((n) => /\.ns\.cloudflare\.com\.?$/.test(n))
    const others = nameservers.filter((n) => !cf.includes(n))
    issues.push({ code: 'NS_MIXED', severity: 'error', title: 'Your domain uses nameservers from two companies',
      detail: cf.length && others.length && kind === 'apex' && onCloudflare
        ? `Keep only the Cloudflare nameservers (${cf.join(', ')}). At the company where you bought the domain, open Nameservers and delete ${others.join(', ')}. Until then visitors randomly get the old DNS, so the store comes and goes. Changes take up to an hour.`
        : `It lists ${nameservers.join(', ')}. Visitors randomly get the records of one or the other, so the old site keeps coming back. At the company where you bought the domain, set the nameservers to only one company (the one where you edit DNS), then wait an hour.` })
  }
  // Old site still answering somewhere (left-over record, or cached for a while after deleting it).
  // (Only for a name with its own A records: behind a CNAME a wrong target is WRONG_TARGET.)
  const seen = own ? [...aValues, ...regions.filter((r) => !r.ok).flatMap((r) => r.answers), ...resolvers.filter((r) => !r.ok).flatMap((r) => r.answers)] : []
  const oldSeen = [...new Set(seen.map(oldOf).filter((x): x is string => !!x))]
  if (oldSeen.length) {
    const inRecords = aValues.some((v) => oldOf(v))
    issues.push({ code: 'OLD_HOST', severity: inRecords ? 'error' : 'warning', title: inRecords && aValues.every((v) => oldOf(v)) ? `Your domain still points to ${oldSeen.join(' and ')}` : `Some visitors still reach ${oldSeen.join(' and ')}`,
      detail: inRecords
        ? `Your DNS still has an A record for ${name} pointing to ${oldSeen.join(' / ')}. ${target.a && !aValues.some(m.a) ? `Change it to ${target.a}` : 'Delete it'} at ${dnsHost.provider ?? 'your domain provider'}.`
        : `The old address is no longer in your records but some DNS servers still remember it. It clears by itself within a few hours.${dnsHost.mixed ? '' : ' If it keeps coming back after that, check your nameservers.'}` })
  }
  if (missingTxt.length) {
    // The record names as the panel shows them (relative to the root: _fullfilio, _fullfilio.blog).
    const txtNames = missingTxt.map((t) => (t.name === domain ? name : t.name.replace(new RegExp(`\\.${apexOf(domain).replace(/\./g, '\\.')}$`), ''))).join(', ')
    issues.push(staleTxt.length ? { code: 'TXT_MISSING', severity: 'error', title: 'Verification record has an old value',
      detail: `The TXT record ${txtNames} holds ${staleTxt[0]}, not the value shown below. Edit the record and paste the value shown below.` }
      : typoTxt.length ? { code: 'TXT_MISSING', severity: 'error', title: 'Verification record has the wrong name',
      detail: `It was found at ${typoTxt.join(', ')}: your DNS company adds ${apexOf(domain)} to the name by itself. Edit the record and enter only ${txtNames} as its name.` }
      : { code: 'TXT_MISSING', severity: 'error', title: 'Verification record missing',
      detail: `Add the TXT record ${txtNames} shown below at your domain provider. It proves the domain is yours; the store cannot go live without it. A record added just now can take up to an hour to be seen.` })
  }
  // Nothing answered at all: say so instead of claiming the records are missing. One lookup
  // that did not answer (a resolver rate-limiting) is the same: what is missing is unknown.
  const reached = [a, aaaa, cname].some((x) => x !== null)
  const partial = [a, aaaa, cname].some((x) => x === null)
  if ([a, aaaa, cname].every((x) => x?.servfail)) {
    issues.push({ code: 'DNS_BROKEN', severity: 'error', title: 'DNS servers cannot read your domain',
      detail: `DNS servers answer "server failure" for ${domain}, so visitors cannot open it. Usually DNSSEC is still on where you bought the domain after the nameservers changed: turn DNSSEC off there (or delete its DS record), then wait an hour.` })
  } else if (kind === 'apex' && [a, aaaa, cname].every((x) => x?.nxdomain)) {
    issues.push({ code: 'NO_DOMAIN', severity: 'error', title: `${domain} does not exist in DNS`,
      detail: 'Check the spelling, that the domain is registered and paid (not expired or on hold), and that it has nameservers where you bought it.' })
  } else if (!reached || (partial && !pointedByDns)) {
    issues.push({ code: 'CHECK_FAILED', severity: 'error', title: 'Could not check DNS right now',
      detail: reached ? 'Some DNS lookups did not answer. Try again in a minute.' : 'The DNS resolvers did not answer. Try again in a minute.' })
  } else if (!aValues.length && !cnameValues.length) {
    issues.push({ code: 'NO_RECORDS', severity: 'error', title: 'No DNS records found',
      detail: target.a && (kind === 'apex' || target.provider === 'proxy') ? `Add an A record for ${name} pointing to ${target.a} at your domain provider.`
        : kind === 'apex' ? `Add a CNAME (or ALIAS / ANAME) record for @ pointing to ${target.cname}. If your domain provider cannot, use www.${domain} instead.`
        : `Add a CNAME record for ${name} pointing to ${target.cname} at your domain provider.` })
  } else if (orangeCloud) {
    issues.push({ code: 'ORANGE_CLOUD', severity: 'error', title: 'Turn off the orange cloud in Cloudflare',
      detail: `In Cloudflare → ${apexOf(domain)} → DNS → Records, edit the ${name} record: it must be ${target.a ? `an A record to ${target.a} (not a CNAME or ALIAS)` : `a CNAME to ${target.cname}`} with Proxy status "DNS only" (grey cloud). It is proxied (orange) now, so your own Cloudflare answers instead of the store and the HTTPS certificate cannot be issued. It connects by itself within about 10 minutes of the change.` })
  } else if (!pointedByDns) {
    issues.push({ code: 'WRONG_TARGET', severity: 'error', title: 'DNS records point somewhere else',
      detail: target.a && (kind === 'apex' || target.provider === 'proxy')
        ? (cnameValues.length ? `Delete the CNAME record for ${name} and add an A record for ${name} pointing to ${target.a}.`
          : `Change the A record for ${name} to ${target.a} and delete any other A records for ${name}.`)
        : kind === 'apex' ? `Point @ at ${target.cname} with a CNAME (or ALIAS / ANAME) record and delete the A and AAAA records for @.`
        : aValues.length && !cnameValues.length ? `Delete the A record for ${name} and add a CNAME record for ${name} pointing to ${target.cname}.`
        : `Change the CNAME record for ${name} to ${target.cname}.` })
  }
  // On Cloudflare a customer's own Cloudflare proxy in front of us works as is. Records that lead to
  // our own Cloudflare address (a CNAME, or an ALIAS at another DNS company flattened to it) are not
  // the customer's proxy: only a domain whose DNS is at Cloudflare can have one.
  const toOurCloudflare = cnameValues.some((v) => v.toLowerCase().replace(/\.$/, '') === target.cname) || (nameservers.length > 0 && !onCloudflareDns)
  if (proxied && !onCloudflare && !orangeCloud && !toOurCloudflare) {
    issues.push({ code: 'CLOUDFLARE_PROXY', severity: servedByUs ? 'warning' : 'error', title: 'Your domain has a Cloudflare proxy',
      detail: servedByUs
        ? 'The store opens through it, but the proxy can delay certificate renewals and cache pages. In Cloudflare, set the record to "DNS only" (grey cloud).'
        : 'The proxy is not passing visitors to the store. In Cloudflare, set the record to "DNS only" (grey cloud).' })
  }
  const strayA = aValues.filter((v) => !m.a(v) && !isOurs(v) && !(proxied && isCloudflare(v)))
  if (own && strayA.length && (aValues.some(m.a) || (onCloudflare && servedByUs))) {
    issues.push({ code: 'EXTRA_A', severity: 'error', title: 'Extra A records',
      detail: `Some visitors will reach ${strayA.join(', ')} instead of the store. Delete those A records.` })
  }
  // A Cloudflare address next to records that are not proxied is a leftover too.
  const strayAaaa = own ? aaaaValues.filter((v) => !m.a(v) && !isOurs(v) && !(proxied && isCloudflare(v))) : []
  if (strayAaaa.length) {
    issues.push({ code: 'AAAA', severity: target.provider === 'proxy' ? 'error' : 'warning', title: 'IPv6 (AAAA) records found',
      detail: `${target.aaaa ? `Change the AAAA record for ${name} to ${target.aaaa}` : `Delete the AAAA record for ${name} (${strayAaaa.join(', ')})`} at ${dnsHost.provider ?? 'your domain provider'}. Visitors on IPv6 reach another server, and the HTTPS certificate cannot be issued or renewed while it is there (it is checked over IPv6 first).` })
  }
  const caaValues = only(caa, 'CAA').concat(only(apexCaa, 'CAA')).filter((v) => /^\d+\s+issue\s/i.test(v))
  // Cloudflare issues the certificate through Let's Encrypt or Google Trust Services.
  const allowedCa = onCloudflare ? /letsencrypt\.org|pki\.goog/i : /letsencrypt\.org/i
  if (caaValues.length && !caaValues.some((v) => allowedCa.test(v))) {
    issues.push({ code: 'CAA', severity: 'error', title: 'A CAA record blocks the certificate',
      detail: onCloudflare ? 'Add CAA records allowing letsencrypt.org and pki.goog, or the store cannot get an HTTPS certificate.'
        : 'Add a CAA record allowing letsencrypt.org, or the store cannot get an HTTPS certificate.' })
  }
  // Not while the ownership record is missing: the proxy gets no certificate until it is found.
  if (pointedByDns && !tls.ok && !issues.some((i) => i.code === 'CAA' || i.code === 'AAAA') && !missingTxt.some((t) => t.name.startsWith('_fullfilio.'))) {
    issues.push({ code: 'TLS_PENDING', severity: 'info', title: 'Certificate on the way', detail: 'DNS is correct. The HTTPS certificate is usually ready within a few minutes.' })
  }
  if (target.provider === 'proxy' && pointedByDns && tls.ok && tls.served_by_store === null) {
    issues.push({ code: 'STORE_DOWN', severity: 'warning', title: 'The store did not answer just now',
      detail: `https://${domain} reached the store's server, which answered with an error (HTTP ${tls.status}). This usually clears by itself; we keep checking.` })
  }
  if (target.provider === 'proxy' && pointedByDns && tls.ok && tls.served_by_store === false) {
    issues.push({ code: 'NOT_STORE', severity: 'error', title: 'Another server answers on HTTPS',
      detail: `DNS points at the store, but https://${domain} was answered by another server. Delete any other A or AAAA record for ${name}; if there is none this clears by itself (we keep checking).` })
  }
  const okRegions = regions.filter((r) => r.ok).length
  const lagging = resolvers.filter((r, i) => !r.ok && resolverAnswers[i] !== null)
  if (pointedByDns && (okRegions < regions.length || lagging.length)) {
    issues.push({ code: 'PROPAGATING', severity: 'info', title: 'Still spreading around the world',
      detail: `${okRegions} of ${regions.length} regions${lagging.length ? ` (not yet: ${lagging.map((r) => r.name).join(', ')} DNS)` : ''} see the new records. DNS changes can take up to 48 hours to reach everyone.` })
  }
  // Only the old DNS company's records were seen: what they say no longer counts.
  if (view.stale) issues = issues.filter((i) => ['NS_SWITCHING', 'NEEDS_CLOUDFLARE', 'NS_MIXED', 'CHECK_FAILED', 'CAA'].includes(i.code))

  return {
    checked_at: (opts.now ?? new Date()).toISOString(),
    kind,
    pointed,
    live_everywhere: okRegions === regions.length && !lagging.length,
    records,
    regions,
    resolvers,
    tls,
    issues,
    dns_host: dnsHost,
  }
}

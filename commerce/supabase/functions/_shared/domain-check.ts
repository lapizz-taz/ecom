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
  /** Who answers DNS for the domain (its nameservers), so the steps can name the right panel. */
  dns_host?: { provider: string | null; nameservers: string[]; mixed: boolean }
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

// Addresses of other website builders: a domain still pointing there shows the old site.
/**
 * DNS companies whose DNS runs on Cloudflare itself. Cloudflare cannot verify a root
 * domain there with a TXT record (no pre-validation for a domain already on Cloudflare),
 * and the root cannot hold a real CNAME, so the root never goes live: use www instead.
 */
export const CLOUDFLARE_BACKED_DNS = new Set(['Hostinger'])

const OLD_HOSTS: Array<[RegExp, string]> = [
  [/^23\.227\.38\.\d+$/, 'Shopify'], [/^2\.57\.91\.\d+$/, 'Hostinger (website or parking page)'],
  [/^185\.230\.63\.\d+$/, 'Wix'], [/^198\.185\.159\.\d+$|^198\.49\.23\.\d+$/, 'Squarespace'], [/^76\.76\.21\.\d+$/, 'Vercel'],
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

/** The CNAME / A checks for one hosting target. */
function matchers(target: HostingTarget) {
  if (target.provider === 'vercel') return { cname: isVercelCname, a: isVercelA }
  const cname = (host: string) => host.toLowerCase().replace(/\.$/, '') === target.cname
  if (target.provider === 'proxy') return { cname, a: (ip: string) => ip === target.a || (!!target.aaaa && ip === target.aaaa) }
  return { cname, a: (_ip: string) => false }
}

/** True when these answers (the CNAME chain and/or addresses) lead to the store. */
function answersPoint(kind: 'apex' | 'subdomain', answers: DohAnswer[] | null, target: HostingTarget = VERCEL_TARGET): boolean {
  if (!answers?.length) return false
  const m = matchers(target)
  const cnames = only(answers, 'CNAME')
  const as = only(answers, 'A')
  if (cnames.some(m.cname)) return true
  // A subdomain may also use A records (some providers cannot set a CNAME).
  return as.length > 0 && as.every(m.a) && (kind === 'apex' || cnames.length === 0)
}

export async function diagnose(domain: string, opts: { fetcher?: Fetch; now?: Date; vercelPointed?: boolean | null; target?: HostingTarget; expect?: ExpectedRecord[] } = {}): Promise<Diagnosis> {
  const fetcher = opts.fetcher ?? fetch
  const target = opts.target ?? VERCEL_TARGET
  const onCloudflare = target.provider === 'cloudflare'
  const m = matchers(target)
  const kind = domainKind(domain)
  const [a, aaaa, cname, caa, apexCaa, targetA, targetAaaa, nsGoogle, nsCloudflare] = await Promise.all([
    doh(fetcher, RESOLVERS[0].url, domain, 'A'),
    doh(fetcher, RESOLVERS[0].url, domain, 'AAAA'),
    doh(fetcher, RESOLVERS[0].url, domain, 'CNAME'),
    doh(fetcher, RESOLVERS[0].url, domain, 'CAA'),
    domain === apexOf(domain) ? Promise.resolve(null) : doh(fetcher, RESOLVERS[0].url, apexOf(domain), 'CAA'),
    // The addresses our own target has: an ALIAS / flattened root answers with exactly these.
    onCloudflare ? doh(fetcher, RESOLVERS[0].url, target.cname, 'A') : Promise.resolve(null),
    onCloudflare ? doh(fetcher, RESOLVERS[0].url, target.cname, 'AAAA') : Promise.resolve(null),
    doh(fetcher, RESOLVERS[0].url, apexOf(domain), 'NS'),
    doh(fetcher, RESOLVERS[1].url, apexOf(domain), 'NS'),
  ])
  const ourA = new Set(only(targetA, 'A'))
  const ourAaaa = new Set(only(targetAaaa, 'AAAA'))
  const isOurs = (ip: string) => ourA.has(ip) || ourAaaa.has(ip)
  // Another builder's address, unless it is the hosting this domain should point at.
  const oldOf = (ip: string) => (m.a(ip) || isOurs(ip) ? null : oldHostOf(ip))
  const name = hostLabel(domain)
  const cnameValues = only(cname, 'CNAME').concat(only(a, 'CNAME')).filter((v, i, all) => all.indexOf(v) === i)
  const aValues = only(a, 'A')
  const aaaaValues = only(aaaa, 'AAAA')
  const proxied = aValues.some(isCloudflare) || aaaaValues.some(isCloudflare)

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
  const records: FoundRecord[] = []
  for (const v of cnameValues) {
    const ok = m.cname(v)
    records.push({ type: 'CNAME', name, value: v, ok, note: ok ? undefined : `Should be ${target.cname}` })
  }
  // With a CNAME, the A/AAAA answers belong to its target, not to this name.
  const own = cnameValues.length === 0
  for (const v of own ? aValues : []) {
    const ok = m.a(v) || isOurs(v) || (isCloudflare(v) && servedByUs)
    const wrong = target.a ? `Should be ${target.a}` : `Use a CNAME (or ALIAS) to ${target.cname} instead`
    const old = oldOf(v)
    const note = old ? `Still points to ${old} — delete this record`
      : target.provider === 'proxy' ? (ok ? undefined : wrong)
      : onCloudflare
      ? (ok ? 'Points to Fullfilio (ALIAS / flattening)' : isCloudflare(v) ? 'Another Cloudflare site answers here, not the store' : wrong)
      : (ok ? (isCloudflare(v) ? 'Cloudflare proxy' : undefined) : isCloudflare(v) ? 'Cloudflare proxy (not reaching the store)' : wrong)
    records.push({ type: 'A', name, value: v, ok, note })
  }
  for (const v of own ? aaaaValues : []) {
    const ok = isOurs(v) || m.a(v) || (isCloudflare(v) && servedByUs)
    records.push({ type: 'AAAA', name, value: v, ok, note: ok ? (onCloudflare ? 'Points to Fullfilio (ALIAS / flattening)' : 'Cloudflare proxy') : 'Remove: the store has no IPv6 address' })
  }
  // Records the hosting asked for (ownership / certificate): are they there yet?
  const expected = opts.expect ?? []
  const txtAnswers = await Promise.all(expected.map((e) => doh(fetcher, RESOLVERS[0].url, e.name, 'TXT')))
  const missingTxt: ExpectedRecord[] = []
  const staleTxt: string[] = []
  expected.forEach((e, i) => {
    const values = only(txtAnswers[i], 'TXT').map((v) => v.replace(/"/g, '').trim())
    const found = values.some((v) => v.includes(e.value))
    // A record at this name with another value: left over from before the domain was added again.
    const stale = found ? [] : values.filter((v) => v.length > 0)
    if (!found) missingTxt.push(e)
    staleTxt.push(...stale)
    records.push({ type: 'TXT', name: e.name === domain ? name : e.name.replace(new RegExp(`\\.${apexOf(domain).replace(/\./g, '\\.')}$`), ''), value: e.value, ok: found,
      note: found ? 'Found' : stale.length ? `Has an old value (${stale[0]}) — change it to this one` : 'Not found yet — add it at your domain provider' })
  })

  const pointedByDns = answersPoint(kind, a, target) || cnameValues.some(m.cname) || flattened || (proxied && servedByUs)
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

  const issues: DomainIssue[] = []
  // Nameservers: who answers for the domain. Two different companies means half the
  // visitors get one set of records and half the other (old site, then new, then old).
  const nameservers = [...new Set([...only(nsGoogle, 'NS'), ...only(nsCloudflare, 'NS')].map((n) => n.toLowerCase()))].sort()
  const owners = [...new Set(nameservers.map(nsOwner))]
  const dnsHost = { provider: owners.length === 1 ? owners[0] : null, nameservers, mixed: owners.length > 1 }
  if (kind === 'apex' && onCloudflare && dnsHost.provider && CLOUDFLARE_BACKED_DNS.has(dnsHost.provider)) {
    issues.push({ code: 'USE_WWW', severity: 'error', title: `${dnsHost.provider} cannot connect the root domain`,
      detail: `${dnsHost.provider} runs its DNS on Cloudflare, and Cloudflare only connects a domain there through a CNAME record, which the root (@) cannot have at ${dnsHost.provider}. Either keep ${domain} and move its DNS to Cloudflare (free): add the domain at dash.cloudflare.com, set a CNAME for @ to ${target.cname} (DNS only), keep your email records, then change the nameservers at ${dnsHost.provider} to the two Cloudflare gives you. Or connect www.${domain} instead (a CNAME for www to ${target.cname}) and forward ${domain} to it.` })
  }
  if (dnsHost.mixed) {
    issues.push({ code: 'NS_MIXED', severity: 'error', title: 'Your domain uses nameservers from two companies',
      detail: `It lists ${nameservers.join(', ')}. Visitors randomly get the records of one or the other, so the old site keeps coming back. At the company where you bought the domain, set the nameservers to only one company (the one where you edit DNS), then wait an hour.` })
  }
  // Old site still answering somewhere (left-over record, or cached for a while after deleting it).
  // (Only for a name with its own A records: behind a CNAME a wrong target is WRONG_TARGET.)
  const seen = own ? [...aValues, ...regions.filter((r) => !r.ok).flatMap((r) => r.answers), ...resolvers.filter((r) => !r.ok).flatMap((r) => r.answers)] : []
  const oldSeen = [...new Set(seen.map(oldOf).filter((x): x is string => !!x))]
  if (oldSeen.length) {
    const inRecords = aValues.some((v) => oldOf(v))
    issues.push({ code: 'OLD_HOST', severity: inRecords ? 'error' : 'warning', title: `Some visitors still reach ${oldSeen.join(' and ')}`,
      detail: inRecords
        ? `Your DNS still has an A record pointing to ${oldSeen.join(' / ')}. Delete it at your domain provider.`
        : `The old address is no longer in your records but some DNS servers still remember it. It clears by itself within a few hours.${dnsHost.mixed ? '' : ' If it keeps coming back after that, check your nameservers.'}` })
  }
  if (missingTxt.length) {
    issues.push(staleTxt.length ? { code: 'TXT_MISSING', severity: 'error', title: 'Verification record has an old value',
      detail: `The TXT record ${missingTxt.map((t) => t.name.split('.')[0]).join(', ')} still holds ${staleTxt[0]}. The domain was added again, which gives a new code: edit the record and paste the value shown below.` }
      : { code: 'TXT_MISSING', severity: 'error', title: 'Verification record missing',
      detail: `Add the TXT record ${missingTxt.map((t) => t.name.split('.')[0]).join(', ')} shown below at your domain provider. It proves the domain is yours; the store cannot go live without it.` })
  }
  // Nothing answered at all: say so instead of claiming the records are missing.
  const reached = [a, aaaa, cname].some((x) => x !== null)
  if (!reached) {
    issues.push({ code: 'CHECK_FAILED', severity: 'error', title: 'Could not check DNS right now', detail: 'The DNS resolvers did not answer. Try again in a minute.' })
  } else if (!aValues.length && !cnameValues.length) {
    issues.push({ code: 'NO_RECORDS', severity: 'error', title: 'No DNS records found',
      detail: kind === 'apex' && target.a ? `Add an A record for @ pointing to ${target.a} at your domain provider.`
        : kind === 'apex' ? `Add a CNAME (or ALIAS / ANAME) record for @ pointing to ${target.cname}. If your domain provider cannot, use www.${domain} instead.`
        : `Add a CNAME record for ${name} pointing to ${target.cname} at your domain provider.` })
  } else if (!pointedByDns) {
    issues.push({ code: 'WRONG_TARGET', severity: 'error', title: 'DNS records point somewhere else',
      detail: kind === 'apex' && target.a ? `Change the A record for @ to ${target.a} and delete any other A records for @.`
        : kind === 'apex' ? `Point @ at ${target.cname} with a CNAME (or ALIAS / ANAME) record and delete the A and AAAA records for @.`
        : `Change the CNAME record for ${name} to ${target.cname}.` })
  }
  // On Cloudflare a customer's own Cloudflare proxy in front of us works as is.
  if (proxied && !onCloudflare) {
    issues.push({ code: 'CLOUDFLARE_PROXY', severity: servedByUs ? 'warning' : 'error', title: 'Your domain has a Cloudflare proxy',
      detail: servedByUs
        ? 'The store opens through it, but the proxy can delay certificate renewals and cache pages. In Cloudflare, set the record to "DNS only" (grey cloud).'
        : 'The proxy is not passing visitors to the store. In Cloudflare, set the record to "DNS only" (grey cloud).' })
  }
  const strayA = aValues.filter((v) => !m.a(v) && !isCloudflare(v))
  if (own && strayA.length && (aValues.some(m.a) || (onCloudflare && servedByUs))) {
    issues.push({ code: 'EXTRA_A', severity: 'error', title: 'Extra A records',
      detail: `Some visitors will reach ${strayA.join(', ')} instead of the store. Delete those A records.` })
  }
  if (own && aaaaValues.some((v) => !isCloudflare(v) && !m.a(v))) {
    issues.push({ code: 'AAAA', severity: 'warning', title: 'IPv6 (AAAA) records found',
      detail: 'Visitors on IPv6 may reach another server. Delete the AAAA records for this name.' })
  }
  const caaValues = only(caa, 'CAA').concat(only(apexCaa, 'CAA'))
  // Cloudflare issues the certificate through Let's Encrypt or Google Trust Services.
  const allowedCa = onCloudflare ? /letsencrypt\.org|pki\.goog/i : /letsencrypt\.org/i
  if (caaValues.length && !caaValues.some((v) => allowedCa.test(v))) {
    issues.push({ code: 'CAA', severity: 'error', title: 'A CAA record blocks the certificate',
      detail: onCloudflare ? 'Add CAA records allowing letsencrypt.org and pki.goog, or the store cannot get an HTTPS certificate.'
        : 'Add a CAA record allowing letsencrypt.org, or the store cannot get an HTTPS certificate.' })
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
    dns_host: dnsHost,
  }
}

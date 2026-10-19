// Audit of the custom-domain DNS diagnosis against virtual merchant domains: fake DNS-over-HTTPS
// (Google / Cloudflare / AdGuard, by region), RDAP and HTTPS answers only, never the network.
// Each test is named after its scenario and asserts what the merchant SHOULD see: a failing test
// marks a defect, a passing one is regression coverage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  apexOf, cloudflareTarget, diagnose, dnsHostOf, dnsView, domainKind, hostLabel, inspectWww, oldHostOf, proxyTarget, REGIONS,
  type Diagnosis, type ExpectedRecord, type HostingTarget,
} from './domain-check.ts'

type T = 'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'TXT'
const CODE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 } as const
/** One name's records; `status` makes every query for it answer that DNS status (2 SERVFAIL, 3 NXDOMAIN). */
type RR = Partial<Record<T, string[]>> & { status?: number }
type Zone = Record<string, RR>
type Https = 'store' | 'other' | 'cf-error' | 'cert' | 'refused' | 'timeout' | { status: number; store: boolean; location?: string }
interface World {
  /** What the authoritative DNS has (and every resolver, unless `resolvers` says otherwise). */
  zone: Zone
  /** What one resolver still has (its cache), or 'down' when it cannot be reached. */
  resolvers?: Partial<Record<'google' | 'cloudflare' | 'adguard', Zone | 'down'>>
  /** Google's answers for a region's client subnet (a region still on old records). */
  regions?: Record<string, Zone>
  /** The registry (RDAP): its nameservers; null → 404; 'down' → no answer; raw → that body. Default: the apex NS in `zone`. */
  rdap?: string[] | null | 'down' | { raw: unknown }
  changedAt?: string
  /** What https://<domain>/ answers. */
  https?: Https
  /** A raw DoH body for resolver/name/type (odd answers); undefined → from the zone. */
  raw?: (resolver: string, name: string, type: string) => unknown
}

const RESOLVER_HOSTS: Record<string, 'google' | 'cloudflare' | 'adguard'> = { 'dns.google': 'google', 'cloudflare-dns.com': 'cloudflare', 'dns.adguard-dns.com': 'adguard' }

/** Real resolver behaviour: CNAME chains are followed (except for a CNAME query), `*.` wildcards apply, names are case-insensitive. */
function resolveName(zone: Zone, qname: string, type: T) {
  const answer: Array<{ name: string; type: number; TTL: number; data: string }> = []
  let name = qname.toLowerCase().replace(/\.$/, '')
  for (let hop = 0; hop < 8; hop++) {
    const rec = zone[name] ?? zone[name.replace(/^[^.]+/, '*')]
    if (rec?.status) return { status: rec.status, answer: [] }
    if (!rec) break
    if (rec.CNAME && type !== 'CNAME') {
      answer.push({ name: `${name}.`, type: CODE.CNAME, TTL: 300, data: `${rec.CNAME[0]}.` })
      name = rec.CNAME[0].toLowerCase()
      continue
    }
    for (const d of rec[type] ?? []) answer.push({ name: `${name}.`, type: CODE[type], TTL: 300, data: type === 'TXT' ? `"${d}"` : type === 'NS' || type === 'CNAME' ? `${d}.` : d })
    break
  }
  return { status: 0, answer }
}

function probe(h: Https): Response {
  if (h === 'store') return new Response('<html>store</html>', { headers: { 'x-fullfilio': 'store', 'content-type': 'text/html' } })
  if (h === 'other') return new Response('<html>parked</html>', { headers: { server: 'nginx' } })
  if (h === 'cf-error') return new Response('error code: 525', { status: 525, headers: { server: 'cloudflare' } })
  if (h === 'cert') throw new TypeError('error sending request for url (https://x/): client error (Connect): invalid peer certificate: UnknownIssuer')
  if (h === 'refused') throw new TypeError('error sending request for url (https://x/): client error (Connect): tcp connect error: Connection refused (os error 111)')
  if (h === 'timeout') throw new DOMException('Signal timed out.', 'TimeoutError')
  return new Response(null, { status: h.status, headers: { ...(h.store ? { 'x-fullfilio': 'store' } : { server: 'cloudflare' }), ...(h.location ? { location: h.location } : {}) } })
}

function world(w: World) {
  const probes: string[] = []
  const rdapAsked: string[] = []
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input))
    const resolver = RESOLVER_HOSTS[url.hostname]
    if (url.hostname === 'rdap.org') {
      const apex = decodeURIComponent(url.pathname.replace('/domain/', '')).toLowerCase()
      rdapAsked.push(apex)
      const r = w.rdap === undefined ? (w.zone[apex]?.NS ?? null) : w.rdap
      if (r === 'down') throw new TypeError('fetch failed: rdap.org timed out')
      if (r === null) return new Response('{"errorCode":404,"title":"Not Found"}', { status: 404 })
      if (!Array.isArray(r)) return typeof r.raw === 'string' ? new Response(r.raw) : Response.json(r.raw)
      return Response.json({
        objectClassName: 'domain', ldhName: apex.toUpperCase(),
        nameservers: r.map((n) => ({ objectClassName: 'nameserver', ldhName: n.toUpperCase() })),
        events: w.changedAt ? [{ eventAction: 'last changed', eventDate: w.changedAt }] : [],
      })
    }
    if (resolver) {
      const name = url.searchParams.get('name')!
      const type = url.searchParams.get('type') as T
      const raw = w.raw?.(resolver, name.toLowerCase(), type)
      if (raw !== undefined) return typeof raw === 'string' ? new Response(raw) : Response.json(raw)
      const z = w.resolvers?.[resolver] ?? w.zone
      if (z === 'down') throw new TypeError('fetch failed: connect ETIMEDOUT')
      const subnet = url.searchParams.get('edns_client_subnet')
      const zone = (resolver === 'google' && subnet && w.regions?.[subnet]) || z
      const { status, answer } = resolveName(zone, name, type)
      return Response.json({ Status: status, TC: false, RD: true, RA: true, Question: [{ name, type: CODE[type] }], ...(answer.length ? { Answer: answer } : {}) })
    }
    if (url.protocol === 'https:' && url.pathname === '/') {
      probes.push(url.hostname)
      return probe(w.https ?? 'store')
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  return { fetcher, probes, rdapAsked }
}

const NOW = new Date('2026-10-19T12:00:00Z')
const IP = '144.24.232.70'
const PROXY = proxyTarget(IP, 'stores.fullfilio.com')
const CF = cloudflareTarget('stores.fullfilio.com')
const STORES: Zone = { 'stores.fullfilio.com': { A: ['104.21.80.10', '172.67.140.20'], AAAA: ['2606:4700:3030::6815:500a'] } }
const NS = {
  hostinger: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
  cloudflare: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  cloudflare2: ['lola.ns.cloudflare.com', 'max.ns.cloudflare.com'],
  namecheap: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'],
  godaddy: ['ns45.domaincontrol.com', 'ns46.domaincontrol.com'],
  porkbun: ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com'],
  wix: ['ns0.wixdns.net', 'ns1.wixdns.net'],
  squarespace: ['dns1.squarespacedns.com', 'dns2.squarespacedns.com'],
  local: ['ns1.exonhost.com', 'ns2.exonhost.com'],
}
/** A root on the proxy at `ns` with www as a CNAME to it (the textbook setup); `apex`/`www` change one thing at a time. */
const rootZone = (d: string, ns: string[], apex: RR = {}, www: RR | null = { CNAME: [d] }): Zone => ({
  ...STORES,
  [d]: { A: [IP], NS: ns, ...apex },
  ...(www ? { [`www.${d}`]: www } : {}),
})
/** A subdomain's zone on the Cloudflare target: the apex only carries the nameservers. */
const subZone = (d: string, ns: string[], rec: RR): Zone => ({ ...STORES, [apexOf(d)]: { NS: ns }, [d]: rec })

/**
 * handler.ts inspectRoot, offline: one DNS view for both checks, the www rows and issue appended,
 * then the status and the one-line detail the panel shows (the first error's title).
 */
async function root(domain: string, w: World, target: HostingTarget = PROXY) {
  const f = world(w)
  const view = await dnsView(domain, f.fetcher, NOW)
  const [d, www] = await Promise.all([diagnose(domain, { target, view, fetcher: f.fetcher, now: NOW }), inspectWww(domain, target, f.fetcher, view)])
  if (www) {
    d.records.push(...www.records)
    if (www.issue) d.issues.push(www.issue)
  }
  const active = d.pointed && d.tls.ok && d.tls.served_by_store === true
  const blocking = d.issues.find((i) => i.severity === 'error')
  const line = active ? 'Live — the store opens on this domain with HTTPS'
    : blocking ? blocking.title
    : !d.pointed ? 'Waiting for the A record below (changes can take up to a few hours)'
    : 'DNS is right — the HTTPS certificate is issued on the first visit (usually under a minute)'
  return Object.assign(d, { status: active ? 'ACTIVE' : 'VERIFYING', line, probes: f.probes, view, rdapAsked: f.rdapAsked })
}
/** handler.ts inspectCloudflare's diagnosis of a subdomain (no shared view: diagnose asks for its own). */
async function sub(domain: string, w: World, expectTxt: ExpectedRecord[] = []) {
  const f = world(w)
  const d = await diagnose(domain, { target: CF, expect: expectTxt, fetcher: f.fetcher, now: NOW })
  return Object.assign(d, { probes: f.probes, rdapAsked: f.rdapAsked })
}
const codes = (d: Diagnosis) => d.issues.map((i) => [i.code, i.severity])
const errors = (d: Diagnosis) => d.issues.filter((i) => i.severity === 'error')

// Nothing here may reach the real network: diagnose() falls back to the global fetch when no fetcher is given.
const realFetch = globalThis.fetch
beforeAll(() => { globalThis.fetch = (async (input: string | URL) => { throw new Error(`real network used: ${String(input)}`) }) as typeof fetch })
afterAll(() => { globalThis.fetch = realFetch })

describe('names: apex, kind and record label for every TLD', () => {
  it.each([
    ['shop.com', 'shop.com', 'apex', '@'],
    ['shop.com.bd', 'shop.com.bd', 'apex', '@'],
    ['www.shop.com.bd', 'shop.com.bd', 'subdomain', 'www'],
    ['shop.net.bd', 'shop.net.bd', 'apex', '@'],
    ['shop.co.uk', 'shop.co.uk', 'apex', '@'],
    ['www.shop.co.uk', 'shop.co.uk', 'subdomain', 'www'],
    ['shop.com.au', 'shop.com.au', 'apex', '@'],
    ['myshop.shop', 'myshop.shop', 'apex', '@'],
    ['www.myshop.store', 'myshop.store', 'subdomain', 'www'],
    ['xn--80ak6aa92e.com', 'xn--80ak6aa92e.com', 'apex', '@'],
    ['shop.xn--80ak6aa92e.com', 'xn--80ak6aa92e.com', 'subdomain', 'shop'],
    ['xn--p5b7ah1gxc.xn--54b7fta0cc', 'xn--p5b7ah1gxc.xn--54b7fta0cc', 'apex', '@'],
    ['a.b.shop.com', 'shop.com', 'subdomain', 'a.b'],
  ])('%s → apex %s, %s, label %s', (d, apex, kind, label) => {
    expect([apexOf(d), domainKind(d), hostLabel(d)]).toEqual([apex, kind, label])
  })

  it.each([
    ['shop.me.uk', 'shop.me.uk', 'apex', '@'],
    ['www.shop.ltd.uk', 'shop.ltd.uk', 'subdomain', 'www'],
    ['shop.ne.jp', 'shop.ne.jp', 'apex', '@'],
  ])('country second level outside com/net/org/co: %s → apex %s, %s, label %s', (d, apex, kind, label) => {
    expect([apexOf(d), domainKind(d), hostLabel(d)]).toEqual([apex, kind, label])
  })

  it('trailing dot (shop.com. / www.shop.com.) is the same name as without it', () => {
    expect.soft(domainKind('shop.com.')).toBe('apex')
    expect.soft(apexOf('www.shop.com.')).toBe('shop.com')
    expect.soft(hostLabel('www.shop.com.')).toBe('www')
  })

  it('names the DNS companies of every registrar in the scenarios', () => {
    expect(Object.fromEntries(Object.entries(NS).map(([k, ns]) => [k, dnsHostOf(ns[0])]))).toEqual({
      hostinger: 'Hostinger', cloudflare: 'Cloudflare', cloudflare2: 'Cloudflare', namecheap: 'Namecheap', godaddy: 'GoDaddy',
      porkbun: 'Porkbun', wix: 'Wix', squarespace: 'Squarespace', local: null,
    })
  })
})

describe('Hostinger (root on the proxy)', () => {
  it('hostinger-live.com: A @ to the proxy + CNAME www → root is live everywhere with nothing to fix', async () => {
    const d = await root('hostinger-live.com', { zone: rootZone('hostinger-live.com', NS.hostinger) })
    expect(d.status).toBe('ACTIVE')
    expect(d.live_everywhere).toBe(true)
    expect(d.issues).toEqual([])
    expect(d.dns_host).toEqual({ provider: 'Hostinger', nameservers: NS.hostinger, mixed: false })
    expect(d.records).toEqual([
      { type: 'A', name: '@', value: IP, ok: true, note: undefined },
      { type: 'CNAME', name: 'www', value: 'hostinger-live.com', ok: true, note: 'Leads to the store through hostinger-live.com' },
    ])
  })

  it('hostinger-parked.com: parking A 2.57.91.91 left next to the right A says to delete it (not "change it")', async () => {
    const d = await root('hostinger-parked.com', { zone: rootZone('hostinger-parked.com', NS.hostinger, { A: [IP, '2.57.91.91'] }) })
    expect(d.pointed).toBe(false)
    expect(d.status).toBe('VERIFYING')
    expect(d.records.slice(0, 2).map((r) => [r.value, r.ok])).toEqual([[IP, true], ['2.57.91.91', false]])
    expect(codes(d)).toContainEqual(['EXTRA_A', 'error'])
    expect.soft(d.records[1].note).toMatch(/delete/i)
    expect.soft(d.records[1].note).not.toMatch(/change it to/i)
    const old = d.issues.find((i) => i.code === 'OLD_HOST')!
    expect.soft(old.detail).not.toMatch(/Change it to 144/)
  })

  it('hostinger-v6.com: parking AAAA left while the certificate fails is an error naming AAAA @ and Hostinger, not "certificate on the way"', async () => {
    const d = await root('hostinger-v6.com', { zone: rootZone('hostinger-v6.com', NS.hostinger, { AAAA: ['2a02:4780:11:1084::1'] }), https: 'cert' })
    expect(d.pointed).toBe(true)
    expect(d.records[1]).toMatchObject({ type: 'AAAA', name: '@', ok: false })
    const v6 = d.issues.find((i) => i.code === 'AAAA')!
    // Let's Encrypt validates over IPv6 first: an AAAA to another server blocks (and later fails to renew) the certificate.
    expect.soft(v6.severity).toBe('error')
    expect.soft(v6.detail).toContain('@')
    expect.soft(v6.detail).toContain('Hostinger')
    expect.soft(d.issues.map((i) => i.code)).not.toContain('TLS_PENDING')
    expect.soft(d.line).not.toMatch(/^DNS is right/)
  })

  it('hostinger-www-cname.com: www CNAME to the root is fine', async () => {
    const d = await root('hostinger-www-cname.com', { zone: rootZone('hostinger-www-cname.com', NS.hostinger) })
    expect(d.records[1]).toMatchObject({ type: 'CNAME', name: 'www', value: 'hostinger-www-cname.com', ok: true })
    expect(d.issues.map((i) => i.code)).not.toContain('WWW_SETUP')
  })

  it('hostinger-no-www.com: www missing asks for A www (a warning) and never holds the root back', async () => {
    const d = await root('hostinger-no-www.com', { zone: rootZone('hostinger-no-www.com', NS.hostinger, {}, null) })
    expect(d.status).toBe('ACTIVE')
    expect(d.issues).toEqual([expect.objectContaining({ code: 'WWW_SETUP', severity: 'warning', title: 'www.hostinger-no-www.com is not set up yet' })])
    expect(d.issues[0].detail).toContain(`Add an A record for www pointing to ${IP}`)
    expect(d.records[1]).toMatchObject({ type: 'A', name: 'www', value: '—', ok: false })
  })

  it('hostinger-follow.com: www CNAME to a root that is still parked is not told to replace its (correct) CNAME', async () => {
    const zone = rootZone('hostinger-follow.com', NS.hostinger, { A: ['2.57.91.91'] })
    const www = await inspectWww('hostinger-follow.com', PROXY, world({ zone }).fetcher)
    expect(www!.records[0]).toMatchObject({ type: 'CNAME', name: 'www', value: 'hostinger-follow.com' })
    expect.soft(www!.records[0].note ?? '').not.toMatch(/Should be A/)
    expect.soft(www!.issue?.detail ?? '').not.toMatch(/Replace it/)
  })

  it('hostinger-www2.com: www with the right A plus the parking A says to delete 2.57.91.91, not to replace it with what it has', async () => {
    const zone = rootZone('hostinger-www2.com', NS.hostinger, {}, { A: [IP, '2.57.91.91'] })
    const www = await inspectWww('hostinger-www2.com', PROXY, world({ zone }).fetcher)
    expect(www!.records.map((r) => [r.value, r.ok])).toEqual([[IP, true], ['2.57.91.91', false]])
    expect.soft(www!.issue!.detail).toMatch(/delete/i)
    expect.soft(www!.issue!.detail).not.toMatch(new RegExp(`Replace it with an A record for www pointing to ${IP}`))
  })

  it('wild-root.com: a wildcard *.wild-root.com to the parking page answering for www is flagged', async () => {
    const zone: Zone = { ...rootZone('wild-root.com', NS.hostinger, {}, null), '*.wild-root.com': { A: ['2.57.91.91'] } }
    const www = await inspectWww('wild-root.com', PROXY, world({ zone }).fetcher)
    expect(www!.records).toEqual([expect.objectContaining({ type: 'A', name: 'www', value: '2.57.91.91', ok: false })])
    expect(www!.issue).toMatchObject({ code: 'WWW_SETUP', severity: 'warning' })
  })
})

describe('leftovers from Namecheap, GoDaddy, Porkbun, Wix, Squarespace and Shopify', () => {
  it('GoDaddy parking / forwarding addresses 34.102.136.180, 15.197.142.173, 3.33.152.147 are recognised', () => {
    for (const ip of ['34.102.136.180', '15.197.142.173', '3.33.152.147']) expect.soft(oldHostOf(ip) ?? `${ip} not recognised`).toMatch(/GoDaddy/)
  })

  it('godaddy-parked.com: GoDaddy "Parked" A next to the right A is named', async () => {
    const d = await root('godaddy-parked.com', { zone: rootZone('godaddy-parked.com', NS.godaddy, { A: [IP, '34.102.136.180'] }) })
    expect(d.dns_host?.provider).toBe('GoDaddy')
    expect(codes(d)).toContainEqual(['EXTRA_A', 'error'])
    expect.soft(d.records[1].note).toMatch(/GoDaddy/)
    expect.soft(d.issues.map((i) => i.title).join(' | ')).toMatch(/GoDaddy/)
  })

  it('godaddy-forward.com: domain forwarding still on (15.197.142.173 + 3.33.152.147) is named as GoDaddy', async () => {
    const d = await root('godaddy-forward.com', { zone: rootZone('godaddy-forward.com', NS.godaddy, { A: ['15.197.142.173', '3.33.152.147'] }), https: 'other' })
    expect(d.pointed).toBe(false)
    expect.soft(d.issues[0]).toMatchObject({ code: 'OLD_HOST', severity: 'error' })
    expect.soft(d.line).toMatch(/GoDaddy/)
  })

  it('namecheap-parked.com: Namecheap parking CNAME left on www is listed with what to change', async () => {
    const zone: Zone = { ...rootZone('namecheap-parked.com', NS.namecheap, {}, { CNAME: ['parkingpage.namecheap.com'] }), 'parkingpage.namecheap.com': { A: ['198.54.117.199'] } }
    const d = await root('namecheap-parked.com', { zone })
    expect(d.dns_host?.provider).toBe('Namecheap')
    expect(d.status).toBe('ACTIVE')
    expect(d.records[1]).toMatchObject({ type: 'CNAME', name: 'www', value: 'parkingpage.namecheap.com', ok: false })
    expect(d.issues.find((i) => i.code === 'WWW_SETUP')!.detail).toContain('has a CNAME to parkingpage.namecheap.com')
  })

  it('old-shopify.com: only A @ 23.227.38.65 on Namecheap says it still points to Shopify, change it, at Namecheap', async () => {
    const d = await root('old-shopify.com', { zone: rootZone('old-shopify.com', NS.namecheap, { A: ['23.227.38.65'] }, { CNAME: ['shops.myshopify.com'] }), https: 'other' })
    expect(d.records[0]).toMatchObject({ value: '23.227.38.65', ok: false, note: `Still points to Shopify — change it to ${IP}` })
    expect(d.issues[0]).toMatchObject({ code: 'OLD_HOST', severity: 'error', detail: `Your DNS still has an A record for @ pointing to Shopify. Change it to ${IP} at Namecheap.` })
    expect(d.issues.map((i) => i.code)).toContain('WRONG_TARGET')
  })

  it('old-shopify.com: the status line does not say "some visitors" when every visitor still reaches Shopify', async () => {
    const d = await root('old-shopify.com', { zone: rootZone('old-shopify.com', NS.namecheap, { A: ['23.227.38.65'] }), https: 'other' })
    expect(d.line).not.toMatch(/^Some visitors/)
  })

  it('wix-left.com: Wix A records with DNS still at Wix are named, change them at Wix', async () => {
    const d = await root('wix-left.com', { zone: rootZone('wix-left.com', NS.wix, { A: ['185.230.63.171', '185.230.63.186'] }), https: 'other' })
    expect(d.dns_host?.provider).toBe('Wix')
    expect(d.issues[0]).toMatchObject({ code: 'OLD_HOST', severity: 'error', title: expect.stringContaining('Wix') })
    expect(d.issues[0].detail).toMatch(/at Wix\.$/)
  })

  it('squarespace-left.com: four Squarespace A records next to the right one are named and deleted (not changed)', async () => {
    const sq = ['198.185.159.144', '198.185.159.145', '198.49.23.144', '198.49.23.145']
    const d = await root('squarespace-left.com', { zone: rootZone('squarespace-left.com', NS.squarespace, { A: [IP, ...sq] }) })
    expect(d.dns_host?.provider).toBe('Squarespace')
    expect(d.issues.find((i) => i.code === 'EXTRA_A')!.detail).toContain(sq.join(', '))
    expect(d.issues.find((i) => i.code === 'OLD_HOST')!.title).toBe('Some visitors still reach Squarespace')
    expect.soft(d.records.filter((r) => sq.includes(r.value)).map((r) => r.note)).toEqual(sq.map(() => expect.not.stringMatching(/change it to/i)))
  })

  it('porkbun-alias.com: Porkbun default ALIAS to its parking host says to set A @ to the proxy, at Porkbun', async () => {
    const d = await root('porkbun-alias.com', { zone: rootZone('porkbun-alias.com', NS.porkbun, { A: ['44.227.65.245'] }), https: 'other' })
    expect(d.dns_host?.provider).toBe('Porkbun')
    expect(d.issues[0]).toMatchObject({ code: 'WRONG_TARGET', severity: 'error', title: 'DNS records point somewhere else' })
    expect(d.issues[0].detail).toContain(IP)
  })

  it('vercel-left.com: an old Vercel A record is named', async () => {
    const d = await root('vercel-left.com', { zone: rootZone('vercel-left.com', NS.namecheap, { A: ['76.76.21.21'] }), https: 'other' })
    expect(d.issues[0]).toMatchObject({ code: 'OLD_HOST', severity: 'error', title: expect.stringContaining('Vercel') })
  })
})

describe('Cloudflare DNS', () => {
  const orange = { A: ['104.21.33.10', '172.67.150.20'], AAAA: ['2606:4700:3031::6815:210a'] }

  it('cf-grey.com: A @ to the proxy, DNS only (grey), on Cloudflare DNS is live', async () => {
    const d = await root('cf-grey.com', { zone: rootZone('cf-grey.com', NS.cloudflare) })
    expect(d.status).toBe('ACTIVE')
    expect(d.issues).toEqual([])
    expect(d.dns_host?.provider).toBe('Cloudflare')
  })

  it('cf-orange.com: A @ to the proxy but proxied (orange) and failing says to turn the proxy off, not "change the A record to 144…"', async () => {
    const d = await root('cf-orange.com', { zone: { ...STORES, 'cf-orange.com': { ...orange, NS: NS.cloudflare } }, https: 'cf-error' })
    expect(d.pointed).toBe(false)
    expect(d.issues.some((i) => /DNS only/.test(i.detail))).toBe(true)
    expect.soft(d.issues[0].code).not.toBe('WRONG_TARGET')
    expect.soft(d.issues[0].detail).toMatch(/DNS only/)
    expect.soft(d.records.filter((r) => r.name === '@').map((r) => r.note)).toEqual([0, 1, 2].map(() => expect.stringMatching(/orange cloud|Cloudflare proxy/i)))
  })

  it('cf-orange-ok.com: proxied (orange) but the store opens through it is live, with a proxy warning', async () => {
    const d = await root('cf-orange-ok.com', { zone: { ...STORES, 'cf-orange-ok.com': { ...orange, NS: NS.cloudflare }, 'www.cf-orange-ok.com': { CNAME: ['cf-orange-ok.com'] } } })
    expect(d.status).toBe('ACTIVE')
    expect(d.pointed).toBe(true)
    expect(errors(d)).toEqual([])
    expect(codes(d)).toContainEqual(['CLOUDFLARE_PROXY', 'warning'])
  })

  it('cf-www-orange.com: www proxied (orange) next to a correct root says to set www to DNS only, not "Should be A 144…"', async () => {
    const zone = rootZone('cf-www-orange.com', NS.cloudflare, {}, { A: ['104.21.40.1', '172.67.160.2'] })
    const f = world({ zone })
    const view = await dnsView('cf-www-orange.com', f.fetcher, NOW)
    const www = await inspectWww('cf-www-orange.com', PROXY, f.fetcher, view)
    expect(www!.issue).toMatchObject({ code: 'WWW_SETUP' })
    expect.soft(www!.records[0].note).toMatch(/orange cloud|Cloudflare proxy/i)
    expect.soft(www!.issue!.detail).toMatch(/DNS only/)
  })

  it('cf-flat.com: an old CNAME @ → stores.fullfilio.com flattened by Cloudflare says to replace that CNAME/ALIAS with A @', async () => {
    const t = STORES['stores.fullfilio.com']
    const d = await root('cf-flat.com', { zone: { ...STORES, 'cf-flat.com': { A: t.A, AAAA: t.AAAA, NS: NS.cloudflare } }, https: 'cf-error' })
    expect(d.pointed).toBe(false)
    expect(errors(d)[0].detail).toContain(IP)
    expect.soft(errors(d)[0].detail).toMatch(/CNAME|ALIAS/)
  })

  it('cf-saas-flat.com (Cloudflare target): CNAME flattening at the root to our target is pointed', async () => {
    const t = STORES['stores.fullfilio.com']
    const d = await sub('cf-saas-flat.com', { zone: { ...STORES, 'cf-saas-flat.com': { A: t.A, AAAA: t.AAAA, NS: NS.cloudflare } } })
    expect(d.pointed).toBe(true)
    expect(d.issues).toEqual([])
  })

  it('shop.cf-sub-orange.com (Cloudflare target): subdomain proxied in the merchant\'s own Cloudflare says turn the orange cloud off', async () => {
    const d = await sub('shop.cf-sub-orange.com', { zone: subZone('shop.cf-sub-orange.com', NS.cloudflare, orange), https: 'cf-error' })
    expect(d.issues[0]).toMatchObject({ code: 'ORANGE_CLOUD', severity: 'error', title: 'Turn off the orange cloud in Cloudflare' })
    expect(d.issues[0].detail).toContain('edit the shop record: it must be a CNAME to stores.fullfilio.com')
  })
})

describe('subdomains on the Cloudflare target', () => {
  it('shop.sub-ok.com: CNAME to stores.fullfilio.com is pointed and live everywhere', async () => {
    const d = await sub('shop.sub-ok.com', { zone: subZone('shop.sub-ok.com', NS.hostinger, { CNAME: ['stores.fullfilio.com'] }) })
    expect(d.pointed).toBe(true)
    expect(d.live_everywhere).toBe(true)
    expect(d.records).toEqual([{ type: 'CNAME', name: 'shop', value: 'stores.fullfilio.com', ok: true, note: undefined }])
    expect(d.issues).toEqual([])
  })

  it('shop.sub-wrong.com: CNAME still to shops.myshopify.com says to change the CNAME', async () => {
    const d = await sub('shop.sub-wrong.com', { zone: { ...subZone('shop.sub-wrong.com', NS.hostinger, { CNAME: ['shops.myshopify.com'] }), 'shops.myshopify.com': { A: ['23.227.38.74'] } }, https: 'other' })
    expect(d.records[0]).toMatchObject({ ok: false, note: 'Should be stores.fullfilio.com' })
    expect(d.issues[0]).toMatchObject({ code: 'WRONG_TARGET', detail: 'Change the CNAME record for shop to stores.fullfilio.com.' })
  })

  it('shop.sub-a.com: an A record instead of a CNAME is told to replace the A record, not to "change the CNAME"', async () => {
    const d = await sub('shop.sub-a.com', { zone: subZone('shop.sub-a.com', NS.hostinger, { A: ['45.33.10.10'] }), https: 'other' })
    expect(d.records[0]).toMatchObject({ type: 'A', ok: false, note: 'Use a CNAME (or ALIAS) to stores.fullfilio.com instead' })
    expect.soft(d.issues.find((i) => i.code === 'WRONG_TARGET')!.detail).toMatch(/A record/)
  })

  const txt = (d: string, value: string): ExpectedRecord[] => [{ type: 'TXT', name: `_cf-custom-hostname.${d}`, value }]
  it('shop.sub-txt.com: ownership TXT found, then stale after re-adding', async () => {
    const zone: Zone = { ...subZone('shop.sub-txt.com', NS.hostinger, { CNAME: ['stores.fullfilio.com'] }), '_cf-custom-hostname.shop.sub-txt.com': { TXT: ['5f1c-old'] } }
    const ok = await sub('shop.sub-txt.com', { zone }, txt('shop.sub-txt.com', '5f1c-old'))
    expect(ok.records[1]).toEqual({ type: 'TXT', name: '_cf-custom-hostname.shop', value: '5f1c-old', ok: true, note: 'Found' })
    expect(ok.issues).toEqual([])
    const stale = await sub('shop.sub-txt.com', { zone }, txt('shop.sub-txt.com', '9a2e-new'))
    expect(stale.records[1]).toMatchObject({ ok: false, note: 'Has an old value (5f1c-old) — change it to this one' })
    expect(stale.issues[0]).toMatchObject({ code: 'TXT_MISSING', title: 'Verification record has an old value' })
  })

  it('shop.sub-txt.com: a missing ownership TXT names the record as it must be added (_cf-custom-hostname.shop)', async () => {
    const d = await sub('shop.sub-txt.com', { zone: subZone('shop.sub-txt.com', NS.hostinger, { CNAME: ['stores.fullfilio.com'] }) }, txt('shop.sub-txt.com', '9a2e-new'))
    expect(d.records[1]).toMatchObject({ type: 'TXT', name: '_cf-custom-hostname.shop', ok: false })
    expect(d.issues.find((i) => i.code === 'TXT_MISSING')!.detail).toMatch(/_cf-custom-hostname\.shop\b/)
  })

  it('a.b.deep-shop.com: deep subdomain uses label a.b everywhere and asks RDAP for the apex', async () => {
    const ok = await sub('a.b.deep-shop.com', { zone: subZone('a.b.deep-shop.com', NS.hostinger, { CNAME: ['stores.fullfilio.com'] }) }, txt('a.b.deep-shop.com', 'x1'))
    expect(ok.kind).toBe('subdomain')
    expect(ok.records.map((r) => [r.type, r.name, r.ok])).toEqual([['CNAME', 'a.b', true], ['TXT', '_cf-custom-hostname.a.b', false]])
    expect(ok.rdapAsked).toEqual(['deep-shop.com'])
    const none = await sub('x.y.deep-shop.com', { zone: subZone('a.b.deep-shop.com', NS.hostinger, {}) })
    expect(none.issues[0]).toMatchObject({ code: 'NO_RECORDS', detail: 'Add a CNAME record for x.y pointing to stores.fullfilio.com at your domain provider.' })
  })

  it('shop.wild-shop.com: a wildcard *.wild-shop.com CNAME to our target counts', async () => {
    const d = await sub('shop.wild-shop.com', { zone: { ...STORES, 'wild-shop.com': { NS: NS.namecheap }, '*.wild-shop.com': { CNAME: ['stores.fullfilio.com'] } } })
    expect(d.pointed).toBe(true)
    expect(d.issues).toEqual([])
  })
})

describe('country and other TLDs', () => {
  it('shop.com.bd: no RDAP for .bd (404), DNS at a local host: live, provider named by its own domain', async () => {
    const d = await root('shop.com.bd', { zone: rootZone('shop.com.bd', NS.local), rdap: null })
    expect(d.rdapAsked).toEqual(['shop.com.bd'])
    expect(d.kind).toBe('apex')
    expect(d.status).toBe('ACTIVE')
    expect(d.issues).toEqual([])
    expect(d.dns_host).toEqual({ provider: 'exonhost.com', nameservers: NS.local, mixed: false })
  })

  it('www.shop.co.uk (Cloudflare target): reads the CAA of the apex shop.co.uk', async () => {
    const zone: Zone = { ...subZone('www.shop.co.uk', NS.namecheap, { CNAME: ['stores.fullfilio.com'] }), 'shop.co.uk': { NS: NS.namecheap, CAA: ['0 issue "digicert.com"'] } }
    const d = await sub('www.shop.co.uk', { zone })
    expect(d.records[0]).toMatchObject({ name: 'www', ok: true })
    expect(d.issues.map((i) => i.code)).toEqual(['CAA'])
  })

  it.each(['xn--80ak6aa92e.com', 'myshop.shop', 'myshop.store', 'xn--p5b7ah1gxc.xn--54b7fta0cc'])('%s: IDN and new TLD roots connect like .com', async (domain) => {
    const d = await root(domain, { zone: rootZone(domain, NS.hostinger) })
    expect([d.kind, d.status, d.issues]).toEqual(['apex', 'ACTIVE', []])
  })
})

describe('input forms', () => {
  it('UPPER-CASE.COM: typed in capitals gives the same diagnosis as lower case (only the echoed name keeps its case)', async () => {
    const zone = rootZone('upper-case.com', NS.hostinger, { A: [IP, '2.57.91.91'] })
    const strip = ({ checked_at: _c, probes: _p, view: _v, rdapAsked: _r, ...d }: Awaited<ReturnType<typeof root>>) => JSON.stringify(d).toLowerCase()
    expect(strip(await root('UPPER-CASE.COM', { zone }))).toEqual(strip(await root('upper-case.com', { zone })))
    expect((await root('UPPER-CASE.COM', { zone: rootZone('upper-case.com', NS.hostinger) })).status).toBe('ACTIVE')
  })

  it('v6-store.com: an IPv6 proxy target accepts the right AAAA without calling it a Cloudflare proxy, and names it when wrong', async () => {
    const V6 = '2603:c020:8010:7e00::70'
    const target = proxyTarget(IP, 'stores.fullfilio.com', V6)
    const right = await root('v6-store.com', { zone: rootZone('v6-store.com', NS.hostinger, { AAAA: [V6] }) }, target)
    expect(right.records[1]).toMatchObject({ type: 'AAAA', value: V6, ok: true })
    expect(right.issues).toEqual([])
    expect.soft(right.records[1].note ?? '').not.toMatch(/Cloudflare/)
    const wrong = await root('v6-wrong.com', { zone: rootZone('v6-wrong.com', NS.hostinger, { AAAA: ['2a02:4780:11:1084::1'] }) }, target)
    expect(wrong.records[1]).toMatchObject({ type: 'AAAA', ok: false })
    expect.soft(wrong.records[1].note).toContain(V6)
    expect.soft(wrong.issues.find((i) => i.code === 'AAAA')?.detail).toContain(V6)
  })

  describe('the domain typed into the panel (handler validation; no sign-in → 401 once the domain is accepted)', () => {
    const status = async (domain: string) => {
      const { default: handler } = await import('../domains/handler.ts')
      const res = await handler(new Request('https://project.supabase.co/functions/v1/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check', domain }),
      }))
      return res.status
    }
    it('accepts SHOP.COM and https://Shop.com/products', async () => {
      expect(await status('SHOP.COM')).toBe(401)
      expect(await status('https://Shop.com/products')).toBe(401)
    })
    it('accepts a trailing dot (shop.com.) and an IDN country TLD (দোকান.বাংলা = xn--p5b7ah1gxc.xn--54b7fta0cc)', async () => {
      expect.soft(await status('shop.com.')).toBe(401)
      expect.soft(await status('xn--p5b7ah1gxc.xn--54b7fta0cc')).toBe(401)
    })
  })
})

describe('resolvers and regions', () => {
  it('resolvers-disagree.com: Cloudflare\'s resolver still has the Hostinger parking IP → live, "clears by itself"', async () => {
    const zone = rootZone('resolvers-disagree.com', NS.hostinger)
    const d = await root('resolvers-disagree.com', { zone, resolvers: { cloudflare: rootZone('resolvers-disagree.com', NS.hostinger, { A: ['2.57.91.91'] }) } })
    expect(d.status).toBe('ACTIVE')
    expect(d.live_everywhere).toBe(false)
    expect(d.resolvers.map((r) => r.ok)).toEqual([true, false, true])
    expect(d.issues.filter((i) => i.severity !== 'info')).toEqual([expect.objectContaining({ code: 'OLD_HOST', severity: 'warning', title: 'Some visitors still reach Hostinger (website or parking page)' })])
    expect(d.issues.find((i) => i.code === 'OLD_HOST')!.detail).toMatch(/clears by itself/)
  })

  it('resolver-lag.com: one resolver still has an unknown old IP → not live everywhere, and the panel says why', async () => {
    const d = await root('resolver-lag.com', { zone: rootZone('resolver-lag.com', NS.hostinger), resolvers: { cloudflare: rootZone('resolver-lag.com', NS.hostinger, { A: ['93.184.216.34'] }) } })
    expect(d.live_everywhere).toBe(false)
    expect.soft(d.issues.map((i) => i.code)).toContain('PROPAGATING')
  })

  it('adguard-down.com: AdGuard\'s resolver unreachable while everything else is right still counts as live everywhere', async () => {
    const d = await root('adguard-down.com', { zone: rootZone('adguard-down.com', NS.hostinger), resolvers: { adguard: 'down' } })
    expect(d.status).toBe('ACTIVE')
    expect(d.issues).toEqual([])
    expect.soft(d.live_everywhere).toBe(true)
  })

  it('regions-spreading.com: Europe and Asia still on the old IP → propagating, 4 of 6 regions', async () => {
    const old = rootZone('regions-spreading.com', NS.hostinger, { A: ['93.184.216.34'] })
    const regions = { [REGIONS[2].subnet]: old, [REGIONS[4].subnet]: old }
    const d = await root('regions-spreading.com', { zone: rootZone('regions-spreading.com', NS.hostinger), regions })
    expect(d.status).toBe('ACTIVE')
    expect(d.regions.filter((r) => !r.ok).map((r) => r.name)).toEqual(['Europe', 'Asia'])
    expect(d.issues).toEqual([expect.objectContaining({ code: 'PROPAGATING', severity: 'info', detail: expect.stringContaining('4 of 6 regions') })])
  })

  it('all-down.com: every resolver, RDAP and HTTPS down → only "Could not check DNS right now"', async () => {
    const d = await root('all-down.com', { zone: {}, resolvers: { google: 'down', cloudflare: 'down', adguard: 'down' }, rdap: 'down', https: 'refused' })
    expect(codes(d)).toEqual([['CHECK_FAILED', 'error']])
    expect(d.line).toBe('Could not check DNS right now')
    expect(d.dns_host).toEqual({ provider: null, nameservers: [], mixed: false })
    expect(d.records).toEqual([])
  })

  it.each<[string, World['rdap']]>([
    ['rdap down', 'down'],
    ['rdap 404', null],
    ['rdap nameservers not a list', { raw: { nameservers: 'ns1.dns-parking.com', events: 5 } }],
    ['rdap HTML rate-limit page', { raw: '<html>429 Too Many Requests</html>' }],
    ['rdap null body', { raw: null }],
    ['rdap junk entries', { raw: { nameservers: [{ ldhName: null }, {}, 5], events: [{ eventAction: 'last changed', eventDate: 'yesterday' }] } }],
  ])('rdap-odd.com (%s): falls back to the resolvers\' nameservers, no crash, no switch', async (_label, rdap) => {
    const d = await root('rdap-odd.com', { zone: rootZone('rdap-odd.com', NS.hostinger), rdap })
    expect(d.status).toBe('ACTIVE')
    expect(d.issues).toEqual([])
    expect(d.dns_host).toEqual({ provider: 'Hostinger', nameservers: NS.hostinger, mixed: false })
  })
})

describe('nameserver switches', () => {
  it('to-cloudflare.com: Hostinger → Cloudflare, every resolver still on Hostinger → "add the records at Cloudflare", old rows do not count', async () => {
    const d = await root('to-cloudflare.com', { zone: rootZone('to-cloudflare.com', NS.hostinger, { A: ['2.57.91.91'] }), rdap: NS.cloudflare2 })
    expect(d.view).toMatchObject({ stale: true, old: NS.hostinger })
    expect(codes(d)).toEqual([['NS_SWITCHING', 'error']])
    expect(d.line).toBe('Your DNS moved to Cloudflare — add the records there')
    expect(d.records.every((r) => !r.ok && r.note === 'From your old DNS (Hostinger), which no longer counts')).toBe(true)
    expect(d.dns_host).toEqual({ provider: 'Cloudflare', nameservers: NS.cloudflare2, mixed: false, moving_from: { provider: 'Hostinger', nameservers: NS.hostinger } })
  })

  it('to-cloudflare-half.com: Hostinger → Cloudflare, Cloudflare\'s resolver already on the new zone (right there) → live, switch warning only', async () => {
    const fresh = rootZone('to-cloudflare-half.com', NS.cloudflare2)
    const d = await root('to-cloudflare-half.com', { zone: rootZone('to-cloudflare-half.com', NS.hostinger, { A: ['2.57.91.91'] }), resolvers: { cloudflare: fresh }, rdap: NS.cloudflare2 })
    expect(d.view.resolver).toBe('https://cloudflare-dns.com/dns-query')
    expect(d.records[0]).toMatchObject({ value: IP, ok: true })
    expect(d.status).toBe('ACTIVE')
    expect(errors(d)).toEqual([])
    expect(codes(d)).toContainEqual(['NS_SWITCHING', 'warning'])
  })

  it('to-hostinger.com: Cloudflare → Hostinger, all resolvers still on Cloudflare → "add the records at Hostinger", www row from the old DNS', async () => {
    const d = await root('to-hostinger.com', { zone: rootZone('to-hostinger.com', NS.cloudflare), rdap: NS.hostinger })
    expect(codes(d)).toEqual([['NS_SWITCHING', 'error']])
    expect(d.issues[0].detail).toContain('Add the records below at Hostinger')
    expect(d.records.map((r) => [r.name, r.ok, r.note])).toEqual([['@', false, 'From your old DNS (Cloudflare), which no longer counts'], ['www', false, 'From your old DNS (Cloudflare), which no longer counts']])
  })

  it('cf-account-move.com: between two Cloudflare accounts is a switch that names the new nameservers', async () => {
    const d = await root('cf-account-move.com', { zone: rootZone('cf-account-move.com', NS.cloudflare), rdap: NS.cloudflare2 })
    expect(codes(d)).toEqual([['NS_SWITCHING', 'error']])
    expect(d.issues[0].detail).toContain('lola.ns.cloudflare.com, max.ns.cloudflare.com')
  })

  it('shop-move.com.bd: no RDAP for .bd while moving Cloudflare → Hostinger never says to delete the new (Hostinger) nameservers', async () => {
    const domain = 'shop-move.com.bd'
    const d = await root(domain, { zone: rootZone(domain, NS.cloudflare), resolvers: { cloudflare: rootZone(domain, NS.hostinger) }, rdap: null })
    const advice = d.issues.map((i) => `${i.title}. ${i.detail}`).join('\n')
    expect.soft(advice).not.toMatch(/delete ns1\.dns-parking\.com/)
    expect.soft(advice).not.toMatch(/Keep only the Cloudflare nameservers/)
  })

  it('two-dns.com: registry lists Hostinger + Cloudflare nameservers, the store record only at Hostinger → error, never "delete the Hostinger ones"', async () => {
    const domain = 'two-dns.com'
    const d = await root(domain, { zone: rootZone(domain, NS.hostinger), resolvers: { cloudflare: { [domain]: { NS: NS.cloudflare } } }, rdap: [...NS.hostinger, ...NS.cloudflare] })
    expect(d.issues[0]).toMatchObject({ code: 'NS_MIXED', severity: 'error', title: 'Your domain uses nameservers from two companies' })
    expect(d.dns_host).toMatchObject({ provider: null, mixed: true })
    expect.soft(d.issues[0].detail).not.toMatch(/delete ns1\.dns-parking\.com/)
  })
})

describe('CAA', () => {
  it('caa-digicert.com: CAA allowing only DigiCert blocks the proxy\'s Let\'s Encrypt certificate, without "certificate on the way"', async () => {
    const d = await root('caa-digicert.com', { zone: rootZone('caa-digicert.com', NS.hostinger, { CAA: ['0 issue "digicert.com"'] }), https: 'cert' })
    expect(codes(d)).toContainEqual(['CAA', 'error'])
    expect(d.line).toBe('A CAA record blocks the certificate')
    expect.soft(d.issues.map((i) => i.code)).not.toContain('TLS_PENDING')
  })

  it('caa-letsencrypt.com: CAA allowing letsencrypt.org is fine', async () => {
    const d = await root('caa-letsencrypt.com', { zone: rootZone('caa-letsencrypt.com', NS.hostinger, { CAA: ['0 issue "letsencrypt.org"', '0 iodef "mailto:sec@caa-letsencrypt.com"'] }) })
    expect(d.issues).toEqual([])
  })

  it('shop.caa-apex.com (Cloudflare target): a CAA only on the apex is checked for the subdomain', async () => {
    const zone: Zone = { ...subZone('shop.caa-apex.com', NS.hostinger, { CNAME: ['stores.fullfilio.com'] }), 'caa-apex.com': { NS: NS.hostinger, CAA: ['0 issue "sectigo.com"'] } }
    const d = await sub('shop.caa-apex.com', { zone })
    expect(d.issues).toEqual([expect.objectContaining({ code: 'CAA', severity: 'error', detail: expect.stringContaining('pki.goog') })])
  })

  it('caa-wild-only.com: a CAA set that only limits wildcard certificates (issuewild ";") and reports (iodef) does not block', async () => {
    const d = await root('caa-wild-only.com', { zone: rootZone('caa-wild-only.com', NS.hostinger, { CAA: ['0 issuewild ";"', '0 iodef "mailto:sec@caa-wild-only.com"'] }) })
    expect(d.issues.map((i) => i.code)).not.toContain('CAA')
  })
})

describe('private addresses are never probed (SSRF)', () => {
  it.each([
    ['private-10.com', { A: ['10.0.0.5'] }],
    ['metadata.com', { A: ['169.254.169.254'] }],
    ['loopback6.com', { A: ['93.184.216.34'], AAAA: ['::1'] }],
    ['mapped6.com', { A: ['93.184.216.34'], AAAA: ['::ffff:10.0.0.1'] }],
    ['cgnat.com', { A: ['100.64.0.9'] }],
  ])('%s', async (domain, rec) => {
    const d = await root(domain, { zone: { ...STORES, [domain]: { NS: NS.hostinger, ...rec } } })
    expect(d.probes).toEqual([])
    expect(d.tls).toEqual({ ok: false, status: null, served_by_store: null, detail: 'The domain points at a private or internal address' })
    expect(d.pointed).toBe(false)
  })

  it('shop.internal-cname.com: a CNAME to an internal host (10.20.30.40) is not probed', async () => {
    const d = await sub('shop.internal-cname.com', { zone: { ...subZone('shop.internal-cname.com', NS.hostinger, { CNAME: ['intranet.corp.example'] }), 'intranet.corp.example': { A: ['10.20.30.40'] } } })
    expect(d.probes).toEqual([])
    expect(d.tls.detail).toBe('The domain points at a private or internal address')
  })
})

describe('HTTPS', () => {
  it('tls-other.com: DNS right, HTTPS works but another server answers → an issue says so; no "certificate is issued on the first visit"', async () => {
    const d = await root('tls-other.com', { zone: rootZone('tls-other.com', NS.hostinger), https: 'other' })
    expect(d.pointed).toBe(true)
    expect(d.tls).toMatchObject({ ok: true, served_by_store: false, detail: 'HTTPS works, but another server answered (not the store)' })
    expect(d.status).toBe('VERIFYING')
    expect.soft(d.issues.length).toBeGreaterThan(0)
    expect.soft(d.line).not.toMatch(/certificate is issued on the first visit/)
  })

  it('tls-cert.com: DNS right, certificate not issued yet → "certificate on the way"', async () => {
    const d = await root('tls-cert.com', { zone: rootZone('tls-cert.com', NS.hostinger), https: 'cert' })
    expect(d.tls).toMatchObject({ ok: false, detail: 'The certificate is not ready yet (it is issued once DNS points at the store)' })
    expect(codes(d)).toEqual([['TLS_PENDING', 'info']])
    expect(d.line).toBe('DNS is right — the HTTPS certificate is issued on the first visit (usually under a minute)')
  })

  it('tls-timeout.com: HTTPS times out → "did not answer over HTTPS yet"', async () => {
    const d = await root('tls-timeout.com', { zone: rootZone('tls-timeout.com', NS.hostinger), https: 'timeout' })
    expect(d.tls.detail).toBe('The domain did not answer over HTTPS yet')
  })

  it('tls-redirect.com: our store answers 308 (to the primary domain) → live', async () => {
    const d = await root('tls-redirect.com', { zone: rootZone('tls-redirect.com', NS.hostinger), https: { status: 308, store: true, location: 'https://www.tls-redirect.com/' } })
    expect(d.tls).toMatchObject({ ok: true, status: 308, served_by_store: true })
    expect(d.status).toBe('ACTIVE')
  })
})

describe('bad DNS answers', () => {
  it('quirky-answers.com: quoted A data, upper-case CNAME with trailing dot, are read right', async () => {
    const raw = (_r: string, name: string, type: string) =>
      name === 'quirky-answers.com' && type === 'A' ? { Status: 0, Answer: [{ name: 'quirky-answers.com.', type: 1, data: `"${IP}"` }] }
      : name === 'shop.quirky-answers.com' && type !== 'CAA' ? { Status: 0, Answer: [{ name, type: 5, data: 'Stores.Fullfilio.COM.' }, ...(type === 'A' ? [{ name: 'stores.fullfilio.com.', type: 1, data: '104.21.80.10' }] : [])] }
      : undefined
    const zone = rootZone('quirky-answers.com', NS.hostinger)
    expect((await root('quirky-answers.com', { zone, raw })).records[0]).toMatchObject({ value: IP, ok: true })
    const s = await sub('shop.quirky-answers.com', { zone, raw })
    expect(s.pointed).toBe(true)
    expect(s.issues).toEqual([])
  })

  it('shop.nx-sub.com: NXDOMAIN / empty Answer for a subdomain → "Add a CNAME record for shop"', async () => {
    const d = await sub('shop.nx-sub.com', { zone: subZone('shop.nx-sub.com', NS.hostinger, { status: 3 }), https: 'refused' })
    expect(d.issues[0]).toMatchObject({ code: 'NO_RECORDS', detail: 'Add a CNAME record for shop pointing to stores.fullfilio.com at your domain provider.' })
  })

  it('dnssec-broken.com: every resolver answers SERVFAIL (DNSSEC left on after a move) → says DNS is broken, not "could not check"', async () => {
    const zone: Zone = { 'dnssec-broken.com': { status: 2 }, 'www.dnssec-broken.com': { status: 2 } }
    const d = await root('dnssec-broken.com', { zone, rdap: NS.cloudflare, https: 'refused' })
    expect(d.pointed).toBe(false)
    expect.soft(d.issues[0].title).not.toBe('Could not check DNS right now')
    expect.soft(d.issues[0].detail).toMatch(/DNSSEC/)
  })

  it('shpo-typo.com: NXDOMAIN at the root (typo, not registered or expired) → says the domain does not exist, not "add an A record"', async () => {
    const zone: Zone = { 'shpo-typo.com': { status: 3 }, 'www.shpo-typo.com': { status: 3 } }
    const d = await root('shpo-typo.com', { zone, rdap: null, https: 'refused' })
    expect(d.issues[0].code).not.toBe('CHECK_FAILED')
    expect.soft(d.issues[0].detail).not.toMatch(/^Add an A record/)
    expect.soft(d.issues[0].detail).toMatch(/does not exist|not registered|expired|spelling/i)
  })

  it('odd-json.com: Answer as an object, a null body, entries without data → no crash', async () => {
    const raw = (r: string) => (r === 'google' ? { Status: 0, Answer: { name: 'odd-json.com', type: 1 } } : r === 'cloudflare' ? null : { Status: 0, Answer: [{ name: 'odd-json.com', type: 1 }, null] })
    const d = await root('odd-json.com', { zone: {}, raw, rdap: 'down', https: 'refused' })
    expect(d.issues[0]).toMatchObject({ code: 'CHECK_FAILED' })
    expect(d.pointed).toBe(false)
  })
})

describe('many records', () => {
  it.each(['store', 'cf-error'] as const)('cf-stray.com: the right A plus a stray Cloudflare IP 104.21.7.111 (probe reached: %s) is an extra A record, not live', async (https) => {
    const d = await root('cf-stray.com', { zone: rootZone('cf-stray.com', NS.hostinger, { A: [IP, '104.21.7.111'] }), https })
    expect(d.records[0]).toMatchObject({ value: IP, ok: true })
    expect.soft(d.records[1]).toMatchObject({ value: '104.21.7.111', ok: false })
    expect.soft(d.issues.find((i) => i.code === 'EXTRA_A')?.detail ?? '').toContain('104.21.7.111')
    expect.soft(d.issues.map((i) => i.code)).not.toContain('CLOUDFLARE_PROXY')
    expect.soft(d.pointed).toBe(false)
    expect.soft(d.status).toBe('VERIFYING')
  })
})

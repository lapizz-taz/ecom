// Regression review (round 2) of commit 3f11416 "Domains: audit with four agents…".
// Each test asserts what the merchant / the system SHOULD see. A failing test marks a defect
// the commit introduced or left half-done; nothing here touches the network or a database.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks for the domains function (handler.ts) --------------------------------------------
type Client = { merchant: string | null; as: 'user' | 'admin' | 'platform' }
const H = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  rpc: (async () => { throw new Error('rpc not wired') }) as (client: Client, fn: string, args: Record<string, unknown>) => Promise<unknown>,
  merchants: [] as string[],
}))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  env: (name: string) => (H.env[name] === '' ? undefined : H.env[name]),
}))
vi.mock('./monitoring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitoring.ts')>()),
  logEvent: () => Promise.resolve(),
}))
vi.mock('./cron.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cron.ts')>()),
  isCronRequest: async (req: Request) => req.headers.get('x-cron-secret') === 'cron',
}))
vi.mock('./supabase.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./supabase.ts')>()
  const { HttpError } = await import('./http.ts')
  const adminClient = (merchant?: string | null): Client => ({ merchant: merchant ?? null, as: merchant ? 'admin' : 'platform' })
  return {
    ...real,
    adminClient,
    rpc: (client: Client, fn: string, args: Record<string, unknown> = {}) => H.rpc(client, fn, args),
    requireStaff: async (req: Request) => {
      const m = req.headers.get('x-test-staff')
      if (!m) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
      return { user: { id: `user-${m}` }, client: { merchant: m, as: 'user' }, admin: { merchant: m, as: 'admin' }, merchantId: m, role: 'OWNER', permissions: [] }
    },
    forEachMerchant: async (_source: string, work: (admin: Client, id: string) => Promise<unknown>) => {
      for (const id of H.merchants) await work(adminClient(id), id)
      return { merchants: H.merchants.length, failed: 0, results: [] }
    },
  }
})

import handler from '../domains/handler.ts'
import { fromDbError } from './http.ts'
import {
  apexOf, cloudflareTarget, diagnose, dnsView, inspectWww, proxyTarget,
  type ExpectedRecord,
} from './domain-check.ts'
import { fromRootProxy } from '../../../worker/router.ts'
import { DomainDetail } from '@/features/website/domain-status'
import type { DomainDiagnosis, StoreDomain } from '@/services/website'

// --- A fake DNS / HTTPS world for diagnose() -------------------------------------------------
type T = 'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'TXT'
const CODE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 } as const
type RR = Partial<Record<T, string[]>>
type Zone = Record<string, RR>
type Https = 'store' | 'other' | 'cert'

function resolveName(zone: Zone, qname: string, type: T) {
  const answer: Array<{ name: string; type: number; TTL: number; data: string }> = []
  let name = qname.toLowerCase().replace(/\.$/, '')
  for (let hop = 0; hop < 8; hop++) {
    const rec = zone[name]
    if (!rec) break
    if (rec.CNAME && type !== 'CNAME') {
      answer.push({ name: `${name}.`, type: CODE.CNAME, TTL: 300, data: `${rec.CNAME[0]}.` })
      name = rec.CNAME[0].toLowerCase()
      continue
    }
    for (const d of rec[type] ?? []) answer.push({ name: `${name}.`, type: CODE[type], TTL: 300, data: type === 'TXT' ? `"${d}"` : type === 'NS' || type === 'CNAME' ? `${d}.` : d })
    break
  }
  return answer
}
const RESOLVER_HOSTS = new Set(['dns.google', 'cloudflare-dns.com', 'dns.adguard-dns.com'])
function dnsWorld(zone: Zone, https: Https = 'store') {
  return (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'rdap.org') return new Response('{}', { status: 404 })
    if (RESOLVER_HOSTS.has(url.hostname)) {
      const name = url.searchParams.get('name')!
      const answer = resolveName(zone, name, url.searchParams.get('type') as T)
      return Response.json({ Status: 0, ...(answer.length ? { Answer: answer } : {}) })
    }
    if (https === 'cert') throw new TypeError('invalid peer certificate: UnknownIssuer')
    return new Response('<html></html>', { headers: https === 'store' ? { 'x-fullfilio': 'store' } : { server: 'nginx' } })
  }) as typeof fetch
}

const NOW = new Date('2026-10-19T12:00:00Z')
const IP = '144.24.232.70'
const TARGET = 'stores.fullfilio.com'
const PROXY = proxyTarget(IP, TARGET)
const CF = cloudflareTarget(TARGET)
const STORES: Zone = { [TARGET]: { A: ['104.21.80.10', '172.67.140.20'], AAAA: ['2606:4700:3030::6815:500a'] } }
const HOSTINGER = ['ns1.dns-parking.com', 'ns2.dns-parking.com']
const CLOUDFLARE_NS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']

beforeEach(() => {
  // diagnose() falls back to the global fetch: never the real network.
  vi.stubGlobal('fetch', (async (input: unknown) => { throw new Error(`real network used: ${String(input)}`) }) as typeof fetch)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

// =============================================================================================
describe('www.<root> now goes through the proxy (viaProxy), but diagnose still treats it as a Cloudflare-for-SaaS subdomain', () => {
  it('no records yet: the advice is the A record baseRecords lists, not a CNAME to stores.fullfilio.com', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER, A: [IP] } }
    const d = await diagnose('www.shop.com', { fetcher: dnsWorld(zone, 'cert'), now: NOW, target: PROXY })
    const issue = d.issues.find((i) => i.code === 'NO_RECORDS')
    expect(issue?.detail).toContain(`A record for www pointing to ${IP}`)
  })

  it('www pointing at an old host: WRONG_TARGET says change the A record, not "add a CNAME to stores.fullfilio.com"', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER, A: [IP] }, 'www.shop.com': { A: ['185.230.63.10'] } }
    const d = await diagnose('www.shop.com', { fetcher: dnsWorld(zone, 'other'), now: NOW, target: PROXY })
    const issue = d.issues.find((i) => i.code === 'WRONG_TARGET')
    expect(issue?.detail).not.toContain(`CNAME record for www pointing to ${TARGET}`)
  })

  it('www CNAME to stores.fullfilio.com is NOT pointed on the proxy path (no custom hostname is ever made for it, so it never serves)', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER, A: [IP] }, 'www.shop.com': { CNAME: [TARGET] } }
    const d = await diagnose('www.shop.com', { fetcher: dnsWorld(zone, 'cert'), now: NOW, target: PROXY })
    expect(d.pointed).toBe(false)
  })
})

describe('inspectWww: orange-cloud detection', () => {
  it('a grey www CNAME to a Cloudflare-hosted name (the old stores.fullfilio.com setup) is not reported as an orange cloud', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: CLOUDFLARE_NS, A: [IP] }, 'www.shop.com': { CNAME: [TARGET] } }
    const f = dnsWorld(zone)
    const view = await dnsView('shop.com', f, NOW)
    const www = await inspectWww('shop.com', PROXY, f, view)
    expect(www?.records[0].note ?? '').not.toContain('orange cloud')
    expect(www?.issue?.detail ?? '').not.toContain('DNS only')
  })
})

describe('diagnose: stray records next to the right one', () => {
  it('proxy root: a Cloudflare AAAA next to the right A is reported (IPv6 visitors and the certificate go to Cloudflare)', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER, A: [IP], AAAA: ['2606:4700:3036::ac43:1'] } }
    const d = await diagnose('shop.com', { fetcher: dnsWorld(zone, 'store'), now: NOW, target: PROXY })
    // The record row is already red ("Remove: the store has no IPv6 address")…
    expect(d.records.find((r) => r.type === 'AAAA')?.ok).toBe(false)
    // …but no issue says so: strayAaaa still skips every Cloudflare address, unlike strayA.
    expect(d.issues.map((i) => i.code)).toContain('AAAA')
  })

  it('Cloudflare hosting: EXTRA_A never tells the merchant to delete the A record that reaches the store', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER }, 'blog.shop.com': { A: ['104.21.80.10', '9.9.9.9'] } }
    const d = await diagnose('blog.shop.com', { fetcher: dnsWorld(zone, 'store'), now: NOW, target: CF })
    // The row says 104.21.80.10 is right…
    expect(d.records.find((r) => r.value === '104.21.80.10')?.ok).toBe(true)
    // …and EXTRA_A must not list it for deletion (before the commit it listed only 9.9.9.9).
    expect(d.issues.find((i) => i.code === 'EXTRA_A')?.detail ?? '').not.toContain('104.21.80.10')
  })
})

describe('ownership TXT and the certificate', () => {
  const expectTxt: ExpectedRecord[] = [{ type: 'TXT', name: '_fullfilio.shop.com', value: 'fullfilio-verify=abc123' }]

  it('proxy root, A right, TXT missing: no "certificate on the way" (the proxy refuses a certificate until the TXT is found)', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER, A: [IP] } }
    const d = await diagnose('shop.com', { fetcher: dnsWorld(zone, 'cert'), now: NOW, target: PROXY, expect: expectTxt })
    const codes = d.issues.map((i) => i.code)
    expect(codes).toContain('TXT_MISSING')
    expect(codes).not.toContain('TLS_PENDING')
  })

  it('stale ownership value on a subdomain names the record as the panel shows it (_fullfilio.blog, not _fullfilio)', async () => {
    const zone: Zone = { ...STORES, 'shop.com': { NS: HOSTINGER }, 'blog.shop.com': { CNAME: [TARGET] }, '_fullfilio.blog.shop.com': { TXT: ['fullfilio-verify=old'] } }
    const d = await diagnose('blog.shop.com', {
      fetcher: dnsWorld(zone, 'store'), now: NOW, target: CF,
      expect: [{ type: 'TXT', name: '_fullfilio.blog.shop.com', value: 'fullfilio-verify=new' }],
    })
    const issue = d.issues.find((i) => i.code === 'TXT_MISSING')
    expect(issue?.detail).toContain('_fullfilio.blog ')
  })
})

// =============================================================================================
// The domains function with an in-memory model of the latest store_domain_* functions
// (20261121000600), a fake DoH / HTTPS / provider world, as in domains/domain-audit-flow.test.ts.
interface Row {
  domain: string; merchant_id: string; status: string; records: Array<{ type: string; name: string; value: string }>
  detail: string | null; diagnostics: { issues?: Array<{ code: string; severity: string }>; [k: string]: unknown } | null
  is_primary: boolean; created_at: string; checked_at: string | null; verify_code: string | null; verified_at: string | null
}
const db = { rows: new Map<string, Row>() }
const now = () => new Date().toISOString()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const norm = (d: unknown) => String(d ?? '').trim().toLowerCase()
const live = (r?: Row) => !!r && r.status !== 'REMOVED'
const twinOf = (d: string) => (d.startsWith('www.') ? d.slice(4) : `www.${d}`)
const raise = (message: string, code = 'P0001'): never => { throw fromDbError({ message, code }) }
const newRow = (domain: string, merchant: string, status: string): Row =>
  ({ domain, merchant_id: merchant, status, records: [], detail: null, diagnostics: null, is_primary: false, created_at: now(), checked_at: null, verify_code: `code-${domain}`, verified_at: null })

async function dbRpc(client: Client, fn: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const args = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>
  const mid = client.merchant
  const mine = () => [...db.rows.values()].filter((r) => r.merchant_id === mid)
  switch (fn) {
    case 'store_domain_guard': {
      const d = norm(args.p_domain)
      if (args.p_action === 'add') {
        const twin = db.rows.get(twinOf(d))
        if (live(twin) && twin!.merchant_id !== mid) raise('DUPLICATE: That domain is already connected to another store')
        if (!db.rows.has(d)) db.rows.set(d, newRow(d, mid!, 'PENDING'))
        const r = db.rows.get(d)!
        if (r.merchant_id === mid && r.status === 'REMOVED') Object.assign(r, { status: 'PENDING', is_primary: false, verified_at: null })
        if (!(r.merchant_id === mid && live(r))) raise('DUPLICATE: That domain is already connected to another store')
      } else if (!(db.rows.get(d)?.merchant_id === mid && live(db.rows.get(d)))) raise('NOT_FOUND: That domain is not on this store')
      return null
    }
    case 'store_domain_save': {
      const d = norm(args.p_domain)
      const p = args.p as Record<string, unknown>
      let r = db.rows.get(d)
      const status = (p.status as string | undefined) ?? r?.status ?? 'PENDING'
      if (r && r.status === 'REMOVED' && p.status !== 'REMOVED') return null
      if (!r) { r = newRow(d, mid!, status); db.rows.set(d, r) }
      r.is_primary = status === 'REMOVED' ? false : r.is_primary || !mine().some((x) => x !== r && x.is_primary && live(x))
      r.status = status
      if (p.records != null) r.records = p.records as Row['records']
      if ('detail' in p) r.detail = (p.detail as string | null) ?? null
      if ('diagnostics' in p) r.diagnostics = (p.diagnostics as Row['diagnostics']) ?? null
      r.verified_at = r.status === 'REMOVED' ? null : p.verified === true ? (r.verified_at ?? now()) : r.verified_at
      r.checked_at = now()
      return { ...r }
    }
    case 'store_domains_list':
      return mine().filter(live).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => ({ ...r }))
    case 'store_domain_known': {
      const d = norm(args.p_domain)
      return [...db.rows.values()].some((r) => [d, twinOf(d)].includes(r.domain) && live(r) && !!r.verified_at)
    }
  }
  throw new Error(`unexpected rpc ${fn}`)
}
function seed(domain: string, merchant: string, status: string, o: { checkedMin: number; verified?: boolean; createdDays?: number }): Row {
  const r: Row = { ...newRow(domain, merchant, status), verified_at: o.verified === false ? null : ago(1440 * 30),
    created_at: ago((o.createdDays ?? 30) * 1440), checked_at: ago(o.checkedMin), diagnostics: { issues: [] } }
  db.rows.set(domain, r)
  return r
}

const SITE = 'https://fullfilio.com/functions/v1/domains'
const flow = {
  zone: {} as Zone,
  /** Names Google answers empty for (a negative answer it still caches); Cloudflare's resolver has them. */
  googleMisses: new Set<string>(),
  /** Every DoH name asked, to see which domains a run inspected. */
  asked: [] as string[],
  vercel: null as null | ((url: URL, method: string) => Response),
}
async function web(host: string): Promise<Response> {
  const ips = resolveName(flow.zone, host, 'A').filter((a) => a.type === CODE.A).map((a) => a.data)
  if (ips.length && ips.every((ip) => ip === IP)) {
    // The root proxy (Caddy) asks before getting a certificate.
    const asked = await handler(new Request(`${SITE}?domain=${encodeURIComponent(host)}`))
    if (asked.status !== 200) throw new Error('tls: unable to get local issuer certificate')
    return new Response('', { headers: { 'x-fullfilio': 'store' } })
  }
  if (ips.includes('76.76.21.21')) return new Response('', { headers: { 'x-vercel-id': 'iad1::abc' } })
  throw new Error('connect ECONNREFUSED')
}
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (RESOLVER_HOSTS.has(url.hostname)) {
    const name = (url.searchParams.get('name') ?? '').toLowerCase()
    flow.asked.push(name)
    const type = url.searchParams.get('type') as T
    if (url.hostname === 'dns.google' && flow.googleMisses.has(name)) return Response.json({ Status: 0 })
    // Every apex is on Hostinger unless the zone says otherwise.
    if (type === 'NS' && apexOf(name) === name && !flow.zone[name]?.NS) return Response.json({ Status: 0, Answer: HOSTINGER.map((n) => ({ name, type: 2, data: `${n}.` })) })
    return Response.json({ Status: 0, Answer: resolveName(flow.zone, name, type) })
  }
  if (url.hostname === 'rdap.org') return new Response('{}', { status: 404 })
  if (url.hostname === 'api.cloudflare.com') return Response.json({ success: true, result: [] })
  if (url.hostname === 'api.vercel.com' && flow.vercel) return flow.vercel(url, init?.method ?? 'GET')
  return web(url.hostname)
}
async function post(payload: unknown, staff: string | null = 'm-a', headers: Record<string, string> = {}) {
  const res = await handler(new Request(SITE, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...(staff ? { 'x-test-staff': staff } : {}), ...headers } }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const issueCodes = (r?: Row) => (r?.diagnostics?.issues ?? []).map((i) => i.code)

describe('domains function', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'))
    vi.stubGlobal('fetch', fakeFetch)
    H.env = { CF_SAAS_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone1', CUSTOM_DOMAIN_TARGET: TARGET, ROOT_DOMAIN_IP: IP }
    H.rpc = dbRpc
    H.merchants = ['m-a', 'm-b']
    db.rows = new Map()
    flow.zone = { ...STORES }
    flow.googleMisses = new Set()
    flow.asked = []
    flow.vercel = null
  })

  it('inspectRoot: a TXT just found (at Cloudflare\'s resolver only) does not also show "Verification record missing"', async () => {
    flow.zone['shop.com'] = { A: [IP] }
    flow.zone['www.shop.com'] = { A: [IP] }
    flow.zone['_fullfilio.shop.com'] = { TXT: ['fullfilio-verify=code-shop.com'] }
    flow.googleMisses.add('_fullfilio.shop.com') // Google still caches "no such record" from before it was added
    // The first add never asks for the record (the merchant has not seen the code yet); the check does.
    await post({ action: 'add', domain: 'shop.com' })
    const res = await post({ action: 'check', domain: 'shop.com' })
    expect(res.status).toBe(200)
    const row = db.rows.get('shop.com')!
    expect(row.verified_at).not.toBeNull() // proven by prove() (Google OR Cloudflare)
    // diagnose() is asked to look for the record again (expect uses own.verified, not `proven`) at Google only.
    expect(issueCodes(row)).not.toContain('TXT_MISSING')
  })

  it('recheck_all: waiting domains are not pushed behind the daily checks of live domains', async () => {
    for (let i = 1; i <= 20; i++) {
      seed(`live${i}.com`, 'm-b', 'ACTIVE', { checkedMin: 25 * 60 })
      flow.zone[`live${i}.com`] = { A: [IP] }
    }
    const waiting = seed('new.com', 'm-a', 'VERIFYING', { checkedMin: 15, verified: false, createdDays: 0 })
    const before = waiting.checked_at
    const res = await post({ action: 'recheck_all' }, null, { 'x-cron-secret': 'cron' })
    expect(res.status).toBe(200)
    // The merchant was told "we keep checking every 10 minutes"; the 15 slots all went to live domains.
    expect(db.rows.get('new.com')!.checked_at).not.toBe(before)
  })

  it('(control) with only a few live domains due, the waiting one is checked in the same run', async () => {
    for (let i = 1; i <= 5; i++) {
      seed(`live${i}.com`, 'm-b', 'ACTIVE', { checkedMin: 25 * 60 })
      flow.zone[`live${i}.com`] = { A: [IP] }
    }
    const waiting = seed('new.com', 'm-a', 'VERIFYING', { checkedMin: 15, verified: false, createdDays: 0 })
    const before = waiting.checked_at
    await post({ action: 'recheck_all' }, null, { 'x-cron-secret': 'cron' })
    expect(db.rows.get('new.com')!.checked_at).not.toBe(before)
  })

  it('www.shop.com next to a proven shop.com: the www row is not stuck on "Verification record missing" while it already serves', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { checkedMin: 5 })
    flow.zone['shop.com'] = { A: [IP] }
    flow.zone['www.shop.com'] = { A: [IP] }
    flow.zone['_fullfilio.shop.com'] = { TXT: ['fullfilio-verify=code-shop.com'] }
    await post({ action: 'add', domain: 'www.shop.com' }) // no _fullfilio.www record: the root already proves the pair
    // The proxy already gets www a certificate and storefront_resolve already opens the store there (twin proven)…
    expect((await handler(new Request(`${SITE}?domain=www.shop.com`))).status).toBe(200)
    // …but the row asks for its own TXT and stays red.
    expect(issueCodes(db.rows.get('www.shop.com'))).not.toContain('TXT_MISSING')
  })

  it("the platform's own apex refused with 422 leaves no row behind (the guard already inserted it)", async () => {
    // Guard model above does not know reserved hosts: as when reserved_hosts does not cover CUSTOM_DOMAIN_TARGET's apex.
    const res = await post({ action: 'add', domain: 'fullfilio.com' })
    expect(res.status).toBe(422)
    expect(db.rows.has('fullfilio.com')).toBe(false)
  })

  it('an e-mail address pasted as the domain is refused, not turned into its mail provider (me@gmail.com → gmail.com)', async () => {
    const res = await post({ action: 'add', domain: 'owner@gmail.com' })
    expect(res.status).toBe(422)
    expect(db.rows.has('gmail.com')).toBe(false)
  })

  it('Vercel hosting: a domain is not marked verified (ownership proven) without the store\'s own proof', async () => {
    H.env = { VERCEL_TOKEN: 'vt', VERCEL_PROJECT_ID: 'p1' }
    flow.zone['victim.com'] = { A: ['76.76.21.21'] }
    // Vercel verifies on its own only when the name is used by another Vercel account; in the shared project it just says yes.
    flow.vercel = (url) => url.pathname.startsWith('/v6/domains/') ? Response.json({ misconfigured: false }) : Response.json({ name: 'victim.com', verified: true })
    await post({ action: 'add', domain: 'victim.com' }, 'm-b')
    expect(db.rows.get('victim.com')!.verified_at).toBeNull()
  })
})

// =============================================================================================
describe('worker router: platform names from the upstream host', () => {
  it('a store on a .com.bd root is accepted when the platform itself is on a country second level', () => {
    const secret = 's'.repeat(32)
    const out = fromRootProxy(new Request('https://stores.fullfilio.com.bd/', {
      headers: { 'x-fullfilio-proxy': secret, 'x-fullfilio-host': 'shop.com.bd' },
    }), secret)
    expect(new URL(out.url).hostname).toBe('shop.com.bd')
  })
})

// =============================================================================================
describe('domain popup text vs the backend', () => {
  const diag = (p: Partial<DomainDiagnosis>): DomainDiagnosis => ({
    checked_at: '2026-10-19T10:00:00Z', kind: 'apex', pointed: true, live_everywhere: true, records: [],
    regions: [], resolvers: [], tls: { ok: true, detail: 'TLS certificate provisioned for secure connections', served_by_store: true, status: 200 },
    issues: [], dns_host: { provider: 'Hostinger', nameservers: HOSTINGER, mixed: false }, ...p,
  })
  const dom = (p: Partial<StoreDomain>): StoreDomain => ({
    id: 'd1', domain: 'shop.com', status: 'ACTIVE', records: [], detail: null, created_at: '2026-10-19T09:00:00Z',
    checked_at: '2026-10-19T10:00:00Z', is_primary: true, diagnostics: diag({}), ...p,
  })
  const popup = (d: StoreDomain) => renderToStaticMarkup(createElement(DomainDetail, {
    d, primary: 'shop.com', canEdit: true, checking: false, inDialog: true,
    onCheck: () => undefined, onRemove: () => undefined, onBack: () => undefined, onMakePrimary: async () => undefined,
  })).replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')

  it('www.shop.com on the proxy (an A record for www) gets no "root (@) cannot connect at Hostinger" tip', () => {
    const t = popup(dom({
      domain: 'www.shop.com', status: 'VERIFYING',
      records: [{ type: 'A', name: 'www', value: IP, why: 'Points www at the store' }, { type: 'TXT', name: '_fullfilio.www', value: 'fullfilio-verify=x', why: 'Proves' }],
      diagnostics: diag({ kind: 'subdomain', pointed: false, tls: { ok: false, detail: 'x', served_by_store: null, status: null },
        issues: [{ code: 'NO_RECORDS', severity: 'error', title: 'No DNS records found', detail: 'x' }] }),
    }))
    expect(t).not.toContain('The root (@) cannot connect at Hostinger')
  })

  it('proxy root waiting for its TXT: the HTTPS row does not say the certificate is being issued', () => {
    const t = popup(dom({
      status: 'VERIFYING', records: [{ type: 'A', name: '@', value: IP, why: 'x' }, { type: 'TXT', name: '_fullfilio', value: 'fullfilio-verify=x', why: 'x' }],
      diagnostics: diag({ pointed: true, tls: { ok: false, detail: 'The certificate is not ready yet', served_by_store: null, status: null },
        issues: [{ code: 'TXT_MISSING', severity: 'error', title: 'Verification record missing', detail: 'x' }] }),
    }))
    expect(t).not.toContain('the HTTPS certificate is being issued')
  })

  it('a live domain whose last DNS check could not run is not told to "fix" our resolver outage', () => {
    const t = popup(dom({ diagnostics: diag({ pointed: false, issues: [{ code: 'CHECK_FAILED', severity: 'error', title: 'Could not check DNS right now', detail: 'x' }] }) }))
    expect(t).not.toContain('fix the following')
  })
})

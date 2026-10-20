// Round 3 of the custom-domain audit: can a normal merchant action, an admin action or a
// background job (the 10-minute re-check) take a proven, live domain offline, or leave the panel
// showing a wrong state, while its owner did nothing wrong with DNS? Run through the domains
// function with every outside service faked (harness copied from domain-ownership-r2.test.ts,
// plus switches for transient failures: a DoH query or the HTTPS probe failing, the upstream
// answering 502 through the root proxy, Cloudflare's API failing, a registry (RDAP) answer).
// Every scenario starts from "proven + ACTIVE". Each test asserts the CORRECT behaviour: it.fails
// marks a defect on the current code (the comment above it says what should happen), the plain
// tests are regression coverage. No real network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Client = { merchant: string | null; as: 'user' | 'admin' | 'platform' }

const H = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  rpc: (async () => { throw new Error('rpc not wired') }) as (client: Client, fn: string, args: Record<string, unknown>) => Promise<unknown>,
  logs: [] as Array<{ level: string; message: string }>,
  merchants: [] as string[],
}))

vi.mock('../_shared/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/env.ts')>()),
  env: (name: string) => (H.env[name] === '' ? undefined : H.env[name]),
}))
vi.mock('../_shared/monitoring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/monitoring.ts')>()),
  logEvent: (e: { level: string; message: string }) => { H.logs.push(e); return Promise.resolve() },
}))
vi.mock('../_shared/cron.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/cron.ts')>()),
  isCronRequest: async (req: Request) => req.headers.get('x-cron-secret') === 'cron-secret-for-tests',
}))
vi.mock('../_shared/supabase.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../_shared/supabase.ts')>()
  const adminClient = (merchant?: string | null): Client => ({ merchant: merchant ?? null, as: merchant ? 'admin' : 'platform' })
  const { HttpError } = await import('../_shared/http.ts')
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
      const results: Array<{ merchant_id: string; ok: boolean }> = []
      for (const id of H.merchants) {
        try {
          await work(adminClient(id), id)
          results.push({ merchant_id: id, ok: true })
        } catch {
          results.push({ merchant_id: id, ok: false })
        }
      }
      return { merchants: results.length, failed: results.filter((r) => !r.ok).length, results }
    },
  }
})

import handler from './handler.ts'
import { fromDbError } from '../_shared/http.ts'
import { apexOf } from '../_shared/domain-check.ts'

const IP = '144.24.232.70'
const TARGET = 'stores.fullfilio.com'
const SITE = 'https://fullfilio.com/functions/v1/domains'
const START = new Date('2026-10-19T10:00:00Z')

// --- In-memory model of store_domain_* (through 20261121000800_domain_readd_keeps_proof.sql) ----

interface Row {
  domain: string; merchant_id: string; status: string; records: Array<{ type: string; name: string; value: string }>
  detail: string | null; diagnostics: { issues?: Array<{ code: string; severity: string; title?: string; detail?: string }>; [k: string]: unknown } | null
  is_primary: boolean; created_at: string; checked_at: string | null; verify_code: string | null; verified_at: string | null; removed_at?: string | null
}
const db = { rows: new Map<string, Row>(), seq: 0 }
const now = () => new Date().toISOString()
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const norm = (d: unknown) => String(d ?? '').trim().toLowerCase()
const isReserved = (d: string) => d === 'fullfilio.com' || d.endsWith('.fullfilio.com')
const live = (r?: Row) => !!r && r.status !== 'REMOVED'
const twinOf = (d: string) => (d.startsWith('www.') ? d.slice(4) : `www.${d}`)
const raise = (message: string, code = 'P0001'): never => { throw fromDbError({ message, code }) }
const newRow = (domain: string, merchant: string, status: string): Row =>
  ({ domain, merchant_id: merchant, status, records: [], detail: null, diagnostics: null, is_primary: false, created_at: now(), checked_at: null, verify_code: `c${++db.seq}x${domain.length}`, verified_at: null })

async function dbRpc(client: Client, fn: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const args = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>
  const mid = client.merchant
  const mine = () => [...db.rows.values()].filter((r) => r.merchant_id === mid)
  switch (fn) {
    case 'store_domain_guard': {
      const d = norm(args.p_domain)
      if (!mid) raise('No merchant in context', '42501')
      if (args.p_action === 'add') {
        if (isReserved(d)) raise("DOMAIN_REJECTED: That is the platform's own domain")
        const twin = db.rows.get(twinOf(d))
        if (live(twin) && twin!.merchant_id !== mid) raise('DUPLICATE: That domain is already connected to another store')
        if (db.rows.get(d)?.status === 'REMOVED' && db.rows.get(d)!.merchant_id !== mid) db.rows.delete(d)
        // The same store's proven twin (live, or removed under 7 days ago) carries the proof.
        const twinProven = twin?.merchant_id === mid && !!twin?.verified_at && (live(twin) || (!!twin?.removed_at && Date.parse(twin.removed_at) > Date.now() - 7 * 86_400_000))
        if (!db.rows.has(d)) db.rows.set(d, { ...newRow(d, mid!, 'PENDING'), verified_at: twinProven ? now() : null })
        const r = db.rows.get(d)!
        if (r.merchant_id === mid && r.status === 'REMOVED') Object.assign(r, { status: 'PENDING', is_primary: false, removed_at: null,
          verified_at: (r.removed_at && Date.parse(r.removed_at) > Date.now() - 7 * 86_400_000 ? r.verified_at : null) ?? (twinProven ? now() : null) })
        if (!(r.merchant_id === mid && live(r))) raise('DUPLICATE: That domain is already connected to another store')
      } else {
        const r = db.rows.get(d)
        if (!(r && r.merchant_id === mid && live(r))) raise('NOT_FOUND: That domain is not on this store')
      }
      return null
    }
    case 'store_domain_save': {
      const d = norm(args.p_domain)
      const p = args.p as Record<string, unknown>
      let r = db.rows.get(d)
      const status = (p.status as string | undefined) ?? r?.status ?? 'PENDING'
      if (status !== 'REMOVED') {
        const twin = db.rows.get(twinOf(d))
        if (live(twin) && twin!.merchant_id !== mid) raise('DUPLICATE: That domain is already connected to another store')
      }
      if (r && r.merchant_id !== mid) raise('new row violates row-level security policy for table "store_domains"', '42501')
      if (r && r.status === 'REMOVED' && p.status !== 'REMOVED') return null
      if (!r) {
        r = newRow(d, mid!, status)
        r.is_primary = status !== 'REMOVED' && !mine().some((x) => x.is_primary && live(x))
        db.rows.set(d, r)
      } else {
        r.is_primary = status === 'REMOVED' ? false : r.is_primary || !mine().some((x) => x !== r && x.is_primary && live(x))
        r.status = status
      }
      if (p.records != null) r.records = p.records as Row['records']
      if ('detail' in p) r.detail = (p.detail as string | null) ?? null
      if ('diagnostics' in p) r.diagnostics = (p.diagnostics as Row['diagnostics']) ?? null
      r.removed_at = r.status === 'REMOVED' ? (r.removed_at ?? now()) : null
      r.verified_at = r.status === 'REMOVED' ? r.verified_at : p.verified === true ? (r.verified_at ?? now()) : r.verified_at
      r.checked_at = now()
      if (r.status === 'REMOVED' && !mine().some((x) => x.is_primary && live(x))) {
        const next = mine().filter(live).sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || a.created_at.localeCompare(b.created_at))[0]
        if (next) next.is_primary = true
      }
      return { ...r }
    }
    case 'store_domains_list':
      return mine().filter(live).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => ({ ...r }))
    case 'store_domain_known': {
      const d = norm(args.p_domain).replace(/\.$/, '')
      return d !== '' && !isReserved(d) && [...db.rows.values()].some((r) => [d, twinOf(d)].includes(r.domain) && live(r) && !!r.verified_at)
    }
  }
  throw new Error(`unexpected rpc ${fn}`)
}

function seed(domain: string, merchant: string, status: string, o: { checkedMin?: number; createdDays?: number; verified?: boolean; primary?: boolean } = {}): Row {
  const r: Row = {
    ...newRow(domain, merchant, status),
    verified_at: o.verified ? ago(60 * 24 * 30) : null,
    created_at: ago((o.createdDays ?? 1) * 1440),
    checked_at: o.checkedMin == null ? null : ago(o.checkedMin),
    is_primary: o.primary ?? false,
  }
  db.rows.set(domain, r)
  return r
}

// --- The fake outside world ----------------------------------------------------------------

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'NS' | 'TXT' | 'CAA'
type Records = Partial<Record<RecordType, string[]>>
const CODE: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 }
interface CfHost { id: string; hostname: string; status: string; ssl: { status: string } }
type DohFailure = 'timeout' | 'http429' | 'servfail' | null
const world = {
  zone: {} as Record<string, Records>,
  https: {} as Record<string, 'store' | 'vercel' | 'other' | 'cert' | 'down' | 'timeout' | 'bad-gateway'>,
  log: [] as Array<{ method: string; url: URL }>,
  cfHosts: new Map<string, CfHost>(),
  /** A DoH answer that fails this time (resolver host, name, type, region subnet). */
  dohFail: null as null | ((resolver: string, name: string, type: RecordType, subnet: string | null) => DohFailure),
  /** Cloudflare's API answering with this HTTP status (and success: false). */
  cfDown: null as null | number,
  /** Vercel's API answering with this HTTP status. */
  vercelDown: null as null | number,
  /** The registry (RDAP) record of an apex: its nameservers and when it last changed. */
  registry: {} as Record<string, { ns: string[]; changed?: string }>,
}

function answers(name: string, type: RecordType, depth = 0): Array<{ name: string; type: number; data: string }> {
  const rec = world.zone[name] ?? {}
  if ((type === 'A' || type === 'AAAA' || type === 'TXT') && rec.CNAME?.length && depth < 5) {
    return [{ name, type: CODE.CNAME, data: `${rec.CNAME[0]}.` }, ...answers(rec.CNAME[0], type, depth + 1)]
  }
  if (type === 'CNAME') return (rec.CNAME ?? []).map((d) => ({ name, type: CODE.CNAME, data: `${d}.` }))
  if (type === 'NS' && !rec.NS && apexOf(name) === name) return ['ns1.dns-parking.com', 'ns2.dns-parking.com'].map((d) => ({ name, type: CODE.NS, data: `${d}.` }))
  return (rec[type] ?? []).map((d) => ({ name, type: CODE[type], data: type === 'TXT' ? `"${d}"` : d }))
}
const addressesOf = (host: string) => answers(host, 'A').filter((a) => a.type === CODE.A).map((a) => a.data)
const cnameChain = (host: string) => answers(host, 'A').filter((a) => a.type === CODE.CNAME).map((a) => a.data.replace(/\.$/, ''))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function cloudflareApi(url: URL, method: string, body?: Record<string, unknown>): Response {
  if (world.cfDown) return json(world.cfDown, { success: false, errors: [{ code: 10000, message: world.cfDown === 403 ? 'Authentication error' : 'Internal server error' }] })
  const rest = url.pathname.replace('/client/v4/zones/zone1/custom_hostnames', '')
  if (rest === '' && method === 'GET') {
    const h = world.cfHosts.get(url.searchParams.get('hostname') ?? '')
    if (h && cnameChain(h.hostname).includes(TARGET)) Object.assign(h, { status: 'active', ssl: { status: 'active' } })
    return json(200, { success: true, result: h ? [structuredClone(h)] : [] })
  }
  if (rest === '' && method === 'POST') {
    const name = String(body?.hostname)
    if (world.cfHosts.has(name)) return json(409, { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] })
    const h: CfHost = { id: `h${world.cfHosts.size + 1}-${name}`, hostname: name, status: 'pending', ssl: { status: 'pending_validation' } }
    world.cfHosts.set(name, h)
    return json(201, { success: true, result: structuredClone(h) })
  }
  const h = [...world.cfHosts.values()].find((x) => x.id === rest.slice(1))
  if (method === 'PATCH' && h) return json(200, { success: true, result: structuredClone(h) })
  if (method === 'DELETE' && h) { world.cfHosts.delete(h.hostname); return json(200, { success: true, result: { id: h.id } }) }
  return json(404, { success: false, errors: [{ code: 1436, message: 'not found' }] })
}

function vercelApi(url: URL, method: string): Response {
  if (world.vercelDown) return json(world.vercelDown, { error: { code: 'internal_server_error', message: 'An unexpected error occurred' } })
  const p = url.pathname
  if (method === 'POST' && p === '/v10/projects/p1/domains') return json(200, { name: 'x', verified: true })
  if (method === 'GET' && p.startsWith('/v9/projects/p1/domains/')) return json(200, { name: p.split('/').pop(), verified: true })
  if (method === 'GET' && p.startsWith('/v6/domains/')) {
    const d = p.split('/')[3]
    return json(200, { misconfigured: !addressesOf(d).includes('76.76.21.21') })
  }
  return json(404, { error: { code: 'not_found', message: 'not found' } })
}

async function web(url: URL): Promise<Response> {
  const host = url.hostname
  let mode = world.https[host]
  if (!mode) {
    const ips = addressesOf(host)
    if (cnameChain(host).includes(TARGET)) {
      const h = world.cfHosts.get(host)
      mode = h?.status === 'active' ? 'store' : 'cert'
    } else if (ips.length > 0 && ips.every((ip) => ip === IP)) {
      const asked = await handler(new Request(`${SITE}?domain=${encodeURIComponent(host)}`))
      mode = asked.status === 200 ? 'store' : 'cert'
    } else {
      mode = 'down'
    }
  }
  if (mode === 'cert') throw new Error('tls: unable to get local issuer certificate')
  if (mode === 'down') throw new Error('connect ECONNREFUSED')
  if (mode === 'timeout') throw new Error('The operation was aborted due to timeout')
  // The root proxy (Caddy) could not reach the site, or the site errored: no store header on that page.
  if (mode === 'bad-gateway') return new Response('Bad Gateway', { status: 502 })
  const headers: Record<string, string> = mode === 'store' ? { 'x-fullfilio': 'store' } : mode === 'vercel' ? { 'x-vercel-id': 'sfo1::abc', server: 'Vercel' } : { server: 'nginx' }
  return new Response('<html></html>', { status: 200, headers })
}

function rdap(url: URL): Response {
  if (url.hostname === 'data.iana.org') return json(200, { services: [[['com', 'shop', 'test'], ['https://rdap.test/']]] })
  const apex = url.pathname.replace(/^\/domain\//, '')
  const r = world.registry[apex]
  if (url.hostname !== 'rdap.test' || !r) return new Response('not found', { status: 404 })
  return json(200, { nameservers: r.ns.map((n) => ({ ldhName: n })), events: r.changed ? [{ eventAction: 'last changed', eventDate: r.changed }] : [] })
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
  world.log.push({ method, url })
  switch (url.hostname) {
    case 'dns.google': case 'cloudflare-dns.com': case 'dns.adguard-dns.com': {
      const name = (url.searchParams.get('name') ?? '').replace(/\.$/, '')
      const type = url.searchParams.get('type') as RecordType
      const fail = world.dohFail?.(url.hostname, name, type, url.searchParams.get('edns_client_subnet'))
      if (fail === 'timeout') throw new Error('The operation was aborted due to timeout')
      if (fail === 'http429') return new Response('Too Many Requests', { status: 429 })
      if (fail === 'servfail') return Response.json({ Status: 2 })
      return Response.json({ Status: 0, Answer: answers(name, type) })
    }
    case 'rdap.org': case 'data.iana.org': case 'rdap.test': return rdap(url)
    case 'api.cloudflare.com': return cloudflareApi(url, method, body)
    case 'api.vercel.com': return vercelApi(url, method)
    default: return web(url)
  }
}

type Body = { domain?: Row; error?: { code: string; message: string }; [k: string]: unknown }
async function post(payload: unknown, staff: string | null = 'm-a', headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const res = await handler(new Request(SITE, {
    method: 'POST', body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...(staff ? { 'x-test-staff': staff } : {}), ...headers },
  }))
  return { status: res.status, body: await res.json() as Body }
}
const cron = () => post({ action: 'recheck_all' }, null, { 'x-cron-secret': 'cron-secret-for-tests' })
const ask = async (d: string) => (await handler(new Request(`${SITE}?domain=${encodeURIComponent(d)}`))).status
const recordsOf = (r: Row | undefined) => (r?.records ?? []).map((x) => [x.type, x.name, x.value])
const issuesOf = (r: Row | undefined) => (r?.diagnostics?.issues ?? []).map((i) => i.code)
const CF_ENV = { CF_SAAS_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone1', CUSTOM_DOMAIN_TARGET: TARGET, ROOT_DOMAIN_IP: IP }

/** shop.com live through the root proxy for 90 days, proven, primary; www served as its twin; last checked 25 hours ago. */
function liveRoot(d = 'shop.com', merchant = 'm-a'): Row {
  world.zone[d] = { A: [IP] }
  world.zone[`www.${d}`] = { A: [IP] }
  return seed(d, merchant, 'ACTIVE', { verified: true, primary: true, createdDays: 90, checkedMin: 25 * 60 })
}
/** shop.brand.com live on Cloudflare for SaaS (custom hostname active), proven, primary. */
function liveSub(d = 'shop.brand.com', merchant = 'm-a'): Row {
  world.zone[d] = { CNAME: [TARGET] }
  world.cfHosts.set(d, { id: `h-${d}`, hostname: d, status: 'active', ssl: { status: 'active' } })
  return seed(d, merchant, 'ACTIVE', { verified: true, primary: true, createdDays: 90, checkedMin: 25 * 60 })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  vi.stubGlobal('fetch', fakeFetch)
  H.env = { ...CF_ENV }
  H.rpc = dbRpc
  H.logs = []
  H.merchants = ['m-a', 'm-b']
  db.rows = new Map()
  db.seq = 0
  world.zone = { [TARGET]: { A: ['104.21.50.1'] } }
  world.https = {}
  world.log = []
  world.cfHosts = new Map()
  world.dohFail = null
  world.cfDown = null
  world.vercelDown = null
  world.registry = {}
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// =============================================================================================
// 1. Merchant actions
// =============================================================================================

describe('r3: merchant actions on a live domain', () => {
  it('control: the daily re-check of a healthy live root keeps it ACTIVE and its certificates allowed', async () => {
    liveRoot()
    await cron()
    expect(db.rows.get('shop.com')).toMatchObject({ status: 'ACTIVE' })
    expect(await ask('shop.com')).toBe(200)
    expect(await ask('www.shop.com')).toBe(200)
  })

  it('remove + re-add of the root seconds later: still proven, ACTIVE at once, no TXT asked, certificates allowed (the production fix)', async () => {
    liveRoot()
    await post({ action: 'remove', domain: 'shop.com' })
    expect(await ask('shop.com')).toBe(404)
    const res = await post({ action: 'add', domain: 'shop.com' })
    expect(res.body.domain).toMatchObject({ status: 'ACTIVE', is_primary: true })
    expect(recordsOf(res.body.domain).some(([t]) => t === 'TXT')).toBe(false)
    expect(await ask('shop.com')).toBe(200)
    expect(await ask('www.shop.com')).toBe(200)
  })

  // Expected: the merchant removes shop.com and adds www.shop.com (switching the main address)
  // seconds later. The same store proved this domain; the twin served www all along. www should
  // come back proven and live like a re-add of the root does. Today the function only looks at
  // the store's non-removed rows (store_domains_list) for a proven twin, the guard gives the new
  // www row no proof, so www and the root both show "store not available", the proxy refuses the
  // certificate and the panel asks for a TXT record ("Waiting for the TXT record below").
  it('remove shop.com, then add www.shop.com seconds later: www is live at once, no TXT record asked', async () => {
    liveRoot()
    await post({ action: 'remove', domain: 'shop.com' })
    const res = await post({ action: 'add', domain: 'www.shop.com' })
    expect(recordsOf(res.body.domain).some(([t]) => t === 'TXT')).toBe(false)
    expect(res.body.domain).toMatchObject({ status: 'ACTIVE' })
    expect(await ask('www.shop.com')).toBe(200)
  })

  it('remove + re-add of a Cloudflare subdomain seconds later: the custom hostname is created again, still proven, live', async () => {
    liveSub()
    await post({ action: 'remove', domain: 'shop.brand.com' })
    expect(world.cfHosts.has('shop.brand.com')).toBe(false)
    const res = await post({ action: 'add', domain: 'shop.brand.com' })
    expect(world.cfHosts.has('shop.brand.com')).toBe(true)
    expect(res.body.domain).toMatchObject({ status: 'ACTIVE' })
    expect(recordsOf(res.body.domain).some(([t]) => t === 'TXT')).toBe(false)
  })

  it('removing the www row while the root stays: the root row is untouched and www keeps its certificate', async () => {
    liveRoot()
    const add = await post({ action: 'add', domain: 'www.shop.com' })
    expect(add.body.domain).toMatchObject({ status: 'ACTIVE', is_primary: false })
    await post({ action: 'remove', domain: 'www.shop.com' })
    expect(db.rows.get('shop.com')).toMatchObject({ status: 'ACTIVE', is_primary: true })
    expect(await ask('www.shop.com')).toBe(200)
    expect(world.log.filter((l) => l.url.hostname === 'api.cloudflare.com' && l.method === 'DELETE')).toEqual([])
  })

  it('the owner deletes the _fullfilio TXT record after proof: the re-check keeps it ACTIVE and asks for nothing', async () => {
    liveRoot()
    delete world.zone['_fullfilio.shop.com']
    await cron()
    const r = db.rows.get('shop.com')!
    expect(r.status).toBe('ACTIVE')
    expect(issuesOf(r)).not.toContain('TXT_MISSING')
    expect(recordsOf(r).some(([t]) => t === 'TXT')).toBe(false)
  })

  it('a Cloudflare orange cloud in front of the proxy while the store still answers: ACTIVE (a warning only)', async () => {
    liveRoot()
    world.zone['shop.com'] = { A: ['104.16.1.1'], NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] }
    world.https['shop.com'] = 'store'
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })
})

// =============================================================================================
// 2. The re-check job meeting a transient failure (root on the proxy)
// =============================================================================================

describe('r3: transient failures during the re-check of a live root (proxy path)', () => {
  it('control: every DoH resolver down (CHECK_FAILED) — stays ACTIVE', async () => {
    liveRoot()
    world.dohFail = () => 'timeout'
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })

  it('control: the registry (RDAP) unreachable — stays ACTIVE', async () => {
    liveRoot()
    world.registry = {}
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })

  // Expected: one HTTPS probe that times out says nothing about a domain that has served the store
  // for 90 days; the Cloudflare path already tolerates it (reachesStore). On the proxy path
  // inspectRoot requires tls.ok, so the live root drops to VERIFYING and the panel says "Pending ·
  // DNS is right — the HTTPS certificate is issued on the first visit … the store goes live on its own".
  // The other side of keeping a live domain: DNS that fully answers and leads elsewhere while
  // the store no longer answers is the owner moving it, and the panel must say so.
  it('the owner moved the domain to another host (DNS answers fully, another server answers): no longer ACTIVE', async () => {
    liveRoot()
    world.zone['shop.com'] = { A: ['203.0.113.50'] }
    world.https['shop.com'] = 'other'
    await cron()
    const r = db.rows.get('shop.com')!
    expect(r.status).not.toBe('ACTIVE')
    expect(issuesOf(r)).toContain('WRONG_TARGET')
  })

  it('a check that comes back with the store answering again clears the "last check found a problem" note', async () => {
    liveRoot()
    world.https['shop.com'] = 'timeout'
    await cron()
    expect(db.rows.get('shop.com')!.detail).toMatch(/^Live — the last check/)
    world.https = {}
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await cron()
    expect(db.rows.get('shop.com')).toMatchObject({ status: 'ACTIVE', detail: 'Live — the store opens on this domain with HTTPS' })
  })

  it('the HTTPS probe times out once: the live root stays ACTIVE', async () => {
    liveRoot()
    world.https['shop.com'] = 'timeout'
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })

  // Expected: a 502 from the proxy (the site behind it hiccupped) is not "another server". Today
  // NOT_STORE (error) is raised, the root drops to VERIFYING, the chip reads "Not connected" and the
  // merchant is told to "Delete any other A or AAAA record".
  it('the store answers 502 through the root proxy once: the live root stays ACTIVE, never "Another server answers"', async () => {
    liveRoot()
    world.https['shop.com'] = 'bad-gateway'
    await cron()
    const r = db.rows.get('shop.com')!
    expect(issuesOf(r)).not.toContain('NOT_STORE')
    expect(r.status).toBe('ACTIVE')
  })

  // Expected: Google's DoH answering 429 (or timing out) for the A query alone is a checker
  // failure like CHECK_FAILED. Today the AAAA/CNAME answers count as "reached", so the empty A set
  // becomes NO_RECORDS ("No DNS records found — add an A record"), pointed=false, and the root
  // drops to VERIFYING / "Not connected" even though the HTTPS probe reached the store.
  it('Google DoH rate-limits only the A query: the live root stays ACTIVE, never "No DNS records found"', async () => {
    liveRoot()
    world.dohFail = (resolver, name, type, subnet) => (resolver === 'dns.google' && name === 'shop.com' && type === 'A' && !subnet ? 'http429' : null)
    await cron()
    const r = db.rows.get('shop.com')!
    expect(issuesOf(r)).not.toContain('NO_RECORDS')
    expect(r.status).toBe('ACTIVE')
  })

  // Expected: the owner moved DNS to Cloudflare (records copied); resolvers still answer from the
  // old DNS for up to 48 hours. The store keeps answering on HTTPS, so the domain is live with an
  // issue ("Connected · issue" exists for exactly this). Today view.stale forces pointed=false, the
  // root drops to VERIFYING, the chip reads "Not connected" and every record is marked "no longer counts".
  it('nameserver switch with the records copied, resolvers lagging: the live root stays ACTIVE (with the warning)', async () => {
    liveRoot()
    world.registry['shop.com'] = { ns: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], changed: new Date(Date.now() - 2 * 3600_000).toISOString() }
    await cron()
    const r = db.rows.get('shop.com')!
    expect(issuesOf(r)).toContain('NS_SWITCHING')
    expect(r.status).toBe('ACTIVE')
  })

  // Expected: once knocked down, the next 10-minute run puts it back ("We keep checking by ourselves
  // every 10 minutes", says the panel). dueForRecheck uses created_at, not the last change, so a
  // 90-day-old domain is only re-checked after 55 minutes: it stays "Pending"/"Not connected" for an hour.
  it('a live root knocked to VERIFYING by one failed probe is ACTIVE again at the next 10-minute run', async () => {
    liveRoot()
    world.https['shop.com'] = 'timeout'
    await cron()
    world.https = {}
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })

  it('after a bad re-check (VERIFYING) the proxy may still get and renew certificates for the root and www', async () => {
    liveRoot()
    world.https['shop.com'] = 'bad-gateway'
    await cron()
    expect(db.rows.get('shop.com')!.status).not.toBe('REMOVED')
    expect(await ask('shop.com')).toBe(200)
    expect(await ask('www.shop.com')).toBe(200)
  })
})

// =============================================================================================
// 3. The re-check job and Cloudflare for SaaS (subdomain)
// =============================================================================================

describe('r3: transient failures during the re-check of a live Cloudflare subdomain', () => {
  for (const status of [500, 403]) {
    it(`Cloudflare API ${status}: status stays ACTIVE, the custom hostname is never deleted, the panel says it could not check`, async () => {
      liveSub()
      world.cfDown = status
      await cron()
      const r = db.rows.get('shop.brand.com')!
      expect(r.status).toBe('ACTIVE')
      expect(r.verified_at).not.toBeNull()
      expect(r.detail ?? '').toMatch(/Could not check right now/)
      world.cfDown = null
      expect(world.cfHosts.has('shop.brand.com')).toBe(true)
      expect(world.log.filter((l) => l.url.hostname === 'api.cloudflare.com' && l.method === 'DELETE')).toEqual([])
    })
  }

  it('the HTTPS probe times out: stays ACTIVE (DNS points and nothing blocks)', async () => {
    liveSub()
    world.https['shop.brand.com'] = 'timeout'
    await cron()
    expect(db.rows.get('shop.brand.com')!.status).toBe('ACTIVE')
  })

  it('every DoH resolver down: stays ACTIVE, the hostname kept', async () => {
    liveSub()
    world.dohFail = () => 'timeout'
    await cron()
    expect(db.rows.get('shop.brand.com')!.status).toBe('ACTIVE')
    expect(world.cfHosts.has('shop.brand.com')).toBe(true)
  })
})

// =============================================================================================
// 4. Hosting without Cloudflare (Vercel, manual): a merchant's Check during an outage
// =============================================================================================

describe('r3: a Check on other hosting', () => {
  // Expected: a Vercel API outage during the merchant's "Check again" does not mark a live domain
  // broken. inspect() returns ERROR on any non-OK answer, and recheckAll() returns "no hosting API"
  // without Cloudflare, so nothing ever re-checks it: it stays ERROR ("Not connected") until
  // someone presses Check again, losing the primary redirect and the ad beacon meanwhile.
  it('Vercel: a Check during a Vercel API outage keeps the live domain ACTIVE', async () => {
    H.env = { VERCEL_TOKEN: 'v-token', VERCEL_PROJECT_ID: 'p1' }
    world.zone['shop.com'] = { A: ['76.76.21.21'] }
    world.https['shop.com'] = 'vercel'
    seed('shop.com', 'm-a', 'ACTIVE', { verified: true, primary: true, createdDays: 90, checkedMin: 60 })
    world.vercelDown = 500
    await post({ action: 'check', domain: 'shop.com' })
    world.vercelDown = null
    await cron()
    expect(db.rows.get('shop.com')!.status).toBe('ACTIVE')
  })

  // Expected: same for manual hosting: one failed HTTPS probe during a Check turns a live domain
  // into MANUAL with "Add the DNS record below; the platform owner then connects the domain", and
  // no job ever checks it again.
  it('manual hosting: a Check whose HTTPS probe times out keeps the live domain ACTIVE', async () => {
    H.env = { CUSTOM_DOMAIN_TARGET: TARGET }
    world.zone['shop.brand.com'] = { CNAME: [TARGET] }
    seed('shop.brand.com', 'm-a', 'ACTIVE', { verified: true, primary: true, createdDays: 90, checkedMin: 60 })
    world.https['shop.brand.com'] = 'timeout'
    await post({ action: 'check', domain: 'shop.brand.com' })
    world.https = { 'shop.brand.com': 'store' }
    await cron()
    expect(db.rows.get('shop.brand.com')!.status).toBe('ACTIVE')
  })
})

// Custom-domain flows end to end, with every outside service faked. Virtual domains go through
// the domains function (add / check / remove / primary / list / recheck_all and the GET "ask"
// endpoint) against:
//   - an in-memory model of the store_domain_* database functions (latest migrations),
//   - a fake Cloudflare for SaaS API (custom hostnames that validate once their CNAME is in place),
//   - fake DNS-over-HTTPS (dns.google / cloudflare-dns.com / AdGuard) and RDAP answers,
//   - a fake web: the root proxy (Caddy) serves a domain over HTTPS only after the ask endpoint
//     says yes, and Cloudflare serves a hostname only once its custom hostname is active.
// Each test asserts the correct behaviour: a failing test marks a defect, the passing ones are
// regression coverage. No real network, database or provider is touched.
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
  const { HttpError } = await import('../_shared/http.ts')
  const adminClient = (merchant?: string | null): Client => ({ merchant: merchant ?? null, as: merchant ? 'admin' : 'platform' })
  return {
    ...real,
    adminClient,
    rpc: (client: Client, fn: string, args: Record<string, unknown> = {}) => H.rpc(client, fn, args),
    // The staff member comes from a test header: x-test-staff = their store.
    requireStaff: async (req: Request) => {
      const m = req.headers.get('x-test-staff')
      if (!m) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
      return { user: { id: `user-${m}` }, client: { merchant: m, as: 'user' }, admin: { merchant: m, as: 'admin' }, merchantId: m, role: 'OWNER', permissions: [] }
    },
    // Same contract as the real one: each store in turn, one failure does not stop the others.
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
import { createRouter, fromRootProxy, type Env } from '../../../worker/router.ts'

const IP = '144.24.232.70'
const TARGET = 'stores.fullfilio.com'
const SITE = 'https://fullfilio.com/functions/v1/domains'
const START = new Date('2026-10-19T10:00:00Z')

// --- In-memory model of the database functions ---------------------------------------------
// Mirrors the committed migrations (through 20261121000600). It only stands in for the database
// so the function's flows can run; the SQL itself is covered by supabase/tests/db. When a
// migration changes store_domain_guard / _save / _known / _set_primary, change the model too.

interface Row {
  domain: string; merchant_id: string; status: string; records: Array<{ type: string; name: string; value: string }>
  detail: string | null; diagnostics: { issues?: Array<{ code: string; severity: string; title?: string; detail?: string }>; [k: string]: unknown } | null
  is_primary: boolean; created_at: string; checked_at: string | null
  /** The ownership code (_fullfilio TXT) and when it was found. */
  verify_code: string | null; verified_at: string | null
}
const db = {
  rows: new Map<string, Row>(),
  /** _store_domain_reserved: the store root domain + platform_settings.store_domains.reserved_hosts. */
  reserved: ['fullfilio.com'],
  calls: [] as Array<{ fn: string; as: string; merchant: string | null; args: Record<string, unknown> }>,
  fail: null as null | ((fn: string) => void),
  knownOverride: undefined as unknown,
}
const trace: string[] = []
const now = () => new Date().toISOString()
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const norm = (d: unknown) => String(d ?? '').trim().toLowerCase()
const isReserved = (d: string) => db.reserved.some((h) => d === h || d.endsWith(`.${h}`))
const live = (r?: Row) => !!r && r.status !== 'REMOVED'
const twinOf = (d: string) => (d.startsWith('www.') ? d.slice(4) : `www.${d}`)
const raise = (message: string, code = 'P0001'): never => { throw fromDbError({ message, code }) }
const newRow = (domain: string, merchant: string, status: string): Row =>
  ({ domain, merchant_id: merchant, status, records: [], detail: null, diagnostics: null, is_primary: false, created_at: now(), checked_at: null, verify_code: `code-${domain}`, verified_at: null })

async function dbRpc(client: Client, fn: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  // Arguments travel as JSON (undefined keys are dropped), as with PostgREST.
  const args = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>
  db.calls.push({ fn, as: client.as, merchant: client.merchant, args })
  trace.push(`rpc:${fn}`)
  db.fail?.(fn)
  const mid = client.merchant
  const mine = () => [...db.rows.values()].filter((r) => r.merchant_id === mid)
  switch (fn) {
    case 'store_domain_guard': { // 20261121000600_domain_ownership.sql
      const d = norm(args.p_domain)
      if (!mid) raise('No merchant in context', '42501')
      if (args.p_action === 'add') {
        if (isReserved(d)) raise("DOMAIN_REJECTED: That is the platform's own domain; use your store address or a domain you own")
        const twin = db.rows.get(twinOf(d))
        if (live(twin) && twin!.merchant_id !== mid) raise('DUPLICATE: That domain is already connected to another store')
        // Removed by another store: freed (_store_domain_release).
        if (db.rows.get(d)?.status === 'REMOVED' && db.rows.get(d)!.merchant_id !== mid) db.rows.delete(d)
        if (!db.rows.has(d)) db.rows.set(d, newRow(d, mid!, 'PENDING')) // insert … on conflict (domain) do nothing
        const r = db.rows.get(d)!
        if (r.merchant_id === mid && r.status === 'REMOVED') Object.assign(r, { status: 'PENDING', is_primary: false, verified_at: null })
        if (!(r.merchant_id === mid && live(r))) raise('DUPLICATE: That domain is already connected to another store')
      } else {
        const r = db.rows.get(d)
        if (!(r && r.merchant_id === mid && live(r))) raise('NOT_FOUND: That domain is not on this store')
      }
      return null
    }
    case 'store_domain_save': { // 20261121000600_domain_ownership.sql
      const d = norm(args.p_domain)
      const p = args.p as Record<string, unknown>
      let r = db.rows.get(d)
      const status = (p.status as string | undefined) ?? r?.status ?? 'PENDING'
      if (status !== 'REMOVED') {
        if (isReserved(d)) raise("DOMAIN_REJECTED: That is the platform's own domain")
        const twin = db.rows.get(twinOf(d))
        if (live(twin) && twin!.merchant_id !== mid) raise('DUPLICATE: That domain is already connected to another store')
      }
      // Removed meanwhile: it stays removed (only the guard's add brings it back).
      if (r && r.status === 'REMOVED' && p.status !== 'REMOVED') return null
      if (!r) {
        r = newRow(d, mid!, status)
        r.is_primary = status !== 'REMOVED' && !mine().some((x) => x.is_primary && live(x))
        db.rows.set(d, r)
      } else {
        if (r.merchant_id !== mid) raise('new row violates row-level security policy for table "store_domains"', '42501')
        r.is_primary = status === 'REMOVED' ? false : r.is_primary || !mine().some((x) => x !== r && x.is_primary && live(x))
        r.status = status
      }
      if (p.records != null) r.records = p.records as Row['records']
      if ('detail' in p) r.detail = (p.detail as string | null) ?? null
      if ('diagnostics' in p) r.diagnostics = (p.diagnostics as Row['diagnostics']) ?? null
      r.verified_at = r.status === 'REMOVED' ? null : p.verified === true ? (r.verified_at ?? now()) : r.verified_at
      r.checked_at = now()
      if (r.status === 'REMOVED' && !mine().some((x) => x.is_primary && live(x))) {
        const next = mine().filter(live).sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || a.created_at.localeCompare(b.created_at))[0]
        if (next) next.is_primary = true
      }
      return { ...r }
    }
    case 'store_domains_list':
      return mine().filter(live).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => ({ ...r }))
    case 'store_domain_known': { // 20261121000600_domain_ownership.sql
      if (db.knownOverride !== undefined) return db.knownOverride
      const d = norm(args.p_domain).replace(/\.$/, '')
      const names = [d, twinOf(d)]
      return d !== '' && !isReserved(d) && [...db.rows.values()].some((r) => names.includes(r.domain) && live(r) && !!r.verified_at && !isReserved(r.domain))
    }
    case 'store_domain_set_primary': { // 20261105000100_domains_advanced.sql (row security: own store only)
      const r = db.rows.get(norm(args.p_domain))
      if (!r || r.merchant_id !== mid || !live(r)) raise('NOT_FOUND: that domain is not connected to this store', 'P0002')
      for (const x of mine()) if (live(x)) x.is_primary = false
      r!.is_primary = true
      return { ...r! }
    }
  }
  throw new Error(`unexpected rpc ${fn}`)
}

function seed(domain: string, merchant: string, status: string, o: { checkedMin?: number | null; createdDays?: number; diagnostics?: Row['diagnostics']; primary?: boolean; verified?: boolean } = {}): Row {
  const r: Row = {
    ...newRow(domain, merchant, status),
    // Seeded domains are proven the store's unless a test says otherwise.
    verified_at: o.verified === false || status === 'REMOVED' ? null : ago(60),
    created_at: ago((o.createdDays ?? 1) * 1440),
    checked_at: o.checkedMin == null ? null : ago(o.checkedMin),
    diagnostics: o.diagnostics ?? null,
    is_primary: o.primary ?? false,
  }
  db.rows.set(domain, r)
  return r
}

// --- The fake outside world ----------------------------------------------------------------

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'NS' | 'TXT' | 'CAA'
type Records = Partial<Record<RecordType, string[]>>
const CODE: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 }
interface Host {
  id: string; hostname: string; status: string
  ownership_verification?: { type: string; name: string; value: string }
  ssl: { status: string; validation_records?: Array<{ txt_name?: string; txt_value?: string }> }
}
const world = {
  zone: {} as Record<string, Records>,
  /** Domains whose owner has not added the _fullfilio TXT record (every other domain has it, with its code). */
  unproven: new Set<string>(),
  /** Forced HTTPS answer for a host; otherwise derived from DNS (see web()). */
  https: {} as Record<string, 'store' | 'other' | 'cert' | 'down'>,
  log: [] as Array<{ method: string; url: URL; body?: Record<string, unknown> }>,
  cf: {
    hosts: new Map<string, Host>(),
    mode: 'ok' as 'ok' | 'down' | '403',
    rejects: new Set<string>(),
    failDelete: false,
    sslTxt: false,
    seq: 0,
    beforeGet: null as null | ((hostname: string) => Promise<void>),
    onPost: null as null | (() => void),
    gatePost: null as null | Promise<void>,
  },
}

function answers(name: string, type: RecordType, depth = 0): Array<{ name: string; type: number; data: string }> {
  // The ownership record: _fullfilio.<domain> = fullfilio-verify=<code> (code-<domain> in this model).
  if (type === 'TXT' && name.startsWith('_fullfilio.') && db.rows.has(name.slice('_fullfilio.'.length)) && !world.unproven.has(name.slice('_fullfilio.'.length))) {
    return [{ name, type: CODE.TXT, data: `"fullfilio-verify=code-${name.slice('_fullfilio.'.length)}"` }]
  }
  const rec = world.zone[name] ?? {}
  if ((type === 'A' || type === 'AAAA') && rec.CNAME?.length && depth < 5) {
    return [{ name, type: CODE.CNAME, data: `${rec.CNAME[0]}.` }, ...answers(rec.CNAME[0], type, depth + 1)]
  }
  if (type === 'CNAME') return (rec.CNAME ?? []).map((d) => ({ name, type: CODE.CNAME, data: `${d}.` }))
  // Every apex is on Hostinger's nameservers unless the zone says otherwise.
  if (type === 'NS' && !rec.NS && apexOf(name) === name) return ['ns1.dns-parking.com', 'ns2.dns-parking.com'].map((d) => ({ name, type: CODE.NS, data: `${d}.` }))
  return (rec[type] ?? []).map((d) => ({ name, type: CODE[type], data: type === 'TXT' ? `"${d}"` : d }))
}
const addressesOf = (host: string) => answers(host, 'A').filter((a) => a.type === CODE.A).map((a) => a.data)
const cnameChain = (host: string) => answers(host, 'A').filter((a) => a.type === CODE.CNAME).map((a) => a.data.replace(/\.$/, ''))

/** Cloudflare validates a custom hostname once its DNS leads to our target. */
function settle(h: Host) {
  if (cnameChain(h.hostname).includes(TARGET)) {
    h.status = 'active'
    h.ssl = { status: 'active' }
  }
}
function cfHost(hostname: string, active = false): Host {
  const n = ++world.cf.seq
  const h: Host = active
    ? { id: `h${n}`, hostname, status: 'active', ssl: { status: 'active' } }
    : {
        id: `h${n}`, hostname, status: 'pending',
        ownership_verification: { type: 'txt', name: `_cf-custom-hostname.${hostname}`, value: `own-${n}` },
        ssl: { status: 'pending_validation', validation_records: world.cf.sslTxt ? [{ txt_name: `_acme-challenge.${hostname}`, txt_value: `ssl-${n}` }] : [] },
      }
  world.cf.hosts.set(hostname, h)
  return h
}
const cfJson = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const cfError = (status: number, code: number, message: string) => cfJson(status, { success: false, errors: [{ code, message }], result: null })

async function cloudflareApi(url: URL, method: string, body?: Record<string, unknown>): Promise<Response> {
  if (world.cf.mode === 'down') throw new TypeError('fetch failed')
  if (world.cf.mode === '403') return cfError(403, 10000, 'Authentication error')
  const base = '/client/v4/zones/zone1/custom_hostnames'
  if (!url.pathname.startsWith(base)) return cfError(404, 7003, 'No route for that URI')
  const rest = url.pathname.slice(base.length)
  if (rest === '' && method === 'GET') {
    const name = url.searchParams.get('hostname') ?? ''
    if (world.cf.beforeGet) {
      const run = world.cf.beforeGet
      world.cf.beforeGet = null
      await run(name)
    }
    const h = world.cf.hosts.get(name)
    if (h) settle(h)
    return cfJson(200, { success: true, result: h ? [structuredClone(h)] : [] })
  }
  if (rest === '' && method === 'POST') {
    const name = String(body?.hostname)
    world.cf.onPost?.()
    if (world.cf.gatePost) {
      const gate = world.cf.gatePost
      world.cf.gatePost = null
      await gate
    }
    if (world.cf.rejects.has(name)) return cfError(400, 1409, 'The custom hostname is prohibited')
    if (world.cf.hosts.has(name)) return cfError(409, 1406, 'Duplicate custom hostname found.')
    return cfJson(201, { success: true, result: structuredClone(cfHost(name)) })
  }
  const h = [...world.cf.hosts.values()].find((x) => x.id === rest.slice(1))
  if (method === 'PATCH') {
    if (!h) return cfError(404, 1436, 'The custom hostname was not found')
    settle(h)
    return cfJson(200, { success: true, result: structuredClone(h) })
  }
  if (method === 'DELETE') {
    if (world.cf.failDelete) return cfError(500, 1000, 'Internal error')
    if (!h) return cfError(404, 1436, 'The custom hostname was not found')
    world.cf.hosts.delete(h.hostname)
    return cfJson(200, { success: true, result: { id: h.id } })
  }
  return cfError(405, 10405, 'Method not allowed')
}

/** HTTPS to a merchant domain: the root proxy asks the domains function first, as Caddy does. */
async function web(url: URL): Promise<Response> {
  const host = url.hostname
  let mode = world.https[host]
  if (!mode) {
    const ips = addressesOf(host)
    if (cnameChain(host).includes(TARGET)) {
      const h = world.cf.hosts.get(host)
      mode = h?.status === 'active' && h.ssl.status === 'active' ? 'store' : 'cert'
    } else if (ips.length > 0 && ips.every((ip) => ip === IP)) {
      const asked = await handler(new Request(`${SITE}?domain=${encodeURIComponent(host)}`))
      mode = asked.status === 200 ? 'store' : 'cert'
    } else {
      mode = 'down'
    }
  }
  if (mode === 'cert') throw new Error('tls: unable to get local issuer certificate')
  if (mode === 'down') throw new Error('connect ECONNREFUSED')
  return new Response('<html></html>', { status: 200, headers: mode === 'store' ? { 'x-fullfilio': 'store', server: 'cloudflare' } : { server: 'nginx' } })
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
  world.log.push({ method, url, body })
  trace.push(`fetch:${url.hostname}`)
  switch (url.hostname) {
    case 'dns.google': case 'cloudflare-dns.com': case 'dns.adguard-dns.com': {
      const name = (url.searchParams.get('name') ?? '').replace(/\.$/, '')
      return Response.json({ Status: 0, Answer: answers(name, url.searchParams.get('type') as RecordType) })
    }
    case 'rdap.org': return new Response('not found', { status: 404 })
    case 'api.cloudflare.com': return cloudflareApi(url, method, body)
    default: return web(url)
  }
}

// --- Calling the function ------------------------------------------------------------------

type Body = { domain?: Row; domains?: Row[]; error?: { code: string; message: string }; [k: string]: unknown }
async function post(payload: unknown, staff: string | null = 'm-a', headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
  const res = await handler(new Request(SITE, {
    method: 'POST', body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...(staff ? { 'x-test-staff': staff } : {}), ...headers },
  }))
  return { status: res.status, body: await res.json() as Body }
}
const cron = () => post({ action: 'recheck_all' }, null, { 'x-cron-secret': 'cron-secret-for-tests' })
/** Add, then Check: the first add never looks the ownership TXT up (the merchant has not seen the code yet). */
async function addAndCheck(domain: string, staff = 'm-a') {
  await post({ action: 'add', domain }, staff)
  return post({ action: 'check', domain }, staff)
}
async function ask(domain: string | null) {
  const res = await handler(new Request(domain === null ? SITE : `${SITE}?domain=${encodeURIComponent(domain)}`))
  return { status: res.status, text: await res.text(), cache: res.headers.get('cache-control') }
}
const cfCalls = () => world.log.filter((l) => l.url.hostname === 'api.cloudflare.com')
const cfPosts = () => cfCalls().filter((l) => l.method === 'POST')
const guardCalls = () => db.calls.filter((c) => c.fn === 'store_domain_guard')
const recordsOf = (r: Row | undefined) => (r?.records ?? []).map((x) => [x.type, x.name, x.value])
const issueCodes = (r: Row | undefined) => (r?.diagnostics?.issues ?? []).map((i) => i.code)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  vi.stubGlobal('fetch', fakeFetch)
  H.env = { CF_SAAS_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone1', CUSTOM_DOMAIN_TARGET: TARGET, ROOT_DOMAIN_IP: IP }
  H.rpc = dbRpc
  H.logs = []
  H.merchants = ['m-a', 'm-b', 'm-c']
  db.rows = new Map()
  world.unproven = new Set()
  db.reserved = ['fullfilio.com']
  db.calls = []
  db.fail = null
  db.knownOverride = undefined
  trace.length = 0
  world.zone = { [TARGET]: { A: ['104.21.50.1'], AAAA: ['2606:4700:3030::6815:3201'] } }
  world.https = {}
  world.log = []
  world.cf = { hosts: new Map(), mode: 'ok', rejects: new Set(), failDelete: false, sslTxt: false, seq: 0, beforeGet: null, onPost: null, gatePost: null }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// =============================================================================================

describe('root domain on the proxy (ROOT_DOMAIN_IP set)', () => {
  it('adding shop.com creates no Cloudflare custom hostname and asks for A @ and A www', async () => {
    const res = await post({ action: 'add', domain: 'shop.com' })
    expect(res.status).toBe(200)
    expect(res.body.automatic).toBe(true)
    expect(trace[0]).toBe('rpc:store_domain_guard')
    expect(guardCalls()[0].args).toEqual({ p_domain: 'shop.com', p_action: 'add' })
    expect(cfCalls()).toEqual([])
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('VERIFYING')
    expect(recordsOf(row)).toEqual([['A', '@', IP], ['A', 'www', IP], ['TXT', '_fullfilio', 'fullfilio-verify=code-shop.com']])
    expect(issueCodes(row)).toContain('NO_RECORDS')
  })

  it('goes ACTIVE once A @ points at the proxy, the TXT is there and the store answers over HTTPS (no Cloudflare)', async () => {
    world.zone['shop.com'] = { A: [IP] }
    world.zone['www.shop.com'] = { A: [IP] }
    const added = await post({ action: 'add', domain: 'shop.com' })
    expect(added.body.domain).toMatchObject({ domain: 'shop.com', status: 'VERIFYING', detail: 'Waiting for the TXT record below (it proves the domain is yours)', is_primary: true })
    const checked = await post({ action: 'check', domain: 'shop.com' })
    expect(checked.body.domain).toMatchObject({ status: 'ACTIVE', detail: 'Live — the store opens on this domain with HTTPS' })
    expect(issueCodes(db.rows.get('shop.com'))).toEqual([])
    expect(cfCalls()).toEqual([])
  })

  it('with the A record right but no certificate yet, it waits for the first visit', async () => {
    world.zone['shop.com'] = { A: [IP] }
    world.https['shop.com'] = 'cert'
    await addAndCheck('shop.com')
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('VERIFYING')
    expect(row.detail).toBe('DNS is right — the HTTPS certificate is issued on the first visit (usually under a minute)')
  })

  it('an A record to another server is never live, even when that server answers HTTPS', async () => {
    world.zone['shop.com'] = { A: ['23.227.38.65'] }
    world.https['shop.com'] = 'other'
    await post({ action: 'add', domain: 'shop.com' })
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('VERIFYING')
    expect(issueCodes(row)).toEqual(expect.arrayContaining(['OLD_HOST', 'WRONG_TARGET']))
  })

  it('ROOT_DOMAIN_IPV6 adds AAAA records for @ and www', async () => {
    H.env.ROOT_DOMAIN_IPV6 = '2001:db8::70'
    await post({ action: 'add', domain: 'shop.com' })
    expect(recordsOf(db.rows.get('shop.com'))).toEqual([['A', '@', IP], ['AAAA', '@', '2001:db8::70'], ['A', 'www', IP], ['AAAA', 'www', '2001:db8::70'], ['TXT', '_fullfilio', 'fullfilio-verify=code-shop.com']])
  })

  it('a missing www record is a warning on the root, never holding it back', async () => {
    world.zone['shop.com'] = { A: [IP] }
    await addAndCheck('shop.com')
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('ACTIVE')
    expect(row.diagnostics?.issues).toEqual([expect.objectContaining({ code: 'WWW_SETUP', severity: 'warning' })])
  })

  it('shop.com.bd is a root on the proxy too (no Cloudflare, A @ and A www)', async () => {
    await post({ action: 'add', domain: 'shop.com.bd' })
    expect(cfCalls()).toEqual([])
    expect(recordsOf(db.rows.get('shop.com.bd'))).toEqual([['A', '@', IP], ['A', 'www', IP], ['TXT', '_fullfilio', 'fullfilio-verify=code-shop.com.bd']])
  })

  it('removing a proxied root does not depend on Cloudflare being reachable', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true })
    world.cf.mode = 'down'
    const res = await post({ action: 'remove', domain: 'shop.com' })
    expect(res.status).toBe(200)
    expect(db.rows.get('shop.com')!.status).toBe('REMOVED')
  })

  it("refuses the platform's own apex even on the proxy path (defence in depth when the guard lets it through)", async () => {
    db.reserved = [] // e.g. reserved_hosts edited in platform settings
    const res = await post({ action: 'add', domain: 'fullfilio.com' })
    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('DOMAIN_REJECTED')
  })
})

describe('without ROOT_DOMAIN_IP (Cloudflare only, the old path)', () => {
  beforeEach(() => { delete H.env.ROOT_DOMAIN_IP })

  it('a root is attached as a custom hostname once proven and asks for a CNAME at @ (Cloudflare DNS needed)', async () => {
    expect((await post({ action: 'add', domain: 'shop.com' })).status).toBe(200)
    expect(cfPosts()).toEqual([])
    const res = await post({ action: 'check', domain: 'shop.com' })
    expect(res.status).toBe(200)
    expect(cfPosts().map((c) => c.body?.hostname)).toEqual(['shop.com'])
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('VERIFYING')
    expect(recordsOf(row)[0]).toEqual(['CNAME', '@', TARGET])
    expect(issueCodes(row)).toContain('NEEDS_CLOUDFLARE')
  })

  it('list says root_ip null without ROOT_DOMAIN_IP, and the address with it', async () => {
    expect((await post({ action: 'list' })).body).toMatchObject({ domains: [], automatic: true, root_ip: null })
    H.env.ROOT_DOMAIN_IP = IP
    expect((await post({ action: 'list' })).body.root_ip).toBe(IP)
  })
})

describe('subdomain on Cloudflare for SaaS', () => {
  it('once proven, the custom hostname is created and its ownership and certificate TXT records are listed', async () => {
    world.cf.sslTxt = true
    const res = await addAndCheck('shop.example.com')
    expect(res.status).toBe(200)
    expect(cfPosts()[0].body).toEqual({ hostname: 'shop.example.com', ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } })
    const row = db.rows.get('shop.example.com')!
    expect(row.status).toBe('VERIFYING')
    expect(recordsOf(row)).toEqual([
      ['CNAME', 'shop', TARGET],
      ['TXT', '_cf-custom-hostname.shop', 'own-1'],
      ['TXT', '_acme-challenge.shop', 'ssl-1'],
    ])
  })

  it('an already attached hostname (Cloudflare 1406) is fine', async () => {
    cfHost('shop.example.com')
    const res = await post({ action: 'add', domain: 'shop.example.com' })
    expect(res.status).toBe(200)
    expect(world.cf.hosts.size).toBe(1)
  })

  it('Cloudflare refusing (403) answers a clear error and is logged', async () => {
    expect((await post({ action: 'add', domain: 'shop.example.com' })).status).toBe(200)
    world.cf.mode = '403'
    const res = await post({ action: 'check', domain: 'shop.example.com' })
    expect(res.status).toBe(502)
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', message: 'Cloudflare answered: Authentication error' })
    expect(H.logs).toContainEqual(expect.objectContaining({ level: 'WARN', message: expect.stringContaining('shop.example.com') }))
  })

  it('Cloudflare unreachable on add answers 502 UPSTREAM_ERROR, not a generic 500', async () => {
    world.cf.mode = 'down'
    const res = await post({ action: 'add', domain: 'shop.example.com' })
    expect(res.status).toBe(502)
    expect(res.body.error?.code).toBe('UPSTREAM_ERROR')
  })

  it('pending → active once the CNAME is in place; the TXT records are no longer asked for', async () => {
    await post({ action: 'add', domain: 'shop.example.com' })
    expect(db.rows.get('shop.example.com')!.status).toBe('VERIFYING')
    world.zone['shop.example.com'] = { CNAME: [TARGET] }
    const res = await post({ action: 'check', domain: 'shop.example.com' })
    expect(res.body.domain?.status).toBe('ACTIVE')
    expect(recordsOf(res.body.domain)).toEqual([['CNAME', 'shop', TARGET]])
  })

  it('check asks Cloudflare to validate again while the hostname is pending (PATCH ssl)', async () => {
    seed('shop.example.com', 'm-a', 'VERIFYING')
    const h = cfHost('shop.example.com')
    await post({ action: 'check', domain: 'shop.example.com' })
    expect(cfCalls().find((c) => c.method === 'PATCH')).toMatchObject({ url: expect.objectContaining({ pathname: `/client/v4/zones/zone1/custom_hostnames/${h.id}` }), body: { ssl: expect.objectContaining({ method: 'http' }) } })
  })

  it('a hostname deleted on the Cloudflare side is attached again by check', async () => {
    seed('shop.example.com', 'm-a', 'VERIFYING')
    world.zone['shop.example.com'] = { CNAME: [TARGET] }
    const res = await post({ action: 'check', domain: 'shop.example.com' })
    expect(cfPosts().map((c) => c.body?.hostname)).toEqual(['shop.example.com'])
    expect(res.body.domain?.status).toBe('ACTIVE')
  })

  it('recheck_all attaches a waiting domain again when Cloudflare lost it', async () => {
    seed('shop.example.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    const res = await cron()
    expect(res.body).toMatchObject({ checked: 1, live: 0, failed: 0 })
    expect(world.cf.hosts.has('shop.example.com')).toBe(true)
    expect(db.rows.get('shop.example.com')!.checked_at).toBe(now())
  })

  it("a platform subdomain is refused before any Cloudflare call even if the guard let it through", async () => {
    db.reserved = []
    const res = await post({ action: 'add', domain: 'shop.fullfilio.com' })
    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('DOMAIN_REJECTED')
    expect(cfPosts()).toEqual([])
  })

  it('an un-normalised CUSTOM_DOMAIN_TARGET (trailing dot) still protects the platform subdomains', async () => {
    db.reserved = []
    H.env.CUSTOM_DOMAIN_TARGET = `${TARGET}.`
    const res = await post({ action: 'add', domain: 'shop.fullfilio.com' })
    expect(res.status).toBe(422)
    expect(cfPosts()).toEqual([])
  })
})

describe('www twin next to a proxied root', () => {
  it('www.shop.com added next to a proxied shop.com goes live once www leads to the proxy (as the root asks)', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true, createdDays: 10 })
    world.zone['shop.com'] = { A: [IP] }
    world.zone['www.shop.com'] = { A: [IP] }
    expect((await post({ action: 'add', domain: 'www.shop.com' })).status).toBe(200)
    const res = await post({ action: 'check', domain: 'www.shop.com' })
    // It is live: the proxy serves it with a certificate and the store answers.
    expect(await ask('www.shop.com')).toMatchObject({ status: 200 })
    expect(res.body.domain?.status).toBe('ACTIVE')
  })

  it('shop.com added next to a www.shop.com already on Cloudflare: the root goes to the proxy, www is listed beside it', async () => {
    seed('www.shop.com', 'm-a', 'ACTIVE', { primary: true })
    cfHost('www.shop.com', true)
    world.zone['www.shop.com'] = { CNAME: [TARGET] }
    world.zone['shop.com'] = { A: [IP] }
    const res = await post({ action: 'add', domain: 'shop.com' })
    expect(res.status).toBe(200)
    expect(cfPosts()).toEqual([])
    const row = db.rows.get('shop.com')!
    expect(row.status).toBe('ACTIVE')
    expect(row.is_primary).toBe(false)
    expect((row.diagnostics?.records as Array<{ name: string }>).some((r) => r.name === 'www')).toBe(true)
  })
})

describe('ownership: check / remove / primary', () => {
  it("another store's domain is refused before any provider or DNS call", async () => {
    seed('shop.example.com', 'm-b', 'ACTIVE')
    cfHost('shop.example.com', true)
    for (const action of ['check', 'remove', 'primary']) {
      const res = await post({ action, domain: 'shop.example.com' })
      expect(res.status).toBe(404)
      expect(res.body.error?.code).toBe('NOT_FOUND')
    }
    expect(world.log).toEqual([])
    expect(world.cf.hosts.has('shop.example.com')).toBe(true)
    expect(db.rows.get('shop.example.com')!.status).toBe('ACTIVE')
  })

  it('a removed domain cannot be checked, removed or made primary', async () => {
    seed('shop.example.com', 'm-a', 'REMOVED')
    for (const action of ['check', 'remove', 'primary']) expect((await post({ action, domain: 'shop.example.com' })).status).toBe(404)
    expect(world.log).toEqual([])
  })

  it('a twin that is not its own row cannot be checked, removed or made primary', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true })
    for (const action of ['check', 'remove', 'primary']) expect((await post({ action, domain: 'www.shop.com' })).status).toBe(404)
    expect(db.rows.has('www.shop.com')).toBe(false)
  })

  it('primary goes through the staff client (row security) with the normalised name', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true })
    seed('other.com', 'm-a', 'ACTIVE')
    const res = await post({ action: 'primary', domain: '  HTTPS://Other.COM/  ' })
    expect(res.body.domain).toMatchObject({ domain: 'other.com', is_primary: true })
    expect(db.calls.find((c) => c.fn === 'store_domain_set_primary')).toMatchObject({ as: 'user', merchant: 'm-a', args: { p_domain: 'other.com' } })
    expect(db.rows.get('shop.com')!.is_primary).toBe(false)
  })

  it('an unsigned caller is refused before the guard', async () => {
    expect((await post({ action: 'check', domain: 'shop.com' }, null)).status).toBe(401)
    expect(db.calls).toEqual([])
  })

  it("the platform's own domains get a clear 422 refusal, not 'Something went wrong' (500)", async () => {
    for (const d of ['fullfilio.com', TARGET, 'shop.fullfilio.com']) {
      const res = await post({ action: 'add', domain: d })
      expect(res.status).toBe(422)
      expect(res.body.error?.code).toBe('DOMAIN_REJECTED')
    }
    expect(cfCalls()).toEqual([])
  })
})

describe('input normalisation', () => {
  beforeEach(() => { seed('shop.com', 'm-a', 'ACTIVE', { primary: true }) })

  it('URLs, case and spaces are reduced to the bare name', async () => {
    for (const input of ['https://Shop.com/path', '  SHOP.COM  ', 'http://shop.com/', 'shop.com/checkout/x']) {
      db.calls = []
      expect((await post({ action: 'primary', domain: input })).status).toBe(200)
      expect(guardCalls()[0].args.p_domain).toBe('shop.com')
    }
  })

  it('a trailing dot and a port are dropped, not refused', async () => {
    for (const input of ['SHOP.COM.', 'shop.com:443', 'https://shop.com:443/checkout']) {
      db.calls = []
      const res = await post({ action: 'primary', domain: input })
      expect(res.status, input).toBe(200)
      expect(guardCalls()[0]?.args.p_domain).toBe('shop.com')
    }
  })

  it('an internationalised name (münchen.de) is converted to punycode', async () => {
    seed('xn--mnchen-3ya.de', 'm-a', 'ACTIVE')
    const res = await post({ action: 'primary', domain: 'münchen.de' })
    expect(res.status).toBe(200)
    expect(guardCalls()[0]?.args.p_domain).toBe('xn--mnchen-3ya.de')
  })

  it('punycode is accepted as it is', async () => {
    seed('xn--mnchen-3ya.de', 'm-a', 'ACTIVE')
    expect((await post({ action: 'primary', domain: 'xn--mnchen-3ya.de' })).status).toBe(200)
  })

  it('names that are not a public host name are refused before the guard', async () => {
    const bad = ['localhost', IP, '*.shop.com', '-bad-.com', 'bad-.com', `${'a'.repeat(64)}.com`, 'shop .com', '', 'shop', 'http://', '[::1]', 'shop_name.com', 'shop.c', 'javascript:alert(1)']
    for (const input of bad) {
      const res = await post({ action: 'add', domain: input })
      expect(res.status, input).toBe(422)
      expect(res.body.error?.code).toBe('VALIDATION')
    }
    expect(guardCalls()).toEqual([])
    expect(world.log).toEqual([])
  })

  it('a name over 253 characters is refused before the guard and Cloudflare', async () => {
    const long = `${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.com` // 259 characters, every label valid
    const res = await post({ action: 'add', domain: long })
    expect(res.status).toBe(422)
    expect(guardCalls()).toEqual([])
    expect(db.rows.has(long)).toBe(false)
  })
})

describe('remove', () => {
  it('a subdomain is deleted at Cloudflare, saved REMOVED, and leaves the list and the ask', async () => {
    seed('sub.shop.com', 'm-a', 'ACTIVE', { primary: true })
    const h = cfHost('sub.shop.com', true)
    const res = await post({ action: 'remove', domain: 'sub.shop.com' })
    expect(res).toEqual({ status: 200, body: { ok: true } })
    expect(cfCalls().filter((c) => c.method === 'DELETE').map((c) => c.url.pathname)).toEqual([`/client/v4/zones/zone1/custom_hostnames/${h.id}`])
    expect(db.rows.get('sub.shop.com')).toMatchObject({ status: 'REMOVED', is_primary: false })
    expect((await post({ action: 'list' })).body.domains).toEqual([])
    expect((await ask('sub.shop.com')).status).toBe(404)
  })

  it('a proxied root is saved REMOVED with no Cloudflare DELETE; the next domain becomes primary', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true, createdDays: 5 })
    seed('other.shop.org', 'm-a', 'ACTIVE', { createdDays: 2 })
    await post({ action: 'remove', domain: 'shop.com' })
    expect(cfCalls().filter((c) => c.method === 'DELETE')).toEqual([])
    expect(db.rows.get('shop.com')!.status).toBe('REMOVED')
    expect(db.rows.get('other.shop.org')!.is_primary).toBe(true)
    expect((await ask('shop.com')).status).toBe(404)
    expect((await ask('www.shop.com')).status).toBe(404)
  })

  it('Cloudflare refusing the DELETE keeps the domain as it was (no half-removed state)', async () => {
    seed('sub.shop.com', 'm-a', 'ACTIVE')
    cfHost('sub.shop.com', true)
    world.cf.failDelete = true
    const res = await post({ action: 'remove', domain: 'sub.shop.com' })
    expect(res.status).toBe(422)
    expect(db.rows.get('sub.shop.com')!.status).toBe('ACTIVE')
  })
})

describe('recheck_all (cron)', () => {
  it('refuses a call without the cron secret', async () => {
    seed('shop.example.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    expect((await post({ action: 'recheck_all' }, null)).status).toBe(401)
    expect((await post({ action: 'recheck_all' }, null, { 'x-cron-secret': 'guess' })).status).toBe(401)
    expect(db.calls).toEqual([])
    expect(world.log).toEqual([])
  })

  it('checks at most 15 domains per run, the longest-waiting first', async () => {
    for (let i = 1; i <= 20; i++) {
      seed(`d${i}.example.com`, 'm-a', 'VERIFYING', { checkedMin: 30 + i })
      cfHost(`d${i}.example.com`)
    }
    const res = await cron()
    expect(res.body.checked).toBe(15)
    const fresh = [...db.rows.values()].filter((r) => r.checked_at === now()).map((r) => r.domain)
    expect(fresh).toHaveLength(15)
    expect(fresh).not.toContain('d1.example.com')
    expect(fresh).toContain('d20.example.com')
  })

  it('a domain that throws does not stop the others and is logged', async () => {
    seed('bad.example.com', 'm-a', 'PENDING', { checkedMin: 120 })
    world.cf.rejects.add('bad.example.com')
    seed('good.example.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    cfHost('good.example.com')
    const res = await cron()
    expect(res.body).toMatchObject({ checked: 2, failed: 0 })
    expect(db.rows.get('good.example.com')!.checked_at).toBe(now())
    expect(H.logs).toContainEqual(expect.objectContaining({ level: 'WARN', message: expect.stringContaining('Could not re-check bad.example.com') }))
  })

  it('a domain whose check keeps failing does not hold a slot on every run', async () => {
    // A failed add leaves the guard's PENDING row behind (never checked): 15 of them.
    for (let i = 1; i <= 15; i++) {
      seed(`f${i}.bad.com`, 'm-a', 'PENDING')
      world.cf.rejects.add(`f${i}.bad.com`)
    }
    seed('ready.example.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    cfHost('ready.example.com')
    world.zone['ready.example.com'] = { CNAME: [TARGET] }
    for (let run = 0; run < 3; run++) {
      await cron()
      vi.setSystemTime(Date.now() + 10 * 60_000)
    }
    expect(db.rows.get('ready.example.com')!.status).toBe('ACTIVE')
  })

  it("one store's waiting domains do not starve every other store", async () => {
    for (let i = 1; i <= 15; i++) {
      seed(`w${i}.busy.com`, 'm-a', 'VERIFYING', { checkedMin: 20 })
      cfHost(`w${i}.busy.com`)
    }
    seed('ready.other.com', 'm-b', 'VERIFYING', { checkedMin: 15 })
    cfHost('ready.other.com')
    world.zone['ready.other.com'] = { CNAME: [TARGET] }
    for (let run = 0; run < 3; run++) {
      await cron()
      vi.setSystemTime(Date.now() + 10 * 60_000)
    }
    expect(db.rows.get('ready.other.com')!.status).toBe('ACTIVE')
  })

  it('a live domain is checked again later, so DNS that broke is noticed', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { primary: true, checkedMin: 2 * 1440, createdDays: 30, diagnostics: { issues: [] } })
    world.zone['shop.com'] = { A: ['23.227.38.65'] } // moved back to the old shop
    await cron()
    expect(db.rows.get('shop.com')!.status).not.toBe('ACTIVE')
  })

  it('a live domain whose last check showed an error is checked again (and settles)', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { checkedMin: 20, diagnostics: { issues: [{ code: 'OLD_HOST', severity: 'error' }] } })
    world.zone['shop.com'] = { A: [IP] }
    world.zone['www.shop.com'] = { A: [IP] }
    const res = await cron()
    expect(res.body).toMatchObject({ checked: 1, live: 1 })
    expect(db.rows.get('shop.com')).toMatchObject({ status: 'ACTIVE', checked_at: now() })
    expect(issueCodes(db.rows.get('shop.com'))).toEqual([])
  })

  it('without the hosting API it says so and touches nothing', async () => {
    delete H.env.CF_SAAS_API_TOKEN
    seed('shop.example.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    expect((await cron()).body).toEqual({ checked: 0, live: 0, skipped: 'no hosting API' })
    expect(world.log).toEqual([])
  })

  it('a domain removed while recheck_all is checking it stays removed and detached at Cloudflare', async () => {
    seed('sub.shop.com', 'm-a', 'VERIFYING', { checkedMin: 60 })
    cfHost('sub.shop.com')
    // The staff member presses Remove while the scheduled run is between its list and its save.
    world.cf.beforeGet = async () => {
      expect((await post({ action: 'remove', domain: 'sub.shop.com' })).status).toBe(200)
    }
    await cron()
    expect(db.rows.get('sub.shop.com')!.status).toBe('REMOVED')
    expect(world.cf.hosts.has('sub.shop.com')).toBe(false)
  })
})

describe('concurrency', () => {
  it('two staff adding the same subdomain at once: one hostname, one row, both answered', async () => {
    const [a, b] = await Promise.all([post({ action: 'add', domain: 'sub.shop.com' }), post({ action: 'add', domain: 'sub.shop.com' })])
    expect([a.status, b.status]).toEqual([200, 200])
    await Promise.all([post({ action: 'check', domain: 'sub.shop.com' }), post({ action: 'check', domain: 'sub.shop.com' })])
    expect(world.cf.hosts.size).toBe(1)
    expect([...db.rows.keys()]).toEqual(['sub.shop.com'])
  })

  it('a check while another check is still waiting on Cloudflare attaches the hostname once', async () => {
    await post({ action: 'add', domain: 'sub.shop.com' })
    let arrived!: () => void
    const postArrived = new Promise<void>((r) => { arrived = r })
    let release!: () => void
    world.cf.gatePost = new Promise<void>((r) => { release = r })
    world.cf.onPost = () => { world.cf.onPost = null; arrived() }
    const adding = post({ action: 'check', domain: 'sub.shop.com' })
    await postArrived
    const checked = await post({ action: 'check', domain: 'sub.shop.com' })
    release()
    const added = await adding
    expect([added.status, checked.status]).toEqual([200, 200])
    expect(world.cf.hosts.size).toBe(1)
    expect(db.rows.get('sub.shop.com')!.status).toBe('VERIFYING')
  })

  it('two stores adding the same domain at once: only one of them gets it', async () => {
    const [a, b] = await Promise.all([post({ action: 'add', domain: 'race.com' }, 'm-a'), post({ action: 'add', domain: 'race.com' }, 'm-b')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(db.rows.get('race.com')!.merchant_id).toBe(a.status === 200 ? 'm-a' : 'm-b')
  })
})

describe('GET ask endpoint (root proxy certificates)', () => {
  it('answers 200 only when store_domain_known is exactly true, never cached', async () => {
    seed('shop.com', 'm-a', 'PENDING')
    expect(await ask('shop.com')).toEqual({ status: 200, text: 'ok', cache: 'no-store' })
    expect(await ask('nobody.com')).toEqual({ status: 404, text: 'unknown domain', cache: 'no-store' })
    db.knownOverride = 'true'
    expect((await ask('shop.com')).status).toBe(404)
    db.knownOverride = null
    expect((await ask('shop.com')).status).toBe(404)
  })

  it('normalises case and spaces before asking the database', async () => {
    seed('shop.com', 'm-a', 'PENDING')
    expect((await ask(' Shop.COM ')).status).toBe(200)
    expect(db.calls.at(-1)).toMatchObject({ fn: 'store_domain_known', as: 'platform', args: { p_domain: 'shop.com' } })
  })

  it('is cheap: one database call per ask and no provider call', async () => {
    await ask('shop.com')
    expect(db.calls.map((c) => c.fn)).toEqual(['store_domain_known'])
    expect(world.log).toEqual([])
  })

  it('a trailing dot, a port, empty or malformed values never reach the database', async () => {
    seed('shop.com', 'm-a', 'ACTIVE')
    for (const value of [null, '', 'shop.com.', 'shop.com:443', '..', 'a b.com', "shop.com';--", '<script>', 'x'.repeat(5000), IP, 'localhost']) {
      expect((await ask(value)).status, String(value).slice(0, 20)).toBe(404)
    }
    expect(db.calls).toEqual([])
  })

  it('a name over 253 characters never reaches the database', async () => {
    const long = `${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.com`
    expect((await ask(long)).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('a database failure never answers 200 (fails closed)', async () => {
    db.fail = (fn) => { if (fn === 'store_domain_known') throw fromDbError({ message: 'connection refused' }) }
    expect((await ask('shop.com')).status).not.toBe(200)
  })

  it('reaches the domains function through the Worker router with its query', async () => {
    seed('shop.com', 'm-a', 'ACTIVE')
    const router = createRouter({ ASSETS: { fetch: async () => new Response('asset') }, SUPABASE_URL: 'https://db.example.supabase.co' } as unknown as Env, { domains: handler })
    const res = await router.route(new Request(`${SITE}?domain=Shop.com`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('root proxy headers (worker/router.ts fromRootProxy)', () => {
  const SECRET = 'root-proxy-secret-0123456789'
  const upstream = (headers: HeadersInit) => new Request('https://stores.fullfilio.com/products/a', { headers })

  it('without the secret the proxy headers are dropped and nothing changes', () => {
    const out = fromRootProxy(upstream({ 'x-fullfilio-host': 'victim.com', 'x-fullfilio-client-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' }), SECRET)
    expect(out.url).toBe('https://stores.fullfilio.com/products/a')
    expect(out.headers.get('x-fullfilio-host')).toBeNull()
    expect(out.headers.get('cf-connecting-ip')).toBe('203.0.113.9')
  })

  it('the secret is case-sensitive; the header names are not', () => {
    const wrongCase = fromRootProxy(upstream({ 'x-fullfilio-proxy': SECRET.toUpperCase(), 'x-fullfilio-host': 'shop.com' }), SECRET)
    expect(new URL(wrongCase.url).host).toBe('stores.fullfilio.com')
    const shouting = fromRootProxy(upstream({ 'X-FULLFILIO-PROXY': SECRET, 'X-Fullfilio-Host': 'Shop.com', 'X-FULLFILIO-CLIENT-IP': '198.51.100.7' }), SECRET)
    expect(new URL(shouting.url).host).toBe('shop.com')
    expect(shouting.headers.get('cf-connecting-ip')).toBe('198.51.100.7')
  })

  it('duplicated proxy headers are not trusted', () => {
    const h = new Headers({ 'x-fullfilio-host': 'shop.com' })
    h.append('x-fullfilio-proxy', SECRET)
    h.append('x-fullfilio-proxy', SECRET)
    expect(new URL(fromRootProxy(upstream(h), SECRET).url).host).toBe('stores.fullfilio.com')
    const twoHosts = new Headers({ 'x-fullfilio-proxy': SECRET })
    twoHosts.append('x-fullfilio-host', 'shop.com')
    twoHosts.append('x-fullfilio-host', 'victim.com')
    const out = fromRootProxy(upstream(twoHosts), SECRET)
    expect(new URL(out.url).host).toBe('stores.fullfilio.com')
    expect(out.headers.get('x-fullfilio-host')).toBeNull()
  })

  it('X-Fullfilio-Host decides the host only with the secret; a different Host header changes nothing', () => {
    const trusted = fromRootProxy(upstream({ host: 'evil.com', 'x-fullfilio-proxy': SECRET, 'x-fullfilio-host': 'shop.com:443' }), SECRET)
    expect(new URL(trusted.url).host).toBe('shop.com')
    const spoofed = fromRootProxy(upstream({ host: 'evil.com', 'x-fullfilio-host': 'shop.com' }), SECRET)
    expect(new URL(spoofed.url).host).toBe('stores.fullfilio.com')
  })

  it('only one well-formed client IP is passed on', () => {
    for (const ip of ['198.51.100.7, 203.0.113.1', 'not-an-ip', '']) {
      const out = fromRootProxy(upstream({ 'x-fullfilio-proxy': SECRET, 'x-fullfilio-host': 'shop.com', 'x-fullfilio-client-ip': ip, 'cf-connecting-ip': '192.0.2.10' }), SECRET)
      expect(out.headers.get('cf-connecting-ip')).toBe('192.0.2.10')
    }
  })
})

// =============================================================================================

describe('ownership (TXT _fullfilio with the store\'s code)', () => {
  it('a root without the record never goes live or gets a certificate; with it, it goes live in that same check', async () => {
    world.zone['shop.com'] = { A: [IP] }
    world.zone['www.shop.com'] = { A: [IP] }
    world.unproven.add('shop.com')
    await post({ action: 'add', domain: 'shop.com' })
    const added = await post({ action: 'check', domain: 'shop.com' })
    expect(added.body.domain).toMatchObject({ status: 'VERIFYING', detail: 'Verification record missing' })
    expect(recordsOf(db.rows.get('shop.com'))).toContainEqual(['TXT', '_fullfilio', 'fullfilio-verify=code-shop.com'])
    expect(issueCodes(db.rows.get('shop.com'))).toContain('TXT_MISSING')
    expect((await ask('shop.com')).status).toBe(404)
    expect((await ask('www.shop.com')).status).toBe(404)

    world.unproven.delete('shop.com')
    const checked = await post({ action: 'check', domain: 'shop.com' })
    expect(checked.body.domain).toMatchObject({ status: 'ACTIVE' })
    expect(db.rows.get('shop.com')!.verified_at).not.toBeNull()
    // Proven once is enough: the record is no longer asked for.
    expect(recordsOf(db.rows.get('shop.com')).some(([type]) => type === 'TXT')).toBe(false)
    expect((await ask('www.shop.com')).status).toBe(200)
  })

  it('a store that claims someone else\'s domain never goes live on it, even once the real owner points it at Fullfilio', async () => {
    world.zone['brand.com'] = { A: [IP] }
    world.unproven.add('brand.com') // the owner never added the claimer's code
    await post({ action: 'add', domain: 'brand.com' }, 'm-b')
    await cron()
    expect(db.rows.get('brand.com')).toMatchObject({ merchant_id: 'm-b', status: 'VERIFYING', verified_at: null })
    expect((await ask('brand.com')).status).toBe(404)
  })

  it('a subdomain on Cloudflare also needs the record before it is live', async () => {
    world.zone['shop.example.com'] = { CNAME: [TARGET] }
    world.unproven.add('shop.example.com')
    await post({ action: 'add', domain: 'shop.example.com' })
    const waiting = await post({ action: 'check', domain: 'shop.example.com' })
    expect(waiting.body.domain?.status).toBe('VERIFYING')
    expect(recordsOf(db.rows.get('shop.example.com'))).toContainEqual(['TXT', '_fullfilio.shop', 'fullfilio-verify=code-shop.example.com'])
    world.unproven.delete('shop.example.com')
    expect((await post({ action: 'check', domain: 'shop.example.com' })).body.domain?.status).toBe('ACTIVE')
  })

  it('removing a domain clears the proof: added again, it proves ownership again', async () => {
    world.zone['shop.com'] = { A: [IP] }
    await addAndCheck('shop.com')
    expect(db.rows.get('shop.com')!.verified_at).not.toBeNull()
    await post({ action: 'remove', domain: 'shop.com' })
    expect(db.rows.get('shop.com')!.verified_at).toBeNull()
    world.unproven.add('shop.com')
    expect((await post({ action: 'add', domain: 'shop.com' })).body.domain?.status).toBe('VERIFYING')
  })
})

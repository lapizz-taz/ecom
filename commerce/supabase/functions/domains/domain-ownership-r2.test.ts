// Round 2 of the adversarial review of domain ownership proof (the _fullfilio TXT record), run
// through the domains function with every outside service faked (same mocking pattern as
// domain-audit-flow.test.ts). Each test asserts the CORRECT behaviour: a failing test marks a
// defect or a merchant trap; the passing ones are regression coverage. No real network.
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

// --- In-memory model of store_domain_* (20261121000600_domain_ownership.sql) ----------------

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
/** Codes are random per row, as gen_random_uuid() in the guard. */
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
        if (!db.rows.has(d)) db.rows.set(d, newRow(d, mid!, 'PENDING'))
        const r = db.rows.get(d)!
        if (r.merchant_id === mid && r.status === 'REMOVED') Object.assign(r, { status: 'PENDING', is_primary: false, removed_at: null,
          verified_at: r.removed_at && Date.parse(r.removed_at) > Date.now() - 7 * 86_400_000 ? r.verified_at : null })
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
      // Row security first (ON CONFLICT on another store's row), then "removed meanwhile".
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
    verified_at: o.verified ? ago(60) : null,
    created_at: ago((o.createdDays ?? 1) * 1440),
    checked_at: o.checkedMin == null ? null : ago(o.checkedMin),
    is_primary: o.primary ?? false,
  }
  db.rows.set(domain, r)
  return r
}
const codeOf = (d: string) => db.rows.get(d)!.verify_code!

// --- The fake outside world ----------------------------------------------------------------

type RecordType = 'A' | 'AAAA' | 'CNAME' | 'NS' | 'TXT' | 'CAA'
type Records = Partial<Record<RecordType, string[]>>
const CODE: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 }
interface CfHost { id: string; hostname: string; status: string; ssl: { status: string } }
const world = {
  zone: {} as Record<string, Records>,
  https: {} as Record<string, 'store' | 'vercel' | 'other' | 'cert' | 'down'>,
  log: [] as Array<{ method: string; url: URL }>,
  cfHosts: new Map<string, CfHost>(),
  /** Runs once, the first time a _fullfilio TXT record is asked for. */
  onTxt: null as null | (() => Promise<void>),
}
/** The store's ownership record, as the merchant adds it at the DNS company. */
const addTxt = (d: string, ...values: string[]) => { world.zone[`_fullfilio.${d}`] = { ...world.zone[`_fullfilio.${d}`], TXT: values } }

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
  const rest = url.pathname.replace('/client/v4/zones/zone1/custom_hostnames', '')
  if (rest === '' && method === 'GET') {
    const h = world.cfHosts.get(url.searchParams.get('hostname') ?? '')
    if (h && cnameChain(h.hostname).includes(TARGET)) Object.assign(h, { status: 'active', ssl: { status: 'active' } })
    return json(200, { success: true, result: h ? [structuredClone(h)] : [] })
  }
  if (rest === '' && method === 'POST') {
    const name = String(body?.hostname)
    if (world.cfHosts.has(name)) return json(409, { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] })
    const h: CfHost = { id: `h${world.cfHosts.size + 1}`, hostname: name, status: 'pending', ssl: { status: 'pending_validation' } }
    world.cfHosts.set(name, h)
    return json(201, { success: true, result: structuredClone(h) })
  }
  const h = [...world.cfHosts.values()].find((x) => x.id === rest.slice(1))
  if (method === 'PATCH' && h) return json(200, { success: true, result: structuredClone(h) })
  if (method === 'DELETE' && h) { world.cfHosts.delete(h.hostname); return json(200, { success: true, result: { id: h.id } }) }
  return json(404, { success: false, errors: [{ code: 1436, message: 'not found' }] })
}

/** Vercel: a name no other Vercel account holds is "verified" as soon as it is added to the project. */
function vercelApi(url: URL, method: string): Response {
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
  // public/_headers: every page of the site (the store, and "store not available" too) carries X-Fullfilio.
  const headers: Record<string, string> = mode === 'store' ? { 'x-fullfilio': 'store' } : mode === 'vercel' ? { 'x-vercel-id': 'sfo1::abc', server: 'Vercel' } : { server: 'nginx' }
  return new Response('<html></html>', { status: 200, headers })
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
      if (type === 'TXT' && name.startsWith('_fullfilio.') && world.onTxt) {
        const run = world.onTxt
        world.onTxt = null
        await run()
      }
      const ans = answers(name, type)
      return Response.json({ Status: 0, Answer: ans })
    }
    case 'rdap.org': case 'data.iana.org': return new Response('not found', { status: 404 })
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
const txtLookups = (d: string) => world.log.filter((l) => /dns/.test(l.url.hostname) && l.url.searchParams.get('name') === `_fullfilio.${d}` && l.url.searchParams.get('type') === 'TXT')
const recordsOf = (r: Row | undefined) => (r?.records ?? []).map((x) => [x.type, x.name, x.value])
const CF_ENV = { CF_SAAS_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone1', CUSTOM_DOMAIN_TARGET: TARGET, ROOT_DOMAIN_IP: IP }

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
  world.onTxt = null
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// =============================================================================================

describe('r2: hosting paths that set verified on their own', () => {
  it('Vercel: a domain still pointing at Vercel (its owner left) is never proven for a store that has no TXT record', async () => {
    H.env = { VERCEL_TOKEN: 'v-token', VERCEL_PROJECT_ID: 'p1' }
    world.zone['brand.com'] = { A: ['76.76.21.21'] }
    world.https['brand.com'] = 'vercel'
    const res = await post({ action: 'add', domain: 'brand.com' }, 'm-b')
    expect(res.status).toBe(200)
    const row = db.rows.get('brand.com')!
    expect({ status: row.status, proven: row.verified_at !== null }).toEqual({ status: 'VERIFYING', proven: false })
    // The panel asks for the store's own record.
    expect(recordsOf(row)).toContainEqual(['TXT', '_fullfilio', `fullfilio-verify=${row.verify_code}`])
  })

  it('manual hosting: a subdomain whose CNAME still leads to Fullfilio is not proven by our own site answering on it', async () => {
    H.env = { CUSTOM_DOMAIN_TARGET: TARGET }
    world.zone['shop.brand.com'] = { CNAME: [TARGET] }
    world.https['shop.brand.com'] = 'store' // the "store not available" page carries X-Fullfilio as well
    await post({ action: 'add', domain: 'shop.brand.com' }, 'm-b')
    const row = db.rows.get('shop.brand.com')!
    expect({ live: row.status === 'ACTIVE', proven: row.verified_at !== null }).toEqual({ live: false, proven: false })
  })

  it('manual hosting without a target: someone else\'s Vercel site is not "live" and not proven for this store', async () => {
    H.env = {}
    world.zone['brand.com'] = { A: ['76.76.21.21'] }
    world.https['brand.com'] = 'vercel' // the brand's own site, on its own Vercel account
    await post({ action: 'add', domain: 'brand.com' }, 'm-b')
    const row = db.rows.get('brand.com')!
    expect({ live: row.status === 'ACTIVE', proven: row.verified_at !== null }).toEqual({ live: false, proven: false })
  })
})

describe('r2: no certificate or hosting entry before proof', () => {
  it('adding a subdomain the store has not proven does not create a Cloudflare custom hostname (certificate) yet', async () => {
    world.zone['shop.brand.com'] = { CNAME: [TARGET] }
    await post({ action: 'add', domain: 'shop.brand.com' }, 'm-b')
    expect(world.log.filter((l) => l.url.hostname === 'api.cloudflare.com' && l.method === 'POST')).toEqual([])
    expect(world.cfHosts.has('shop.brand.com')).toBe(false)
  })
})

describe('r2: the honest merchant\'s flow', () => {
  it('a fresh add does not ask resolvers for the TXT record before the merchant has seen the code (negative caching)', async () => {
    world.zone['fresh.com'] = { A: [IP] }
    const res = await post({ action: 'add', domain: 'fresh.com' })
    expect(recordsOf(res.body.domain)).toContainEqual(['TXT', '_fullfilio', `fullfilio-verify=${codeOf('fresh.com')}`])
    expect(txtLookups('fresh.com')).toEqual([])
  })

  it('the cron makes the domain live by itself once the TXT record appears (no button press)', async () => {
    world.zone['later.com'] = { A: [IP] }
    world.zone['www.later.com'] = { A: [IP] }
    await post({ action: 'add', domain: 'later.com' })
    expect(db.rows.get('later.com')!.status).toBe('VERIFYING')
    expect(await ask('later.com')).toBe(404)
    addTxt('later.com', `fullfilio-verify=${codeOf('later.com')}`)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await cron()
    expect(db.rows.get('later.com')).toMatchObject({ status: 'ACTIVE' })
    expect(db.rows.get('later.com')!.verified_at).not.toBeNull()
    expect(await ask('later.com')).toBe(200)
  })

  it('a TXT value with text around the code counts; a value with another store\'s code does not', async () => {
    world.zone['wrap.com'] = { A: [IP] }
    world.zone['other.com'] = { A: [IP] }
    await post({ action: 'add', domain: 'wrap.com' })
    await post({ action: 'add', domain: 'other.com' }, 'm-b')
    addTxt('wrap.com', 'v=x', `note fullfilio-verify=${codeOf('wrap.com')} end`)
    addTxt('other.com', `fullfilio-verify=${codeOf('wrap.com')}`)
    await post({ action: 'check', domain: 'wrap.com' })
    await post({ action: 'check', domain: 'other.com' }, 'm-b')
    expect(db.rows.get('wrap.com')!.verified_at).not.toBeNull()
    expect(db.rows.get('other.com')!.verified_at).toBeNull()
  })

  it('www of a root the same store already proved is not shown as waiting for a second TXT record while it already opens the store', async () => {
    seed('shop.com', 'm-a', 'ACTIVE', { verified: true, primary: true })
    world.zone['shop.com'] = { A: [IP] }
    world.zone['www.shop.com'] = { A: [IP] }
    expect(await ask('www.shop.com')).toBe(200) // certificate allowed through the proven twin
    const res = await post({ action: 'add', domain: 'www.shop.com' })
    expect(res.body.domain?.status).toBe('ACTIVE')
    expect(recordsOf(res.body.domain).some(([type]) => type === 'TXT')).toBe(false)
  })

  it('a TXT entered with the full name at a DNS company that adds the domain itself (_fullfilio.shop.com.shop.com) is pointed out', async () => {
    world.zone['typo.com'] = { A: [IP] }
    await post({ action: 'add', domain: 'typo.com' })
    world.zone['_fullfilio.typo.com.typo.com'] = { TXT: [`fullfilio-verify=${codeOf('typo.com')}`] }
    const res = await post({ action: 'check', domain: 'typo.com' })
    const txt = res.body.domain?.diagnostics?.issues?.find((i) => i.code === 'TXT_MISSING')
    expect(txt?.detail ?? '').toMatch(/typo\.com\.typo\.com/)
  })
})

describe('r2: races and other stores', () => {
  it('A\'s check finds A\'s TXT, but A removed and B claimed meanwhile: B is not proven, A gets nothing back', async () => {
    world.zone['race.com'] = { A: [IP] }
    await post({ action: 'add', domain: 'race.com' })
    addTxt('race.com', `fullfilio-verify=${codeOf('race.com')}`)
    world.onTxt = async () => {
      await post({ action: 'remove', domain: 'race.com' })
      await post({ action: 'add', domain: 'race.com' }, 'm-b')
    }
    const res = await post({ action: 'check', domain: 'race.com' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(db.rows.get('race.com')).toMatchObject({ merchant_id: 'm-b', verified_at: null })
    expect(await ask('race.com')).toBe(404)
  })

  it('one store\'s many unproven claims do not hold another store\'s ready domain back for hours (cron fairness)', async () => {
    for (let i = 1; i <= 60; i++) seed(`squat${i}.com`, 'm-b', 'VERIFYING', { checkedMin: 30 })
    seed('ready.com', 'm-a', 'VERIFYING', { checkedMin: 15 })
    world.zone['ready.com'] = { A: [IP] }
    world.zone['www.ready.com'] = { A: [IP] }
    addTxt('ready.com', `fullfilio-verify=${codeOf('ready.com')}`)
    for (let run = 0; run < 3; run++) {
      await cron()
      vi.setSystemTime(Date.now() + 10 * 60_000)
    }
    expect(db.rows.get('ready.com')!.status).toBe('ACTIVE')
  })
})

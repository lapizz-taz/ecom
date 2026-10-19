// Custom domains for the hosted store (staff, settings.manage):
//   POST {action: 'list'}                    saved domains with their DNS records
//   POST {action: 'add', domain}             attach to the hosting, return the DNS records to add
//   POST {action: 'check', domain}           ask the hosting again (verifies once DNS is in place)
//   POST {action: 'remove', domain}          detach from the hosting
//   POST {action: 'primary', domain}         make it the primary domain (the others redirect to it)
//   GET  ?domain=shop.com                    for the root-domain proxy (deploy/root-proxy): 200 when the
//                                             domain is connected to a store, so it may get a certificate
//   POST {action: 'recheck_all'}             scheduled (cron secret): checks every domain still
//                                             waiting, so it goes live without anyone pressing Check
// Every add/check also runs a full diagnosis (DNS records found, each region,
// HTTPS, issues such as a stray proxy), saved with the domain.
//
// Ownership: a new domain proves it is the store's with a TXT record (_fullfilio.<domain>)
// holding a code only that store sees. Until then it gets no certificate and does not open
// the store (store_domain_known / storefront_resolve), so a store cannot take a domain it
// does not own, even when the real owner points it at Fullfilio.
//
// Hosting, in this order:
//  - Cloudflare for SaaS (the site on a Cloudflare Worker): CF_SAAS_API_TOKEN (zone
//    permission "SSL and Certificates: Edit"), CF_ZONE_ID and CUSTOM_DOMAIN_TARGET
//    (the fallback-origin hostname merchants CNAME to, e.g. stores.example.com).
//  - Vercel: VERCEL_TOKEN and VERCEL_PROJECT_ID (and VERCEL_TEAM_ID for a team project).
//  - Root domains (shop.com), when ROOT_DOMAIN_IP is set: an A record to our own proxy
//    server's fixed address (deploy/root-proxy), which works at every DNS company. Cloudflare
//    for SaaS cannot take a root domain without a CNAME (Hostinger and other DNS hosts that run
//    on Cloudflare can never verify one), so roots go through the proxy and subdomains stay on
//    Cloudflare. ROOT_DOMAIN_IPV6 adds an AAAA record.
// Without either the domain is saved as MANUAL with the DNS records to add, and
// the platform owner attaches it by hand.
import { z } from 'zod'
import { apexOf, cloudflareTarget, diagnose, dnsView, doh, proxyTarget, RESOLVERS, VERCEL_TARGET, inspectWww, type Diagnosis, type ExpectedRecord, type HostingTarget } from '../_shared/domain-check.ts'
import { env } from '../_shared/env.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, forEachMerchant, requireStaff, rpc } from '../_shared/supabase.ts'

interface DnsRecord { type: 'A' | 'AAAA' | 'CNAME' | 'TXT'; name: string; value: string; why: string }
/** verified: the ownership record was found (saved as the domain's verified_at). */
interface Saved { domain: string; status: string; records: DnsRecord[]; detail: string | null; diagnostics?: Diagnosis; verified?: boolean }
/** What the store's row says about ownership: its code, and whether it was proven already. */
interface Ownership { code: string | null; verified: boolean }

/** A host name: labels of letters, digits and hyphens; the last one letters (or an xn-- IDN). */
const NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,}|xn--[a-z0-9-]{2,59})$/
// What people paste: https://Shop.com/path, SHOP.COM., shop.com:443, münchen.de (punycode).
const domain = z.string().trim().toLowerCase().transform((d) => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(d) ? d : `https://${d}`).hostname.replace(/\.$/, '')
  } catch {
    return d
  }
}).pipe(z.string().max(253, 'That domain is too long').regex(NAME, 'Enter a domain like shop.com or www.shop.com'))
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('add'), domain }),
  z.object({ action: z.literal('check'), domain }),
  z.object({ action: z.literal('remove'), domain }),
  z.object({ action: z.literal('primary'), domain }),
])

/**
 * Apex (shop.com): an A record on Vercel; on Cloudflare a CNAME at the root (CNAME
 * flattening / ALIAS, where the DNS provider allows it). A subdomain (www.shop.com): a CNAME.
 */
export function baseRecords(d: string, target: HostingTarget = VERCEL_TARGET): DnsRecord[] {
  const apex = apexOf(d)
  // www.<root> on our proxy: the same A record the root asks for.
  if (d === `www.${apex}` && target.provider === 'proxy' && target.a) {
    return [
      { type: 'A', name: 'www', value: target.a, why: 'Points www at the store (delete any other A, AAAA or CNAME record for www)' },
      ...(target.aaaa ? [{ type: 'AAAA' as const, name: 'www', value: target.aaaa, why: 'The same for IPv6 visitors' }] : []),
    ]
  }
  if (d !== apex) return [{ type: 'CNAME', name: d.slice(0, -(apex.length + 1)), value: target.cname, why: 'Points this subdomain at the store' }]
  if (target.provider === 'proxy' && target.a) {
    return [
      { type: 'A', name: '@', value: target.a, why: 'Points your domain at the store (delete any other A, AAAA or ALIAS record for @)' },
      ...(target.aaaa ? [{ type: 'AAAA' as const, name: '@', value: target.aaaa, why: 'The same for IPv6 visitors' }] : []),
      { type: 'A', name: 'www', value: target.a, why: `So www.${d} opens the store too (visitors are sent on to ${d}); delete any other www record` },
      ...(target.aaaa ? [{ type: 'AAAA' as const, name: 'www', value: target.aaaa, why: 'The same for IPv6 visitors' }] : []),
    ]
  }
  return target.a
    ? [{ type: 'A', name: '@', value: target.a, why: 'Points your domain at the store' }]
    : [{ type: 'CNAME', name: '@', value: target.cname, why: 'Points your domain at the store (a CNAME at the root, also called ALIAS or flattening; if your provider cannot, use www instead)' }]
}

/** The hosting the domains are attached to, from the function secrets (see the top of this file). */
function hostingTarget(): HostingTarget {
  const cf = cloudflare()
  return cf ? cloudflareTarget(cf.target) : VERCEL_TARGET
}

// --- Ownership (a TXT record with the store's code) ------------------------------------

/** The record a domain asks for until it is proven: _fullfilio.<domain> = fullfilio-verify=<code>. */
export function ownershipRecord(d: string, code: string): DnsRecord {
  const apex = apexOf(d)
  return { type: 'TXT', name: d === apex ? '_fullfilio' : `_fullfilio.${d.slice(0, -(apex.length + 1))}`, value: `fullfilio-verify=${code}`,
    why: 'Proves the domain is yours (only needed until the domain is live)' }
}
const ownershipExpect = (d: string, code: string): ExpectedRecord => ({ type: 'TXT', name: `_fullfilio.${d}`, value: `fullfilio-verify=${code}` })

/** Asked at Google and at Cloudflare: one of them may still remember the record as missing. */
async function ownershipFound(d: string, code: string): Promise<boolean> {
  const answers = await Promise.all(RESOLVERS.slice(0, 2).map((r) => doh(fetch, r.url, `_fullfilio.${d}`, 'TXT')))
  return answers.some((ans) => (ans ?? []).some((a) => a.type === 16 && a.data.replace(/"/g, '').includes(`fullfilio-verify=${code}`)))
}

/**
 * Whether the domain is proven the store's. Found now, it is saved at once (persist), so the
 * certificate can already be issued during this same check.
 */
async function prove(d: string, own: Ownership, persist: () => Promise<unknown>): Promise<boolean> {
  if (own.verified) return true
  if (!own.code || !(await ownershipFound(d, own.code))) return false
  await persist()
  return true
}

/** The ownership side of a store_domains row. */
const ownershipOf = (row: { verify_code?: string | null; verified_at?: string | null } | undefined): Ownership =>
  ({ code: row?.verify_code ?? null, verified: !!row?.verified_at })

/** Without the hosting API: the diagnosis alone decides whether the domain is live. */
async function manual(d: string, note: string): Promise<Omit<Saved, 'domain'>> {
  const target = env('CUSTOM_DOMAIN_TARGET') ? cloudflareTarget(env('CUSTOM_DOMAIN_TARGET')!) : hostingTarget()
  const diagnostics = await diagnose(d, { target })
  const live = diagnostics.pointed && diagnostics.tls.ok && diagnostics.tls.served_by_store === true
  // The platform owner attaches these by hand, which is the ownership check here.
  return { status: live ? 'ACTIVE' : 'MANUAL', records: baseRecords(d, target), diagnostics, verified: live,
    detail: live ? 'Live — the store opens on this domain with HTTPS' : note }
}

function vercel() {
  const token = env('VERCEL_TOKEN')
  const project = env('VERCEL_PROJECT_ID')
  if (!token || !project) return null
  const team = env('VERCEL_TEAM_ID')
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> => {
    const url = new URL(`https://api.vercel.com${path}`)
    if (team) url.searchParams.set('teamId', team)
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
    const data = await res.json().catch(() => ({})) as T
    return { ok: res.ok, status: res.status, data }
  }
  return { project, call }
}

// --- Cloudflare for SaaS (custom hostnames) -------------------------------------------

function cloudflare() {
  // Trimmed: a pasted secret often ends with a space or line break, which breaks the API path.
  const token = env('CF_SAAS_API_TOKEN')?.trim()
  const zone = env('CF_ZONE_ID')?.trim()
  const target = env('CUSTOM_DOMAIN_TARGET')?.trim().toLowerCase().replace(/\.$/, '')
  if (!token || !zone || !target) return null
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T; error: string | null; code: number | null }> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new HttpError(502, 'Could not reach Cloudflare. Please try again in a minute.', 'UPSTREAM_ERROR')
    })
    const out = await res.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> }
    return { ok: res.ok && out.success !== false, status: res.status, data: out.result as T, error: out.errors?.[0]?.message ?? null, code: out.errors?.[0]?.code ?? null }
  }
  return { target, call }
}
type Cloudflare = NonNullable<ReturnType<typeof cloudflare>>

/** The root-domain proxy (deploy/root-proxy), when its fixed address is set. */
function rootProxy(cf: Cloudflare) {
  const ip = env('ROOT_DOMAIN_IP')?.trim()
  return ip ? proxyTarget(ip, cf.target, env('ROOT_DOMAIN_IPV6')) : null
}
/**
 * Root domains (and their www) go through the proxy; other subdomains stay on Cloudflare for
 * SaaS. www.<root> is the twin of the root, so it asks for the same A record the root lists.
 */
const viaProxy = (cf: Cloudflare, d: string) => (d === apexOf(d) || d === `www.${apexOf(d)}` ? rootProxy(cf) : null)

/** The platform's own names (its root and every subdomain) are never a store's domain. */
const platformDomain = (cf: Cloudflare, d: string) => d === apexOf(cf.target) || d.endsWith(`.${apexOf(cf.target)}`)

/**
 * A domain on the proxy: live once it is proven the store's, its A record leads to the proxy
 * and the store answers over HTTPS.
 */
async function inspectRoot(target: HostingTarget, d: string, own: Ownership, persist: () => Promise<unknown>): Promise<Omit<Saved, 'domain'>> {
  const proven = await prove(d, own, persist)
  // Asked once for both: which nameservers really answer, and which resolver already has them.
  const view = await dnsView(d)
  const expect = own.verified || !own.code ? [] : [ownershipExpect(d, own.code)]
  const [diagnostics, www] = await Promise.all([diagnose(d, { target, view, expect }), inspectWww(d, target, fetch, view)])
  // www.<root> is listed next to @, but never holds the root back: it only asks for its record.
  if (www) {
    diagnostics.records.push(...www.records)
    if (www.issue) diagnostics.issues.push(www.issue)
  }
  const records = [...baseRecords(d, target), ...(proven || !own.code ? [] : [ownershipRecord(d, own.code)])]
  // A DNS checker that did not answer says nothing about the domain: the store answering is enough.
  const dnsOk = diagnostics.pointed || diagnostics.issues.some((i) => i.code === 'CHECK_FAILED')
  if (proven && dnsOk && diagnostics.tls.ok && diagnostics.tls.served_by_store === true) {
    return { status: 'ACTIVE', records, diagnostics, verified: true, detail: 'Live — the store opens on this domain with HTTPS' }
  }
  const blocking = diagnostics.issues.find((i) => i.severity === 'error')
  return {
    status: 'VERIFYING', records, diagnostics, verified: proven,
    detail: blocking ? blocking.title
      : !diagnostics.pointed ? 'Waiting for the A record below (changes can take up to a few hours)'
      : 'DNS is right — the HTTPS certificate is issued on the first visit (usually under a minute)',
  }
}

/** Checks a domain on whichever hosting it belongs to. */
const inspectAny = (cf: Cloudflare, d: string, recheck: boolean, own: Ownership, persist: () => Promise<unknown>) => {
  const root = viaProxy(cf, d)
  return root ? inspectRoot(root, d, own, persist) : inspectCloudflare(cf, d, recheck, own, persist)
}

interface CustomHostname {
  id: string
  hostname: string
  status: string
  verification_errors?: string[]
  ownership_verification?: { type?: string; name?: string; value?: string }
  ssl?: { status?: string; validation_errors?: Array<{ message?: string }>; validation_records?: Array<{ txt_name?: string; txt_value?: string }> }
}

const SSL = { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } }

async function findHostname(cf: Cloudflare, d: string): Promise<CustomHostname | null> {
  const found = await cf.call<CustomHostname[]>('GET', `/custom_hostnames?hostname=${encodeURIComponent(d)}`)
  if (!found.ok) throw new HttpError(502, `Cloudflare answered: ${found.error ?? found.status}`, 'UPSTREAM_ERROR')
  return (found.data ?? []).find((h) => h.hostname === d) ?? null
}

/** Record name as a registrar shows it, relative to the apex. */
const relative = (name: string, d: string) => name.replace(new RegExp(`\\.?${apexOf(d).replace(/\./g, '\\.')}$`), '') || '@'

/** Asks Cloudflare where the hostname stands and turns it into records + a status. */
async function inspectCloudflare(cf: Cloudflare, d: string, recheck: boolean, own: Ownership, persist: () => Promise<unknown>): Promise<Omit<Saved, 'domain'>> {
  const target = cloudflareTarget(cf.target)
  const proven = await prove(d, own, persist)
  const mine: DnsRecord[] = proven || !own.code ? [] : [ownershipRecord(d, own.code)]
  let host = await findHostname(cf, d)
  // Added before the hosting was connected (or removed there): attach it now instead of asking to add it again.
  if (!host && recheck) {
    await addCloudflare(cf, d)
    host = await findHostname(cf, d)
  }
  // A fresh diagnosis too, so the popup does not show the last check's rows under this status.
  if (!host) return { status: 'ERROR', records: [...baseRecords(d, target), ...mine], diagnostics: await diagnose(d, { target }), verified: proven, detail: 'Not attached to the hosting yet — press Check again' }
  if (recheck && (host.status !== 'active' || host.ssl?.status !== 'active')) {
    // Asks Cloudflare to validate again now instead of on its own schedule.
    const again = await cf.call<CustomHostname>('PATCH', `/custom_hostnames/${host.id}`, { ssl: SSL })
    if (again.ok && again.data) host = again.data
  }
  const extra: DnsRecord[] = []
  const expect: ExpectedRecord[] = []
  if (host.status !== 'active' && host.ownership_verification?.name && host.ownership_verification.value) {
    extra.push({ type: 'TXT', name: relative(host.ownership_verification.name, d), value: host.ownership_verification.value, why: 'Proves the domain is yours (only needed until the domain is live)' })
    expect.push({ type: 'TXT', name: host.ownership_verification.name, value: host.ownership_verification.value })
  }
  for (const r of host.ssl?.status === 'active' ? [] : host.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value) {
      extra.push({ type: 'TXT', name: relative(r.txt_name, d), value: r.txt_value, why: 'Lets the HTTPS certificate be issued' })
      expect.push({ type: 'TXT', name: r.txt_name, value: r.txt_value })
    }
  }
  if (!proven && own.code) expect.push(ownershipExpect(d, own.code))
  const diagnostics: Diagnosis = {
    ...(await diagnose(d, { target, expect })),
    hosting: { status: host.status, ssl_status: host.ssl?.status ?? null, error: host.verification_errors?.[0] ?? host.ssl?.validation_errors?.[0]?.message ?? null },
  }
  // The root went live after all: no need to move its DNS.
  if (host.status === 'active') diagnostics.issues = diagnostics.issues.filter((i) => i.code !== 'NEEDS_CLOUDFLARE')
  // Live only when visitors really reach the store: the hosting can confirm the domain while
  // the DNS is still switching over (for example right after changing nameservers).
  const reachesStore = diagnostics.tls.served_by_store === true || (diagnostics.pointed && !diagnostics.issues.some((i) => i.severity === 'error'))
  if (proven && host.status === 'active' && host.ssl?.status === 'active' && reachesStore) {
    return { status: 'ACTIVE', records: baseRecords(d, target), diagnostics, verified: true, detail: 'Live — the store opens on this domain with HTTPS' }
  }
  if (host.status === 'active' && host.ssl?.status === 'active') {
    const blocking = diagnostics.issues.find((i) => i.severity === 'error')
    return { status: 'VERIFYING', records: [...baseRecords(d, target), ...mine], diagnostics, verified: proven,
      detail: blocking ? `Confirmed and HTTPS ready — ${blocking.title}` : 'Confirmed and HTTPS ready — waiting for your DNS to point here' }
  }
  // On Cloudflare DNS Cloudflare's own TXT records do not count (the CNAME verifies the domain): do not ask for them.
  const cloudflareDns = diagnostics.dns_host?.provider === 'Cloudflare' && !diagnostics.dns_host.mixed
  if (cloudflareDns) extra.splice(0, extra.length)
  const problem = host.verification_errors?.[0] ?? host.ssl?.validation_errors?.[0]?.message
  const blocking = diagnostics.issues.find((i) => i.severity === 'error')
  return {
    status: 'VERIFYING', records: [...baseRecords(d, target), ...mine, ...extra], diagnostics, verified: proven,
    // The first thing to fix, in plain words; we keep checking every few minutes on our own.
    detail: blocking ? blocking.title
      // DNS and the TXT are right: Cloudflare's own "does not CNAME" lags behind until it re-reads them.
      : diagnostics.pointed ? 'DNS is right — the hosting is confirming the domain and issuing HTTPS (usually 5–15 minutes)'
      : problem ? `Waiting: ${problem}`
      : !diagnostics.pointed ? 'Waiting for the DNS records below (changes can take up to a few hours)' : 'DNS is right — the HTTPS certificate is on its way',
  }
}

async function addCloudflare(cf: Cloudflare, d: string): Promise<void> {
  if (platformDomain(cf, d)) {
    throw new HttpError(422, 'That is the platform\'s own domain', 'DOMAIN_REJECTED')
  }
  const added = await cf.call<CustomHostname>('POST', '/custom_hostnames', { hostname: d, ssl: SSL })
  // 1406: the hostname is already attached (adding it again is fine).
  if (!added.ok && added.code !== 1406) {
    void logEvent({ level: 'WARN', category: 'FUNCTION', source: 'domains', message: `Could not add ${d} on Cloudflare: ${added.error ?? added.status}` })
    throw new HttpError(422, `Cloudflare would not add the domain: ${added.error ?? added.status}`, 'DOMAIN_REJECTED')
  }
}

async function removeCloudflare(cf: Cloudflare, d: string): Promise<void> {
  const host = await findHostname(cf, d)
  if (!host) return
  const r = await cf.call('DELETE', `/custom_hostnames/${host.id}`)
  if (!r.ok && r.status !== 404) throw new HttpError(422, `Cloudflare would not remove it: ${r.error ?? r.status}`, 'DOMAIN_REJECTED')
}

// --- Vercel ---------------------------------------------------------------------------

type VercelDomain = { name: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string; reason: string }>; error?: { code: string; message: string } }
type VercelConfig = { misconfigured: boolean; configuredBy?: string | null }

/** Asks Vercel where the domain stands and turns it into records + a status. */
async function inspect(v: NonNullable<ReturnType<typeof vercel>>, d: string): Promise<Omit<Saved, 'domain'>> {
  const info = await v.call<VercelDomain>('GET', `/v9/projects/${v.project}/domains/${d}`)
  if (!info.ok) return { status: 'ERROR', records: baseRecords(d, VERCEL_TARGET), detail: info.data.error?.message ?? `Vercel answered ${info.status}` }
  let verified = info.data.verified
  if (!verified) {
    const tried = await v.call<VercelDomain>('POST', `/v9/projects/${v.project}/domains/${d}/verify`)
    verified = tried.ok && tried.data.verified
  }
  const ownership: DnsRecord[] = verified ? [] : (info.data.verification ?? []).map((x) => ({
    type: (x.type.toUpperCase() as DnsRecord['type']), name: x.domain.replace(new RegExp(`\\.?${d.split('.').slice(-2).join('\\.')}$`), '') || '@', value: x.value,
    why: 'Proves the domain is yours (the domain is used elsewhere on Vercel)',
  }))
  const config = await v.call<VercelConfig>('GET', `/v6/domains/${d}/config`)
  const pointed = config.ok && !config.data.misconfigured
  const records = [...baseRecords(d, VERCEL_TARGET), ...ownership]
  const diagnostics = await diagnose(d, { vercelPointed: config.ok ? pointed : null })
  // Vercel verifies ownership itself (the records above) before it serves the domain.
  if (verified && pointed) return { status: 'ACTIVE', records, diagnostics, verified: true, detail: 'Live — the store opens on this domain with HTTPS' }
  return { status: 'VERIFYING', records, diagnostics, detail: !pointed ? 'Waiting for the DNS records below (changes can take up to a few hours)' : 'Waiting for the ownership record below' }
}

/** Waiting domains are checked every 10 minutes for 3 days after the last change, then hourly. */
export function dueForRecheck(d: { status: string; checked_at?: string | null; created_at?: string | null; diagnostics?: Diagnosis | null }, now = Date.now()): boolean {
  if (d.status === 'REMOVED') return false
  const checked = d.checked_at ? Date.parse(d.checked_at) : 0
  // A live domain is checked again often only while its last check still showed a problem (often
  // DNS still spreading after a nameserver change), so the status settles by itself; else once a
  // day, so DNS that later moved away is noticed.
  if (d.status === 'ACTIVE' && !d.diagnostics?.issues?.some((i) => i.severity === 'error')) return !!d.checked_at && now - checked >= 86_400_000
  const age = now - (d.created_at ? Date.parse(d.created_at) : now)
  const every = age > 3 * 86_400_000 ? 55 * 60_000 : 9 * 60_000
  return now - checked >= every
}

/** At most this many domains per run, so one run stays well inside the time limit. */
const RECHECK_LIMIT = 15

type Listed = { domain: string; status: string; checked_at: string | null; created_at: string | null; diagnostics: Diagnosis | null; verify_code?: string | null; verified_at?: string | null }
type Admin = Parameters<Parameters<typeof forEachMerchant>[1]>[0]

/** Saves that the ownership record was found (nothing else changes). */
const markVerified = (admin: Admin, d: string) => rpc(admin, 'store_domain_save', { p_domain: d, p: { verified: true }, p_actor: null })

/** The scheduled run: every waiting domain is checked (and attached) as if its owner pressed Check. */
async function recheckAll() {
  const cf = cloudflare()
  if (!cf) return { checked: 0, live: 0, skipped: 'no hosting API' }
  // Every store's due domains in one queue, oldest check first: one store with many waiting
  // domains cannot take every slot of every run.
  const due: Array<{ admin: Admin; d: Listed }> = []
  const run = await forEachMerchant('domains', async (admin) => {
    for (const d of (await rpc<Listed[]>(admin, 'store_domains_list')) ?? []) if (dueForRecheck(d)) due.push({ admin, d })
  })
  due.sort((a, b) => (a.d.checked_at ?? '').localeCompare(b.d.checked_at ?? ''))
  let live = 0
  for (const { admin, d } of due.slice(0, RECHECK_LIMIT)) {
    try {
      const result = await inspectAny(cf, d.domain, true, ownershipOf(d), () => markVerified(admin, d.domain))
      const saved = await rpc<Saved | null>(admin, 'store_domain_save', { p_domain: d.domain, p: result, p_actor: null })
      // Removed while it was being checked: it stays removed, and detached at Cloudflare again.
      if (!saved) {
        if (!viaProxy(cf, d.domain)) await removeCloudflare(cf, d.domain).catch(() => undefined)
        continue
      }
      if (result.status === 'ACTIVE') live += 1
    } catch (error) {
      const message = (error as Error).message
      void logEvent({ level: 'WARN', category: 'JOB', source: 'domains', message: `Could not re-check ${d.domain}: ${message}` })
      // Counted as checked, so a domain that keeps failing does not hold a slot on every run.
      await rpc(admin, 'store_domain_save', { p_domain: d.domain, p: { detail: `Could not check right now: ${message}` }, p_actor: null }).catch(() => undefined)
    }
  }
  return { checked: Math.min(due.length, RECHECK_LIMIT), live, failed: run.failed }
}


export default (
  handle(async (req) => {
    // The root-domain proxy asks before getting a certificate: only for a domain a store has connected.
    if (req.method === 'GET') {
      const asked = new URL(req.url).searchParams.get('domain')?.trim().toLowerCase() ?? ''
      const known = asked.length <= 253 && NAME.test(asked)
        && (await rpc<boolean>(adminClient(), 'store_domain_known', { p_domain: asked })) === true
      return new Response(known ? 'ok' : 'unknown domain', { status: known ? 200 : 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: unknown }>(req)
    if (body?.action === 'recheck_all') {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
      return json(req, await recheckAll())
    }
    const input = parse(actions, body)
    const staff = await requireStaff(req, input.action === 'list' ? 'settings.view' : 'settings.manage', { supportView: input.action === 'list' })
    const admin = staff.admin
    // Ownership gate BEFORE any provider call: the Cloudflare zone / Vercel
    // project are shared across merchants, so a staffer must not be able to
    // add/check/remove/primary a domain their own store does not hold. Runs
    // under the staff user's merchant (RLS-scoped), so it can only pass for
    // domains this merchant owns (or, for 'add', claims when still free).
    if (input.action !== 'list') {
      await rpc(staff.client, 'store_domain_guard', { p_domain: input.domain, p_action: input.action })
    }
    const cf = cloudflare()
    const v = cf ? null : vercel()
    const save = (d: string, p: Omit<Saved, 'domain'>) => rpc<Saved>(admin, 'store_domain_save', { p_domain: d, p, p_actor: staff.user.id })

    if (cf) {
      // The store's own row (made by the guard): its ownership code, and whether it is proven.
      const own = async (d: string) => ownershipOf((await rpc<Listed[]>(admin, 'store_domains_list'))?.find((x) => x.domain === d))
      const persist = (d: string) => () => markVerified(admin, d)
      switch (input.action) {
        case 'list':
          // root_ip: main domains connect with an A record to our proxy, at any DNS company.
          return json(req, { domains: await rpc(admin, 'store_domains_list'), automatic: true, hosting: 'cloudflare', root_ip: rootProxy(cf)?.a ?? null })
        case 'add':
          if (platformDomain(cf, input.domain)) throw new HttpError(422, 'That is the platform\'s own domain', 'DOMAIN_REJECTED')
          if (!viaProxy(cf, input.domain)) await addCloudflare(cf, input.domain)
          return json(req, { domain: await save(input.domain, await inspectAny(cf, input.domain, false, await own(input.domain), persist(input.domain))), automatic: true })
        case 'check':
          return json(req, { domain: await save(input.domain, await inspectAny(cf, input.domain, true, await own(input.domain), persist(input.domain))), automatic: true })
        case 'remove':
          // A domain on the proxy has no hosting entry at Cloudflare (an old one is cleaned up if Cloudflare answers).
          if (viaProxy(cf, input.domain)) await removeCloudflare(cf, input.domain).catch(() => undefined)
          else await removeCloudflare(cf, input.domain)
          await save(input.domain, { status: 'REMOVED', records: [], detail: 'Removed from the store' })
          return json(req, { ok: true })
        case 'primary':
          return json(req, { domain: await rpc(staff.client, 'store_domain_set_primary', { p_domain: input.domain }) })
      }
    }

    switch (input.action) {
      case 'list':
        return json(req, { domains: await rpc(admin, 'store_domains_list'), automatic: !!v, hosting: v ? 'vercel' : 'manual' })
      case 'add': {
        if (!v) {
          return json(req, { domain: await save(input.domain, await manual(input.domain,
            'Saved. Add the DNS record below at your domain registrar; the platform owner then adds the domain to the hosting project.')), automatic: false })
        }
        const added = await v.call<VercelDomain>('POST', `/v10/projects/${v.project}/domains`, { name: input.domain })
        if (!added.ok && added.data.error?.code !== 'domain_already_in_use_by_project' && added.status !== 409) {
          const message = added.data.error?.message ?? `Vercel answered ${added.status}`
          void logEvent({ level: 'WARN', category: 'FUNCTION', source: 'domains', message: `Could not add ${input.domain}: ${message}` })
          throw new HttpError(422, `Vercel would not add the domain: ${message}`, 'DOMAIN_REJECTED')
        }
        return json(req, { domain: await save(input.domain, await inspect(v, input.domain)), automatic: true })
      }
      case 'check':
        if (!v) return json(req, { domain: await save(input.domain, await manual(input.domain, 'Add the DNS record below; the platform owner then connects the domain to the hosting.')), automatic: false })
        return json(req, { domain: await save(input.domain, await inspect(v, input.domain)), automatic: true })
      case 'remove': {
        if (v) {
          const r = await v.call<VercelDomain>('DELETE', `/v9/projects/${v.project}/domains/${input.domain}`)
          if (!r.ok && r.status !== 404) throw new HttpError(422, `Vercel would not remove it: ${r.data.error?.message ?? r.status}`, 'DOMAIN_REJECTED')
        }
        await save(input.domain, { status: 'REMOVED', records: [], detail: v ? 'Removed from the store' : 'Removed here; also remove it from the hosting project' })
        return json(req, { ok: true })
      }
      case 'primary':
        return json(req, { domain: await rpc(staff.client, 'store_domain_set_primary', { p_domain: input.domain }) })
    }
  })
)

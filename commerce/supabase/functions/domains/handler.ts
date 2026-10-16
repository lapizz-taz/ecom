// Custom domains for the hosted store (staff, settings.manage):
//   POST {action: 'list'}                    saved domains with their DNS records
//   POST {action: 'add', domain}             attach to the hosting, return the DNS records to add
//   POST {action: 'check', domain}           ask the hosting again (verifies once DNS is in place)
//   POST {action: 'remove', domain}          detach from the hosting
//   POST {action: 'primary', domain}         make it the primary domain (the others redirect to it)
// Every add/check also runs a full diagnosis (DNS records found, each region,
// HTTPS, issues such as a stray proxy), saved with the domain.
//
// Hosting, in this order:
//  - Cloudflare for SaaS (the site on a Cloudflare Worker): CF_SAAS_API_TOKEN (zone
//    permission "SSL and Certificates: Edit"), CF_ZONE_ID and CUSTOM_DOMAIN_TARGET
//    (the fallback-origin hostname merchants CNAME to, e.g. stores.example.com).
//  - Vercel: VERCEL_TOKEN and VERCEL_PROJECT_ID (and VERCEL_TEAM_ID for a team project).
// Without either the domain is saved as MANUAL with the DNS records to add, and
// the platform owner attaches it by hand.
import { z } from 'zod'
import { apexOf, cloudflareTarget, diagnose, VERCEL_TARGET, type Diagnosis, type HostingTarget } from '../_shared/domain-check.ts'
import { env } from '../_shared/env.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { requireStaff, rpc } from '../_shared/supabase.ts'

interface DnsRecord { type: 'A' | 'CNAME' | 'TXT'; name: string; value: string; why: string }
interface Saved { domain: string; status: string; records: DnsRecord[]; detail: string | null; diagnostics?: Diagnosis }

const domain = z.string().trim().toLowerCase().transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .pipe(z.string().regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a domain like shop.com or www.shop.com'))
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
  if (d !== apex) return [{ type: 'CNAME', name: d.slice(0, -(apex.length + 1)), value: target.cname, why: 'Points this subdomain at the store' }]
  return target.a
    ? [{ type: 'A', name: '@', value: target.a, why: 'Points your domain at the store' }]
    : [{ type: 'CNAME', name: '@', value: target.cname, why: 'Points your domain at the store (a CNAME at the root, also called ALIAS or flattening; if your provider cannot, use www instead)' }]
}

/** The hosting the domains are attached to, from the function secrets (see the top of this file). */
function hostingTarget(): HostingTarget {
  const cf = cloudflare()
  return cf ? cloudflareTarget(cf.target) : VERCEL_TARGET
}

/** Without the hosting API: the diagnosis alone decides whether the domain is live. */
async function manual(d: string, note: string): Promise<Omit<Saved, 'domain'>> {
  const target = env('CUSTOM_DOMAIN_TARGET') ? cloudflareTarget(env('CUSTOM_DOMAIN_TARGET')!) : hostingTarget()
  const diagnostics = await diagnose(d, { target })
  const live = diagnostics.pointed && diagnostics.tls.ok && diagnostics.tls.served_by_store === true
  return { status: live ? 'ACTIVE' : 'MANUAL', records: baseRecords(d, target), diagnostics,
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
  const target = env('CUSTOM_DOMAIN_TARGET')?.trim()
  if (!token || !zone || !target) return null
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T; error: string | null; code: number | null }> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    })
    const out = await res.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> }
    return { ok: res.ok && out.success !== false, status: res.status, data: out.result as T, error: out.errors?.[0]?.message ?? null, code: out.errors?.[0]?.code ?? null }
  }
  return { target, call }
}
type Cloudflare = NonNullable<ReturnType<typeof cloudflare>>

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
async function inspectCloudflare(cf: Cloudflare, d: string, recheck: boolean): Promise<Omit<Saved, 'domain'>> {
  const target = cloudflareTarget(cf.target)
  let host = await findHostname(cf, d)
  // Added before the hosting was connected (or removed there): attach it now instead of asking to add it again.
  if (!host && recheck) {
    await addCloudflare(cf, d)
    host = await findHostname(cf, d)
  }
  if (!host) return { status: 'ERROR', records: baseRecords(d, target), detail: 'Not attached to the hosting yet — press Check again' }
  if (recheck && (host.status !== 'active' || host.ssl?.status !== 'active')) {
    // Asks Cloudflare to validate again now instead of on its own schedule.
    const again = await cf.call<CustomHostname>('PATCH', `/custom_hostnames/${host.id}`, { ssl: SSL })
    if (again.ok && again.data) host = again.data
  }
  const extra: DnsRecord[] = []
  if (host.status !== 'active' && host.ownership_verification?.name && host.ownership_verification.value) {
    extra.push({ type: 'TXT', name: relative(host.ownership_verification.name, d), value: host.ownership_verification.value, why: 'Proves the domain is yours (only needed until the domain is live)' })
  }
  for (const r of host.ssl?.status === 'active' ? [] : host.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value) extra.push({ type: 'TXT', name: relative(r.txt_name, d), value: r.txt_value, why: 'Lets the HTTPS certificate be issued' })
  }
  const diagnostics = await diagnose(d, { target })
  if (host.status === 'active' && host.ssl?.status === 'active') {
    return { status: 'ACTIVE', records: baseRecords(d, target), diagnostics, detail: 'Live — the store opens on this domain with HTTPS' }
  }
  const problem = host.verification_errors?.[0] ?? host.ssl?.validation_errors?.[0]?.message
  return {
    status: 'VERIFYING', records: [...baseRecords(d, target), ...extra], diagnostics,
    detail: problem ? `Waiting: ${problem}` : !diagnostics.pointed ? 'Waiting for the DNS records below (changes can take up to a few hours)' : 'DNS is right — the HTTPS certificate is on its way',
  }
}

async function addCloudflare(cf: Cloudflare, d: string): Promise<void> {
  if (d === apexOf(cf.target) || d.endsWith(`.${apexOf(cf.target)}`)) {
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
  if (verified && pointed) return { status: 'ACTIVE', records, diagnostics, detail: 'Live — the store opens on this domain with HTTPS' }
  return { status: 'VERIFYING', records, diagnostics, detail: !pointed ? 'Waiting for the DNS records below (changes can take up to a few hours)' : 'Waiting for the ownership record below' }
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(actions, await readJson(req))
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
      switch (input.action) {
        case 'list':
          return json(req, { domains: await rpc(admin, 'store_domains_list'), automatic: true })
        case 'add':
          await addCloudflare(cf, input.domain)
          return json(req, { domain: await save(input.domain, await inspectCloudflare(cf, input.domain, false)), automatic: true })
        case 'check':
          return json(req, { domain: await save(input.domain, await inspectCloudflare(cf, input.domain, true)), automatic: true })
        case 'remove':
          await removeCloudflare(cf, input.domain)
          await save(input.domain, { status: 'REMOVED', records: [], detail: 'Removed from the store' })
          return json(req, { ok: true })
        case 'primary':
          return json(req, { domain: await rpc(staff.client, 'store_domain_set_primary', { p_domain: input.domain }) })
      }
    }

    switch (input.action) {
      case 'list':
        return json(req, { domains: await rpc(admin, 'store_domains_list'), automatic: !!v })
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

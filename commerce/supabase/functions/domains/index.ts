// Custom domains for the hosted store (staff, settings.manage):
//   POST {action: 'list'}                    saved domains with their DNS records
//   POST {action: 'add', domain}             attach to the Vercel project, return the DNS records to add
//   POST {action: 'check', domain}           ask Vercel again (verifies once DNS is in place)
//   POST {action: 'remove', domain}          detach from Vercel
//   POST {action: 'primary', domain}         make it the primary domain (the others redirect to it)
// Every add/check also runs a full diagnosis (DNS records found, each region,
// HTTPS, issues such as a Cloudflare proxy), saved with the domain.
// Needs the function secrets VERCEL_TOKEN and VERCEL_PROJECT_ID (and VERCEL_TEAM_ID
// for a team project). Without them the domain is saved as MANUAL with the DNS
// records to add, and the platform owner attaches it in Vercel by hand.
import { z } from 'zod'
import { apexOf, diagnose, type Diagnosis } from '../_shared/domain-check.ts'
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

/** Apex (shop.com) points an A record at Vercel; a subdomain (www.shop.com) a CNAME. */
export function baseRecords(d: string): DnsRecord[] {
  const apex = apexOf(d)
  return d === apex
    ? [{ type: 'A', name: '@', value: '76.76.21.21', why: 'Points your domain at the store' }]
    : [{ type: 'CNAME', name: d.slice(0, -(apex.length + 1)), value: 'cname.vercel-dns.com', why: 'Points this subdomain at the store' }]
}

/** Without the hosting API: the diagnosis alone decides whether the domain is live. */
async function manual(d: string, note: string): Promise<Omit<Saved, 'domain'>> {
  const diagnostics = await diagnose(d)
  const live = diagnostics.pointed && diagnostics.tls.ok && diagnostics.tls.served_by_store === true
  return { status: live ? 'ACTIVE' : 'MANUAL', records: baseRecords(d), diagnostics,
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

type VercelDomain = { name: string; verified: boolean; verification?: Array<{ type: string; domain: string; value: string; reason: string }>; error?: { code: string; message: string } }
type VercelConfig = { misconfigured: boolean; configuredBy?: string | null }

/** Asks Vercel where the domain stands and turns it into records + a status. */
async function inspect(v: NonNullable<ReturnType<typeof vercel>>, d: string): Promise<Omit<Saved, 'domain'>> {
  const info = await v.call<VercelDomain>('GET', `/v9/projects/${v.project}/domains/${d}`)
  if (!info.ok) return { status: 'ERROR', records: baseRecords(d), detail: info.data.error?.message ?? `Vercel answered ${info.status}` }
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
  const records = [...baseRecords(d), ...ownership]
  const diagnostics = await diagnose(d, { vercelPointed: config.ok ? pointed : null })
  if (verified && pointed) return { status: 'ACTIVE', records, diagnostics, detail: 'Live — the store opens on this domain with HTTPS' }
  return { status: 'VERIFYING', records, diagnostics, detail: !pointed ? 'Waiting for the DNS records below (changes can take up to a few hours)' : 'Waiting for the ownership record below' }
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(actions, await readJson(req))
    const staff = await requireStaff(req, input.action === 'list' ? 'settings.view' : 'settings.manage', { supportView: input.action === 'list' })
    const admin = staff.admin
    const v = vercel()
    const save = (d: string, p: Omit<Saved, 'domain'>) => rpc<Saved>(admin, 'store_domain_save', { p_domain: d, p, p_actor: staff.user.id })

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
  }),
)

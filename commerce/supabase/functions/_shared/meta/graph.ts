// Meta Marketing API (Graph API) client: ad accounts, pages, campaigns,
// ad sets, ads and daily insights per ad and placement. The access token
// goes in the Authorization header (never in a URL), and appsecret_proof is
// added when META_APP_SECRET is set.
import { env } from '../env.ts'

type FetchFn = typeof fetch

export class MetaApiError extends Error {
  constructor(message: string, readonly code?: number, readonly subcode?: number, readonly status?: number) {
    super(message)
  }
  /** The token expired or was revoked: reconnect. */
  get tokenInvalid(): boolean {
    return this.code === 190 || this.code === 102
  }
  /** The token works but may not read this account (needs ads_read). */
  get noAccess(): boolean {
    return this.code === 10 || (this.code !== undefined && this.code >= 200 && this.code < 300)
  }
  /** Too many calls: try again later. */
  get rateLimited(): boolean {
    return this.code !== undefined && ([4, 17, 32, 613].includes(this.code) || (this.code >= 80000 && this.code <= 80014))
  }
}

export interface GraphOptions {
  fetchFn?: FetchFn
  baseUrl?: string
  version?: string
  appSecret?: string
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class MetaGraph {
  private readonly fetchFn: FetchFn
  private readonly root: string
  private readonly appSecret?: string
  private proof?: Promise<string>

  constructor(private readonly token: string, opts: GraphOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch
    const base = (opts.baseUrl ?? env('META_GRAPH_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')
    this.root = `${base}/${opts.version ?? env('META_GRAPH_VERSION') ?? 'v23.0'}`
    this.appSecret = opts.appSecret ?? env('META_APP_SECRET')
  }

  private async withProof(url: URL): Promise<URL> {
    if (this.appSecret && !url.searchParams.has('appsecret_proof')) {
      this.proof ??= hmacHex(this.appSecret, this.token)
      url.searchParams.set('appsecret_proof', await this.proof)
    }
    url.searchParams.delete('access_token')
    return url
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetchFn((await this.withProof(url)).toString(), {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let body: Record<string, unknown> | null = null
    try {
      body = JSON.parse(text)
    } catch {
      // not JSON
    }
    const err = body?.error as { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } | undefined
    if (!response.ok || err) {
      const message = err?.error_user_msg || err?.message || `Meta returned HTTP ${response.status}: ${text.slice(0, 160)}`
      throw new MetaApiError(`Meta: ${message}`, err?.code, err?.error_subcode, response.status)
    }
    if (!body) throw new MetaApiError(`Meta returned an unexpected reply: ${text.slice(0, 160)}`, undefined, undefined, response.status)
    return body as T
  }

  get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.root}/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return this.request<T>(url)
  }

  /** Every item of a list endpoint, following paging.next (up to maxPages). */
  async all<T>(path: string, params: Record<string, string> = {}, maxPages = 50): Promise<T[]> {
    const items: T[] = []
    let page = await this.get<{ data?: T[]; paging?: { next?: string } }>(path, { limit: '200', ...params })
    for (let i = 0; ; i++) {
      items.push(...(page.data ?? []))
      const next = page.paging?.next
      if (!next || i + 1 >= maxPages) break
      page = await this.request<{ data?: T[]; paging?: { next?: string } }>(new URL(next))
    }
    return items
  }
}

// -----------------------------------------------------------------------------
// What the app reads
// -----------------------------------------------------------------------------
export interface AdAccount {
  id: string
  name: string
  currency: string
  timezone: string | null
  status: number | null
}

export const normalizeAccountId = (id: string) => (id.startsWith('act_') ? id : `act_${id.replace(/\D/g, '')}`)

export async function listAdAccounts(graph: MetaGraph): Promise<AdAccount[]> {
  const rows = await graph.all<Record<string, unknown>>('me/adaccounts', { fields: 'id,account_id,name,currency,timezone_name,account_status' }, 10)
  return rows.map((a) => ({
    id: normalizeAccountId(String(a.id ?? a.account_id)),
    name: String(a.name ?? a.account_id ?? a.id),
    currency: String(a.currency ?? ''),
    timezone: (a.timezone_name as string) ?? null,
    status: typeof a.account_status === 'number' ? a.account_status : null,
  }))
}

export async function getAdAccount(graph: MetaGraph, accountId: string): Promise<AdAccount> {
  const a = await graph.get<Record<string, unknown>>(normalizeAccountId(accountId), { fields: 'id,account_id,name,currency,timezone_name,account_status' })
  return {
    id: normalizeAccountId(String(a.id ?? accountId)), name: String(a.name ?? accountId), currency: String(a.currency ?? ''),
    timezone: (a.timezone_name as string) ?? null, status: typeof a.account_status === 'number' ? a.account_status : null,
  }
}

export interface PageInfo { id: string; name: string; instagram: { id: string; username: string | null } | null }

/** Facebook Pages the token can see (and their Instagram accounts). Empty when the token lacks page access. */
export async function listPages(graph: MetaGraph): Promise<PageInfo[]> {
  try {
    const rows = await graph.all<Record<string, unknown>>('me/accounts', { fields: 'id,name,instagram_business_account{id,username}' }, 5)
    return rows.map((p) => {
      const ig = p.instagram_business_account as { id?: string; username?: string } | undefined
      return { id: String(p.id), name: String(p.name ?? p.id), instagram: ig?.id ? { id: String(ig.id), username: ig.username ?? null } : null }
    })
  } catch (error) {
    if (error instanceof MetaApiError && error.tokenInvalid) throw error
    return []
  }
}

export async function fetchStructure(graph: MetaGraph, accountId: string) {
  const act = normalizeAccountId(accountId)
  const [campaigns, adsets, ads] = [
    await graph.all<Record<string, unknown>>(`${act}/campaigns`, {
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time',
    }),
    await graph.all<Record<string, unknown>>(`${act}/adsets`, {
      fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time',
    }),
    await graph.all<Record<string, unknown>>(`${act}/ads`, {
      fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url,title,body}',
    }),
  ]
  return { campaigns, adsets, ads }
}

type ActionList = Array<{ action_type?: string; value?: string }> | undefined
// One purchase counted once: Meta reports the same purchase under several names.
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']

export function pickPurchase(list: ActionList): number {
  for (const type of PURCHASE_TYPES) {
    const hit = list?.find((a) => a.action_type === type)
    if (hit) return Number(hit.value) || 0
  }
  return 0
}

export interface InsightRow {
  ad_id: string
  adset_id: string | null
  campaign_id: string | null
  ad_name: string | null
  adset_name: string | null
  campaign_name: string | null
  date: string
  platform: string
  spend: number
  impressions: number
  clicks: number
  link_clicks: number
  purchases: number
  purchase_value: number
}

export function mapInsight(r: Record<string, unknown>): InsightRow {
  const n = (v: unknown) => Number(v ?? 0) || 0
  return {
    ad_id: String(r.ad_id), adset_id: (r.adset_id as string) ?? null, campaign_id: (r.campaign_id as string) ?? null,
    ad_name: (r.ad_name as string) ?? null, adset_name: (r.adset_name as string) ?? null, campaign_name: (r.campaign_name as string) ?? null,
    date: String(r.date_start), platform: String(r.publisher_platform ?? 'unknown'),
    spend: n(r.spend), impressions: n(r.impressions), clicks: n(r.clicks), link_clicks: n(r.inline_link_clicks),
    purchases: pickPurchase(r.actions as ActionList), purchase_value: pickPurchase(r.action_values as ActionList),
  }
}

/** Splits [since, until] into windows of at most `days` days. */
export function dateWindows(since: string, until: string, days = 7): Array<{ since: string; until: string }> {
  const out: Array<{ since: string; until: string }> = []
  const day = 86_400_000
  let start = Date.parse(`${since}T00:00:00Z`)
  const end = Date.parse(`${until}T00:00:00Z`)
  while (start <= end) {
    const stop = Math.min(start + (days - 1) * day, end)
    out.push({ since: new Date(start).toISOString().slice(0, 10), until: new Date(stop).toISOString().slice(0, 10) })
    start = stop + day
  }
  return out
}

/** Daily insights per ad and placement for one window. */
export async function fetchInsights(graph: MetaGraph, accountId: string, since: string, until: string): Promise<InsightRow[]> {
  const rows = await graph.all<Record<string, unknown>>(`${normalizeAccountId(accountId)}/insights`, {
    level: 'ad',
    time_increment: '1',
    breakdowns: 'publisher_platform',
    time_range: JSON.stringify({ since, until }),
    fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,date_start',
    limit: '500',
  }, 200)
  return rows.filter((r) => r.ad_id).map(mapInsight)
}

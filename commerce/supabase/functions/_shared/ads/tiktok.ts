// TikTok API for Business (Marketing API v1.3): the store's own developer app
// authorises advertiser accounts, then campaigns and daily campaign numbers
// are read. Tokens travel in the Access-Token header, never in a URL.
import { env } from '../env.ts'

type FetchFn = typeof fetch

export class TikTokError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
  /** The authorisation was revoked or expired: connect again. */
  get tokenInvalid(): boolean {
    return this.code !== undefined && [40100, 40101, 40102, 40104, 40105].includes(this.code)
  }
  get rateLimited(): boolean {
    return this.code === 40016 || this.code === 50002
  }
}

export interface TikTokApp { appId: string; secret: string }
export interface TikTokAdvertiser { external_id: string; name: string | null; currency: string | null; timezone: string | null }
export interface DailyRow { campaign_id: string; date: string; spend: number; impressions: number; clicks: number; conversions: number; conversion_value: number }
export interface CampaignRow { id: string; name: string; status: string | null }

const apiBase = () => (env('TIKTOK_API_URL') ?? 'https://business-api.tiktok.com').replace(/\/+$/, '')

/** The TikTok screen where the advertiser approves the app. */
export function tiktokAuthUrl(appId: string, state: string, redirectUri: string): string {
  const portal = (env('TIKTOK_PORTAL_URL') ?? 'https://business-api.tiktok.com').replace(/\/+$/, '')
  return `${portal}/portal/auth?app_id=${encodeURIComponent(appId)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`
}

export class TikTokClient {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  private async call<T>(method: 'GET' | 'POST', path: string, opts: { token?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${apiBase()}/open_api/v1.3/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.token) headers['Access-Token'] = opts.token
    if (opts.body) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetchFn(url.toString(), { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new TikTokError((error as Error).name === 'TimeoutError' ? 'TikTok did not answer in time' : 'Could not reach TikTok')
    }
    const json = (await response.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null
    if (!json) throw new TikTokError(`TikTok answered HTTP ${response.status} without a body`)
    if (json.code !== 0) throw new TikTokError(`TikTok: ${json.message ?? `error ${json.code}`}`, json.code)
    return json.data as T
  }

  /** auth_code from the callback → a long-lived access token and the advertisers it covers. */
  async exchange(app: TikTokApp, authCode: string): Promise<{ accessToken: string; advertiserIds: string[] }> {
    const data = await this.call<{ access_token?: string; advertiser_ids?: Array<string | number> }>('POST', 'oauth2/access_token/', {
      body: { app_id: app.appId, secret: app.secret, auth_code: authCode },
    })
    if (!data?.access_token) throw new TikTokError('TikTok did not return an access token')
    return { accessToken: data.access_token, advertiserIds: (data.advertiser_ids ?? []).map(String) }
  }

  /** Every advertiser the authorisation can read, with currency and time zone. */
  async advertisers(app: TikTokApp, token: string, known: string[] = []): Promise<TikTokAdvertiser[]> {
    const listed = await this.call<{ list?: Array<{ advertiser_id: string | number; advertiser_name?: string }> }>('GET', 'oauth2/advertiser/get/', {
      token, query: { app_id: app.appId, secret: app.secret },
    })
    const ids = [...new Set([...(listed?.list ?? []).map((a) => String(a.advertiser_id)), ...known])]
    if (!ids.length) return []
    const names = new Map((listed?.list ?? []).map((a) => [String(a.advertiser_id), a.advertiser_name ?? null]))
    const info = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < ids.length; i += 100) {
      const data = await this.call<{ list?: Array<Record<string, unknown>> }>('GET', 'advertiser/info/', {
        token, query: { advertiser_ids: JSON.stringify(ids.slice(i, i + 100)), fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone']) },
      }).catch(() => ({ list: [] }))
      for (const row of data?.list ?? []) info.set(String(row.advertiser_id), row)
    }
    return ids.map((id) => {
      const r = info.get(id) ?? {}
      return {
        external_id: id, name: (r.name as string) ?? names.get(id) ?? null, currency: (r.currency as string) ?? null,
        timezone: (r.display_timezone as string) ?? (r.timezone as string) ?? null,
      }
    })
  }

  async campaigns(token: string, advertiserId: string): Promise<CampaignRow[]> {
    const out: CampaignRow[] = []
    for (let page = 1; page <= 50; page++) {
      const data = await this.call<{ list?: Array<Record<string, unknown>>; page_info?: { total_page?: number } }>('GET', 'campaign/get/', {
        token, query: { advertiser_id: advertiserId, page: String(page), page_size: '1000', fields: JSON.stringify(['campaign_id', 'campaign_name', 'operation_status', 'secondary_status']) },
      })
      for (const c of data?.list ?? []) out.push({ id: String(c.campaign_id), name: String(c.campaign_name ?? ''), status: (c.operation_status as string) ?? null })
      if (page >= (data?.page_info?.total_page ?? 1)) break
    }
    return out
  }

  /** Spend, impressions, clicks and conversions per campaign and day (in the advertiser's currency). */
  async daily(token: string, advertiserId: string, since: string, until: string): Promise<DailyRow[]> {
    const out: DailyRow[] = []
    for (let page = 1; page <= 100; page++) {
      const data = await this.call<{ list?: Array<{ dimensions?: Record<string, string>; metrics?: Record<string, string> }>; page_info?: { total_page?: number } }>(
        'GET', 'report/integrated/get/', {
          token, query: {
            advertiser_id: advertiserId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN',
            dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
            metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']),
            start_date: since, end_date: until, page: String(page), page_size: '1000',
          },
        })
      for (const r of data?.list ?? []) {
        const d = r.dimensions ?? {}
        const m = r.metrics ?? {}
        if (!d.campaign_id || !d.stat_time_day) continue
        out.push({
          campaign_id: String(d.campaign_id), date: String(d.stat_time_day).slice(0, 10), spend: Number(m.spend) || 0,
          impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0, conversions: Number(m.conversion) || 0, conversion_value: 0,
        })
      }
      if (page >= (data?.page_info?.total_page ?? 1)) break
    }
    return out
  }
}

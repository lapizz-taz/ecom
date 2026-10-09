// Google Ads API with the store's own OAuth client and developer token:
// staff sign in with Google, the refresh token is kept in Vault, accessible
// customer accounts (and the clients of manager accounts) are listed, and
// campaign numbers per day are read with GAQL.
import { env } from '../env.ts'
import type { CampaignRow, DailyRow } from './tiktok.ts'

type FetchFn = typeof fetch

export class GoogleAdsError extends Error {
  constructor(message: string, readonly status?: number, readonly reason?: string) {
    super(message)
  }
  get tokenInvalid(): boolean {
    return this.reason === 'invalid_grant' || this.status === 401
  }
  get rateLimited(): boolean {
    return this.status === 429 || this.reason === 'RESOURCE_EXHAUSTED'
  }
}

export interface GoogleApp { clientId: string; clientSecret: string; developerToken: string; loginCustomerId?: string | null }
export interface GoogleCustomer {
  external_id: string
  login_customer_id: string | null
  name: string | null
  currency: string | null
  timezone: string | null
  is_manager: boolean
}

export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/adwords openid email'
const version = () => env('GOOGLE_ADS_API_VERSION') ?? 'v24'
const adsBase = () => `${(env('GOOGLE_ADS_API_URL') ?? 'https://googleads.googleapis.com').replace(/\/+$/, '')}/${version()}`

/** Google's sign-in screen; offline access so a refresh token comes back. */
export function googleAuthUrl(clientId: string, state: string, redirectUri: string): string {
  const base = env('GOOGLE_OAUTH_URL') ?? 'https://accounts.google.com/o/oauth2/v2/auth'
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  })
  return `${base}?${q}`
}

/** The email in an id_token received straight from Google's token endpoint. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  try {
    const part = idToken?.split('.')[1]
    if (!part) return null
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')))
    return typeof json.email === 'string' ? json.email : null
  } catch {
    return null
  }
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

export class GoogleAdsClient {
  constructor(private readonly app: GoogleApp, private readonly fetchFn: FetchFn = fetch) {}

  private async token(body: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetchFn(env('GOOGLE_TOKEN_URL') ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...body }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new GoogleAdsError('Could not reach Google')
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok || json.error) {
      const reason = String(json.error ?? response.status)
      const why = reason === 'invalid_client' ? 'The OAuth client ID or secret is wrong'
        : reason === 'invalid_grant' ? 'Google refused the sign-in (expired or revoked). Connect again'
        : reason === 'redirect_uri_mismatch' ? 'The redirect URI is not registered on the OAuth client'
        : `Google: ${json.error_description ?? reason}`
      throw new GoogleAdsError(why, response.status, reason)
    }
    return json
  }

  /** Authorisation code → refresh token, access token and the Google account's email. */
  async exchange(code: string, redirectUri: string): Promise<{ refreshToken: string | null; accessToken: string; email: string | null }> {
    const json = await this.token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    return { refreshToken: (json.refresh_token as string) ?? null, accessToken: String(json.access_token), email: emailFromIdToken(json.id_token as string) }
  }

  async accessToken(refreshToken: string): Promise<string> {
    const json = await this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' })
    return String(json.access_token)
  }

  private async api<T>(path: string, accessToken: string, init: { method?: string; body?: unknown; loginCustomerId?: string | null } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`, 'developer-token': this.app.developerToken, Accept: 'application/json',
    }
    const login = digits(init.loginCustomerId ?? this.app.loginCustomerId ?? '')
    if (login) headers['login-customer-id'] = login
    if (init.body) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetchFn(`${adsBase()}/${path}`, {
        method: init.method ?? 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new GoogleAdsError('Could not reach the Google Ads API')
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      const err = (json?.error ?? {}) as { message?: string; status?: string; details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string> }> }> }
      const detail = err.details?.flatMap((d) => d.errors ?? [])[0]
      const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : err.status
      const msg = code === 'DEVELOPER_TOKEN_NOT_APPROVED' ? 'The developer token is only approved for test accounts. Apply for Basic access in the Google Ads API Center.'
        : code === 'DEVELOPER_TOKEN_INVALID' || code === 'DEVELOPER_TOKEN_PROHIBITED' ? 'The developer token is not valid'
        : code === 'USER_PERMISSION_DENIED' ? 'This Google account cannot open that customer account (add the manager account ID if it is reached through one)'
        : detail?.message ?? err.message ?? `Google Ads answered HTTP ${response.status}`
      throw new GoogleAdsError(msg, response.status, code)
    }
    return (json ?? {}) as T
  }

  /** GAQL search, following pages. */
  async search(accessToken: string, customerId: string, query: string, loginCustomerId?: string | null): Promise<Array<Record<string, any>>> {
    const rows: Array<Record<string, any>> = []
    let pageToken: string | undefined
    for (let i = 0; i < 50; i++) {
      const res = await this.api<{ results?: Array<Record<string, any>>; nextPageToken?: string }>(
        `customers/${digits(customerId)}/googleAds:search`, accessToken, { method: 'POST', body: { query, ...(pageToken ? { pageToken } : {}) }, loginCustomerId })
      rows.push(...(res.results ?? []))
      pageToken = res.nextPageToken
      if (!pageToken) break
    }
    return rows
  }

  /** Customer accounts this sign-in can open, including the clients under manager accounts. */
  async customers(accessToken: string): Promise<GoogleCustomer[]> {
    const res = await this.api<{ resourceNames?: string[] }>('customers:listAccessibleCustomers', accessToken)
    const ids = (res.resourceNames ?? []).map((r) => digits(r.split('/').pop()))
    const out = new Map<string, GoogleCustomer>()
    for (const id of ids) {
      try {
        const [row] = await this.search(accessToken, id,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1', id)
        const c = row?.customer ?? {}
        out.set(id, { external_id: id, login_customer_id: null, name: c.descriptiveName ?? null, currency: c.currencyCode ?? null, timezone: c.timeZone ?? null, is_manager: !!c.manager })
        if (c.manager) {
          const clients = await this.search(accessToken, id,
            'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1', id)
          for (const r of clients) {
            const cc = r.customerClient ?? {}
            const cid = digits(cc.id)
            if (cid && !out.has(cid)) {
              out.set(cid, { external_id: cid, login_customer_id: id, name: cc.descriptiveName ?? null, currency: cc.currencyCode ?? null, timezone: cc.timeZone ?? null, is_manager: !!cc.manager })
            }
          }
        }
      } catch (error) {
        // An account this sign-in can list but not open is still shown (without details).
        if (!out.has(id)) out.set(id, { external_id: id, login_customer_id: null, name: null, currency: null, timezone: null, is_manager: false })
        if (error instanceof GoogleAdsError && /developer token/i.test(error.message)) throw error
      }
    }
    return [...out.values()]
  }

  async campaigns(accessToken: string, customerId: string, loginCustomerId?: string | null): Promise<CampaignRow[]> {
    const rows = await this.search(accessToken, customerId, "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'", loginCustomerId)
    return rows.map((r) => ({ id: digits(r.campaign?.id), name: String(r.campaign?.name ?? ''), status: r.campaign?.status ?? null }))
  }

  /** Cost (account currency), impressions, clicks and conversions per campaign and day. */
  async daily(accessToken: string, customerId: string, since: string, until: string, loginCustomerId?: string | null): Promise<DailyRow[]> {
    const rows = await this.search(accessToken, customerId,
      `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
      loginCustomerId)
    return rows.map((r) => ({
      campaign_id: digits(r.campaign?.id), date: String(r.segments?.date ?? ''), spend: Number(r.metrics?.costMicros ?? 0) / 1_000_000,
      impressions: Number(r.metrics?.impressions ?? 0), clicks: Number(r.metrics?.clicks ?? 0),
      conversions: Number(r.metrics?.conversions ?? 0), conversion_value: Number(r.metrics?.conversionsValue ?? 0),
    })).filter((r) => r.campaign_id && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
  }
}

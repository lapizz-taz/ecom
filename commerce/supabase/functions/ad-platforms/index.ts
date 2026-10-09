// TikTok Ads and Google Ads (staff with marketing.manage, or pg_cron):
//   POST save_app     the store's developer app (TikTok app ID + secret; Google
//                     OAuth client, secret and developer token) → Vault
//   POST auth_url     the platform's consent screen, with a one-time state
//   GET  /ad-platforms/callback/<tiktok|google>   where the platform sends
//                     staff back: the code is exchanged, the token kept in
//                     Vault, ad accounts listed, then back to the admin page
//   POST sync         campaigns and daily numbers for the chosen accounts
//   POST disconnect   erase the connection's token (numbers stay)
// Tokens and secrets never reach a browser; only masked hints are stored.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { GoogleAdsClient, GoogleAdsError, type GoogleApp, googleAuthUrl } from '../_shared/ads/google.ts'
import { type CampaignRow, type DailyRow, TikTokClient, TikTokError, type TikTokApp, tiktokAuthUrl } from '../_shared/ads/tiktok.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { env, requireEnv } from '../_shared/env.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

type Platform = 'tiktok' | 'google'
const platform = z.enum(['tiktok', 'google'])
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const saveTikTok = z.object({
  action: z.literal('save_app'), platform: z.literal('tiktok'),
  app_id: z.string().trim().regex(/^[0-9]{6,32}$/, 'The TikTok App ID is a number from your app page'),
  secret: z.preprocess(blank, z.string().trim().regex(/^[A-Za-z0-9]{20,80}$/, 'The TikTok app Secret looks wrong').optional()),
})
const saveGoogle = z.object({
  action: z.literal('save_app'), platform: z.literal('google'),
  client_id: z.string().trim().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, 'The OAuth client ID ends with .apps.googleusercontent.com'),
  client_secret: z.preprocess(blank, z.string().trim().min(10, 'The OAuth client secret looks wrong').max(100).optional()),
  developer_token: z.preprocess(blank, z.string().trim().regex(/^[A-Za-z0-9_-]{15,40}$/, 'The developer token is a 22-character code from the API Center').optional()),
  login_customer_id: z.preprocess(blank, z.string().trim().regex(/^[0-9-]{10,12}$/, 'Manager account ID like 123-456-7890').optional().nullable()),
})
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('auth_url'), platform, return_to: z.string().url().max(500) }),
  z.object({ action: z.literal('disconnect'), platform, connection_id: z.string().uuid() }),
  z.object({ action: z.literal('sync'), platform: platform.optional(), account_id: z.string().uuid().optional(), days: z.number().int().min(1).max(90).default(3) }),
])

/** Each form is checked on its own, so the message names the field that is wrong. */
function parseInput(body: unknown) {
  const b = (body ?? {}) as { action?: string; platform?: string }
  if (b.action === 'save_app') return b.platform === 'google' ? parse(saveGoogle, body) : parse(saveTikTok, body)
  return parse(actions, body)
}

const appKey = (p: Platform) => `ads.${p}.app`
const tokenKey = (p: Platform, connectionId: string) => `ads.${p}.${connectionId.replace(/-/g, '')}`
const hint = (v: string) => `••••${v.slice(-4)}`
const publicBase = () => (env('PUBLIC_SUPABASE_URL') ?? requireEnv('SUPABASE_URL')).replace(/\/+$/, '')
export const redirectUri = (p: Platform) => `${publicBase()}/functions/v1/ad-platforms/callback/${p}`

async function secret<T>(admin: SupabaseClient, key: string): Promise<T> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: key })
  if (error) throw new Error(`Could not read stored credentials: ${error.message}`)
  return (data ?? {}) as T
}

async function tiktokApp(admin: SupabaseClient): Promise<TikTokApp> {
  const s = await secret<{ app_id?: string; secret?: string }>(admin, appKey('tiktok'))
  if (!s.app_id || !s.secret) throw new HttpError(422, 'Add your TikTok developer app first (App ID and Secret)', 'NOT_CONFIGURED')
  return { appId: s.app_id, secret: s.secret }
}

async function googleApp(admin: SupabaseClient): Promise<GoogleApp> {
  const s = await secret<{ client_id?: string; client_secret?: string; developer_token?: string; login_customer_id?: string }>(admin, appKey('google'))
  if (!s.client_id || !s.client_secret || !s.developer_token) {
    throw new HttpError(422, 'Add your Google Ads API app first (OAuth client ID, client secret and developer token)', 'NOT_CONFIGURED')
  }
  return { clientId: s.client_id, clientSecret: s.client_secret, developerToken: s.developer_token, loginCustomerId: s.login_customer_id ?? null }
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const page = (title: string, body: string, status = 400) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })

function back(returnTo: string, params: Record<string, string>): Response {
  const url = new URL(returnTo)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } })
}

/** Store date for "today" and n-1 days before, in the account's time zone. */
function syncWindow(days: number, timeZone: string | null) {
  let tz = timeZone || 'Asia/Dhaka'
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }) } catch { tz = 'Asia/Dhaka' }
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return { since: fmt(new Date(Date.now() - (days - 1) * 86_400_000)), until: fmt(new Date()) }
}

function windows(since: string, until: string, size: number) {
  const out: Array<{ since: string; until: string }> = []
  let start = Date.parse(`${since}T00:00:00Z`)
  const end = Date.parse(`${until}T00:00:00Z`)
  while (start <= end) {
    const stop = Math.min(start + (size - 1) * 86_400_000, end)
    out.push({ since: new Date(start).toISOString().slice(0, 10), until: new Date(stop).toISOString().slice(0, 10) })
    start = stop + 86_400_000
  }
  return out
}

interface AccountRow {
  id: string; platform: 'TIKTOK' | 'GOOGLE'; connection_id: string; external_id: string; login_customer_id: string | null
  name: string | null; timezone: string | null
}

async function syncAccount(admin: SupabaseClient, account: AccountRow, days: number) {
  const p = account.platform.toLowerCase() as Platform
  const { since, until } = syncWindow(days, account.timezone)
  const totals = { campaigns: 0, rows: 0, cost: 0 }
  try {
    let campaigns: CampaignRow[]
    let read: (s: string, u: string) => Promise<DailyRow[]>
    if (p === 'tiktok') {
      const { access_token } = await secret<{ access_token?: string }>(admin, tokenKey(p, account.connection_id))
      if (!access_token) throw new TikTokError('The TikTok authorisation is missing. Connect TikTok again.', 40105)
      const client = new TikTokClient()
      campaigns = await client.campaigns(access_token, account.external_id)
      read = (s, u) => client.daily(access_token, account.external_id, s, u)
    } else {
      const { refresh_token } = await secret<{ refresh_token?: string }>(admin, tokenKey(p, account.connection_id))
      if (!refresh_token) throw new GoogleAdsError('The Google sign-in is missing. Connect Google Ads again.', 401, 'invalid_grant')
      const client = new GoogleAdsClient(await googleApp(admin))
      const access = await client.accessToken(refresh_token)
      campaigns = await client.campaigns(access, account.external_id, account.login_customer_id)
      read = (s, u) => client.daily(access, account.external_id, s, u, account.login_customer_id)
    }
    for (const [i, w] of windows(since, until, 30).entries()) {
      const rows = await read(w.since, w.until)
      const result = await rpc<{ campaigns: number; rows: number; cost: number }>(admin, 'ad_platform_apply_sync', {
        p: { account_id: account.id, since: w.since, until: w.until, campaigns: i === 0 ? campaigns : [], days: rows },
      })
      totals.campaigns += result.campaigns ?? 0
      totals.rows += result.rows ?? 0
      totals.cost += Number(result.cost ?? 0)
    }
    await rpc(admin, 'ad_account_record_sync', { p_id: account.id, p_status: 'OK', p_error: null, p_since: since, p_until: until })
    return { id: account.id, name: account.name, ok: true, since, until, ...totals }
  } catch (error) {
    const e = error as TikTokError | GoogleAdsError
    const status = 'tokenInvalid' in e && e.tokenInvalid ? 'TOKEN_INVALID' : 'rateLimited' in e && e.rateLimited ? 'RATE_LIMITED' : 'FAILED'
    const message = (error as Error).message
    await rpc(admin, 'ad_account_record_sync', { p_id: account.id, p_status: status, p_error: message, p_since: since, p_until: until })
    if (status === 'TOKEN_INVALID') await rpc(admin, 'ad_connection_failed', { p_id: account.connection_id, p_error: message })
    void logEvent({
      level: status === 'RATE_LIMITED' ? 'WARN' : 'ERROR', category: 'OTHER', source: 'ad-platforms',
      message: `${p === 'tiktok' ? 'TikTok' : 'Google'} Ads sync failed for ${account.name ?? account.external_id}: ${message}`,
      context: { account: account.external_id, status, since, until },
    })
    return { id: account.id, name: account.name, ok: false, status, error: message, since, until }
  }
}

async function syncMany(admin: SupabaseClient, platformName: Platform | undefined, accountId: string | undefined, days: number) {
  const accounts = await rpc<AccountRow[]>(admin, 'ad_accounts_for_sync', { p_platform: platformName ?? null, p_account_id: accountId ?? null })
  const results = []
  for (const a of accounts) results.push(await syncAccount(admin, a, days))
  return results
}

/** The platform sent staff back with a code: exchange it, list accounts, return to the admin page. */
async function callback(req: Request, p: Platform): Promise<Response> {
  const url = new URL(req.url)
  const state = url.searchParams.get('state') ?? ''
  const admin = adminClient()
  const taken = state ? await rpc<{ created_by: string; return_to: string } | null>(admin, 'ad_oauth_state_take', { p_platform: p, p_state: state }) : null
  if (!taken) return page('This link has expired', 'Go back to the admin page and click Connect again.')
  const name = p === 'tiktok' ? 'TikTok' : 'Google'
  const denied = url.searchParams.get('error')
  if (denied) return back(taken.return_to, { error: denied === 'access_denied' ? `${name} access was not allowed` : `${name}: ${denied}` })

  try {
    let saved: { id: string }
    if (p === 'tiktok') {
      const code = url.searchParams.get('auth_code') ?? url.searchParams.get('code') ?? ''
      if (!code) throw new Error('TikTok did not send an authorisation code')
      const app = await tiktokApp(admin)
      const client = new TikTokClient()
      const { accessToken, advertiserIds } = await client.exchange(app, code)
      const advertisers = await client.advertisers(app, accessToken, advertiserIds)
      saved = await rpc(admin, 'ad_connection_save', {
        p_platform: 'tiktok',
        p: { external_user: `app-${app.appId}:${advertiserIds.slice().sort().join(',') || 'none'}`, display_name: `${advertisers.length} advertiser${advertisers.length === 1 ? '' : 's'}`, token_hint: hint(accessToken), accounts: advertisers },
        p_actor: taken.created_by,
      })
      await rpc(admin, 'integration_secret_store', { p_key: tokenKey(p, saved.id), p_value: { access_token: accessToken }, p_hint: hint(accessToken), p_actor: taken.created_by })
    } else {
      const code = url.searchParams.get('code') ?? ''
      if (!code) throw new Error('Google did not send an authorisation code')
      const client = new GoogleAdsClient(await googleApp(admin))
      const { refreshToken, accessToken, email } = await client.exchange(code, redirectUri('google'))
      if (!refreshToken) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.')
      const customers = await client.customers(accessToken)
      saved = await rpc(admin, 'ad_connection_save', {
        p_platform: 'google', p: { external_user: email ?? `google-${crypto.randomUUID()}`, display_name: email, token_hint: hint(refreshToken), accounts: customers },
        p_actor: taken.created_by,
      })
      await rpc(admin, 'integration_secret_store', { p_key: tokenKey(p, saved.id), p_value: { refresh_token: refreshToken }, p_hint: hint(refreshToken), p_actor: taken.created_by })
    }
    // First sync (30 days) for the accounts already chosen, after the redirect.
    const task = syncMany(admin, p, undefined, 30).catch((error) => logEvent({ level: 'ERROR', category: 'OTHER', source: 'ad-platforms', message: 'First sync failed', error }))
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task)
    return back(taken.return_to, { connected: p })
  } catch (error) {
    const message = (error as Error).message
    void logEvent({ level: 'ERROR', category: 'OTHER', source: 'ad-platforms', message: `${name} connect failed: ${message}`, error })
    return back(taken.return_to, { error: message.slice(0, 200) })
  }
}

Deno.serve(
  handle(async (req) => {
    const path = new URL(req.url).pathname
    const cb = /\/callback\/(tiktok|google)\/?$/.exec(path)
    if (req.method === 'GET' && cb) return callback(req, cb[1] as Platform)
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const input = parseInput(await readJson(req))
    const admin = adminClient()
    const cron = input.action === 'sync' && await isCronRequest(req, admin)
    const staff = cron ? null : await requireStaff(req, 'marketing.manage')

    switch (input.action) {
      case 'save_app': {
        const saved = await secret<Record<string, string>>(admin, appKey(input.platform))
        if (input.platform === 'tiktok') {
          const value = { app_id: input.app_id, secret: input.secret ?? saved.secret }
          if (!value.secret) throw new HttpError(422, 'Enter the app Secret', 'VALIDATION')
          await rpc(admin, 'integration_secret_store', { p_key: appKey('tiktok'), p_value: value, p_hint: `App ${input.app_id}`, p_actor: staff!.user.id })
          const app = await rpc(admin, 'ad_app_set', { p_platform: 'tiktok', p: { app_id: input.app_id, configured: true, hint: `secret ${hint(value.secret)}` }, p_actor: staff!.user.id })
          return json(req, { ok: true, app, redirect_uri: redirectUri('tiktok') })
        }
        const value = {
          client_id: input.client_id, client_secret: input.client_secret ?? saved.client_secret,
          developer_token: input.developer_token ?? saved.developer_token, login_customer_id: input.login_customer_id?.replace(/\D/g, '') || null,
        }
        if (!value.client_secret || !value.developer_token) throw new HttpError(422, 'Enter the client secret and the developer token', 'VALIDATION')
        await rpc(admin, 'integration_secret_store', { p_key: appKey('google'), p_value: value, p_hint: `Client ${hint(input.client_id.split('.')[0])}`, p_actor: staff!.user.id })
        const app = await rpc(admin, 'ad_app_set', {
          p_platform: 'google', p: { client_id: input.client_id, login_customer_id: value.login_customer_id, configured: true, hint: `token ${hint(value.developer_token)}` },
          p_actor: staff!.user.id,
        })
        return json(req, { ok: true, app, redirect_uri: redirectUri('google') })
      }
      case 'auth_url': {
        const state = randomState()
        await rpc(admin, 'ad_oauth_state_create', { p_platform: input.platform, p_state: state, p_actor: staff!.user.id, p_return_to: input.return_to })
        const url = input.platform === 'tiktok'
          ? tiktokAuthUrl((await tiktokApp(admin)).appId, state, redirectUri('tiktok'))
          : googleAuthUrl((await googleApp(admin)).clientId, state, redirectUri('google'))
        return json(req, { url, redirect_uri: redirectUri(input.platform) })
      }
      case 'disconnect': {
        await rpc(admin, 'integration_secret_clear', { p_key: tokenKey(input.platform, input.connection_id), p_actor: staff!.user.id })
        await rpc(admin, 'ad_connection_disconnect', { p_id: input.connection_id, p_actor: staff!.user.id })
        return json(req, { ok: true })
      }
      case 'sync': {
        const results = await syncMany(admin, input.platform, input.account_id, input.days)
        if (!results.length) {
          if (cron) return json(req, { ok: true, skipped: 'no accounts chosen' })
          throw new HttpError(422, 'Choose at least one ad account to sync', 'NOT_CONNECTED')
        }
        const failed = results.filter((r) => !r.ok)
        if (!cron && input.account_id && failed.length) throw new HttpError(502, failed[0].error ?? 'Sync failed', failed[0].status ?? 'FAILED')
        return json(req, {
          ok: failed.length === 0, accounts: results,
          rows: results.reduce((s, r) => s + ('rows' in r ? r.rows : 0), 0),
          cost: results.reduce((s, r) => s + ('cost' in r ? r.cost : 0), 0),
        })
      }
    }
  }),
)

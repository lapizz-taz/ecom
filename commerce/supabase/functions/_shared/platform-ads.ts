// Fullfilio's own Meta ad accounts (Super Admin → Income & Expenses → Ad accounts).
// The token and app secret live in Vault as platform credentials (one entry per
// account); the database keeps the account, a masked hint and the daily spend,
// which lands in the books as one Ads expense per account and day.
//   check   open the ad account with the token (and appsecret_proof), then ask
//           Meta about the token itself when the App ID and secret are known
//   sync    the account's spend per day for a window, then record how it went
import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from './http.ts'
import {
  ACCOUNT_STATUS, type AdAccount, dateWindows, debugToken, fetchDailySpend, getAdAccount, MetaApiError, MetaGraph, type TokenInfo,
} from './meta/graph.ts'
import { logEvent } from './monitoring.ts'
import { rpc } from './supabase.ts'

export interface PlatformAdSecrets { access_token?: string; app_secret?: string }
export interface PlatformAdAccount {
  id: string
  name: string
  ad_account_id: string
  app_id: string | null
  is_active: boolean
  timezone: string | null
  currency: string | null
}

// Platform credential keys allow [a-z0-9_.:-].
export const platformAdSecretKey = (id: string) => `finance.ads.meta.${id.replace(/-/g, '')}`
export const tokenHint = (t: string) => `••••${t.slice(-4)}`

export async function platformAdSecrets(admin: SupabaseClient, id: string): Promise<PlatformAdSecrets> {
  return (await rpc<PlatformAdSecrets | null>(admin, 'platform_secret_get', { p_key: platformAdSecretKey(id) })) ?? {}
}

/** Plain-language reason Meta refused, for the person filling in the form. */
export function explainMeta(error: unknown, adAccountId: string): string {
  if (error instanceof MetaApiError) {
    if (/appsecret_proof/i.test(error.message)) return 'The App Secret does not belong to the app that issued this token.'
    if (error.tokenInvalid) return 'The access token is not valid or has expired. Generate a new System User token.'
    if (error.noAccess) return `This token cannot read ad account ${adAccountId}. In Business Settings, give the system user access to it with ads_read.`
    if (error.rateLimited) return 'Meta asked us to slow down. Try again in a few minutes.'
  }
  return (error as Error).message
}

export interface AdCheck { account: AdAccount; token: TokenInfo | null; warnings: string[] }

export async function checkAdAccount(creds: PlatformAdSecrets, appId: string | undefined, adAccountId: string, fetchFn?: typeof fetch): Promise<AdCheck> {
  if (!creds.access_token) throw new HttpError(422, 'Paste the access token', 'VALIDATION')
  const warnings: string[] = []
  let account: AdAccount
  let token: TokenInfo | null = null
  try {
    account = await getAdAccount(new MetaGraph(creds.access_token, { appSecret: creds.app_secret ?? '', fetchFn }), adAccountId)
    if (appId && creds.app_secret) token = await debugToken(creds.access_token, appId, creds.app_secret, { fetchFn })
  } catch (error) {
    throw new HttpError(422, explainMeta(error, adAccountId), 'META_REJECTED')
  }
  if (token) {
    if (!token.valid) throw new HttpError(422, 'Meta says this access token is not valid.', 'META_REJECTED')
    if (token.appId && appId && token.appId !== appId) {
      throw new HttpError(422, `This token was issued by app ${token.appId}, not ${appId}. Check the App ID.`, 'META_REJECTED')
    }
    if (token.scopes.length && !token.scopes.includes('ads_read') && !token.scopes.includes('ads_management')) {
      warnings.push('The token has no ads_read permission; spend may not sync.')
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() - Date.now() < 14 * 86_400_000) {
      warnings.push(`The token expires on ${token.expiresAt.slice(0, 10)}. A System User token that never expires is better.`)
    }
  } else if (!creds.app_secret) {
    warnings.push('Without the App Secret, calls are not signed with appsecret_proof.')
  }
  if (account.status != null && account.status !== 1) {
    warnings.push(`Meta shows this ad account as ${ACCOUNT_STATUS[account.status] ?? `status ${account.status}`}.`)
  }
  return { account, token, warnings }
}

/** The account's own date (Asia/Dhaka unless Meta says otherwise) for today and n-1 days before. */
export function spendWindow(days: number, timeZone = 'Asia/Dhaka', now = new Date()) {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return { since: fmt(new Date(now.getTime() - (days - 1) * 86_400_000)), until: fmt(now) }
}

export interface SpendSyncResult {
  id: string; name: string; ok: boolean; since: string; until: string
  days?: number; amount?: number; foreign_amount?: number | null; status?: string; error?: string
}

export async function syncPlatformAdSpend(
  admin: SupabaseClient, account: PlatformAdAccount, creds: PlatformAdSecrets, range: { since: string; until: string }, fetchFn?: typeof fetch,
): Promise<SpendSyncResult> {
  const { since, until } = range
  const totals = { days: 0, amount: 0, foreign_amount: 0 }
  try {
    if (!creds.access_token) throw new MetaApiError('The access token is missing. Edit the account and paste it again.', 190)
    const graph = new MetaGraph(creds.access_token, { appSecret: creds.app_secret ?? '', fetchFn })
    for (const w of dateWindows(since, until, 31)) {
      const rows = await fetchDailySpend(graph, account.ad_account_id, w.since, w.until)
      const r = await rpc<{ days: number; amount: number; foreign_amount: number | null }>(admin, 'platform_ad_spend_apply',
        { p_id: account.id, p_since: w.since, p_until: w.until, p_rows: rows })
      totals.days += r.days
      totals.amount += Number(r.amount ?? 0)
      totals.foreign_amount += Number(r.foreign_amount ?? 0)
    }
    await rpc(admin, 'platform_ad_account_record_sync', { p_id: account.id, p_status: 'OK', p_error: null, p_since: since, p_until: until })
    return { id: account.id, name: account.name, ok: true, since, until, ...totals, foreign_amount: totals.foreign_amount || null }
  } catch (error) {
    const status = error instanceof MetaApiError
      ? error.tokenInvalid ? 'TOKEN_INVALID' : error.rateLimited ? 'RATE_LIMITED' : error.noAccess ? 'NO_ACCESS' : 'FAILED'
      : 'FAILED'
    const message = explainMeta(error, account.ad_account_id)
    await rpc(admin, 'platform_ad_account_record_sync', { p_id: account.id, p_status: status, p_error: message, p_since: null, p_until: null })
    void logEvent({
      level: status === 'RATE_LIMITED' ? 'WARN' : 'ERROR', category: 'META', source: 'platform-ads',
      message: `Fullfilio ad spend sync failed for ${account.name}: ${message}`,
      context: { account: account.ad_account_id, status, since, until },
    })
    return { id: account.id, name: account.name, ok: false, status, error: message, since, until }
  }
}

/** Every active account (or one), each with its own credentials. */
export async function syncPlatformAdAccounts(admin: SupabaseClient, opts: { id?: string; days?: number; range?: { since: string; until: string } } = {}) {
  const accounts = await rpc<PlatformAdAccount[]>(admin, 'platform_ad_accounts_for_sync', { p_id: opts.id ?? null })
  const results: SpendSyncResult[] = []
  for (const account of accounts) {
    if (!account.is_active && !opts.id) continue
    const range = opts.range ?? spendWindow(opts.days ?? 3, account.timezone ?? 'Asia/Dhaka')
    results.push(await syncPlatformAdSpend(admin, account, await platformAdSecrets(admin, account.id), range))
  }
  return results
}

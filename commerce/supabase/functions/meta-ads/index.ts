// Meta Ads accounts and sync (staff with marketing.manage, or pg_cron):
//   test        check credentials against Meta without saving anything
//   save        add or edit an ad account; the access token and app secret go
//               to Vault (one entry per account), the rest to meta_ad_accounts;
//               a new active account gets a first sync of 30 days
//   disconnect  erase the account's secrets and stop syncing (numbers stay)
//   sync        campaigns, ad sets, ads and daily spend per ad and placement,
//               for one account or every active one
// Secrets never come back to a browser; only a masked hint is stored.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import {
  ACCOUNT_STATUS, type AdAccount, dateWindows, debugToken, fetchInsights, fetchStructure, getAdAccount, MetaApiError, MetaGraph,
  type TokenInfo,
} from '../_shared/meta/graph.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const token = z.string().trim().min(20).max(1000).regex(/^[A-Za-z0-9_|.-]+$/, 'That does not look like a Meta access token')
const appSecret = z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The App Secret is a 32-character code from App settings → Basic')
const appId = z.string().trim().regex(/^[0-9]{5,32}$/, 'The App ID is a number from App settings → Basic')
const adAccount = z.string().trim().regex(/^(act_)?[0-9]{3,32}$/, 'Enter the ad account ID (the number, without act_)')
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const credentials = {
  id: z.string().uuid().optional(),
  app_id: z.preprocess(blankToUndefined, appId.optional()),
  app_secret: z.preprocess(blankToUndefined, appSecret.optional()),
  access_token: z.preprocess(blankToUndefined, token.optional()),
  ad_account_id: adAccount,
}

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('test'), ...credentials }),
  z.object({
    action: z.literal('save'),
    ...credentials,
    name: z.string().trim().min(2, 'Give the account a name').max(80),
    usd_rate: z.number().positive('The rate must be more than 0').max(100000),
    payment_account_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().default(true),
  }),
  z.object({ action: z.literal('disconnect'), id: z.string().uuid() }),
  z.object({ action: z.literal('sync'), id: z.string().uuid().optional(), days: z.number().int().min(1).max(90).default(3) }),
])

interface Secrets { access_token?: string; app_secret?: string }
interface AccountRow {
  id: string
  name: string
  app_id: string | null
  ad_account_id: string
  is_active: boolean
  timezone: string | null
  connection_status: string
}

// Vault keys allow [a-z0-9_.] only.
const secretKey = (id: string) => `meta.ads.${id.replace(/-/g, '')}`
const hintFor = (t: string) => `••••${t.slice(-4)}`

async function storedSecrets(admin: SupabaseClient, id: string): Promise<Secrets> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: secretKey(id) })
  if (error) throw new Error(`Could not read the Meta credentials: ${error.message}`)
  return (data as Secrets | null) ?? {}
}

async function accountRow(admin: SupabaseClient, id: string): Promise<AccountRow> {
  const rows = await rpc<AccountRow[]>(admin, 'meta_accounts_for_sync', { p_id: id })
  if (!rows?.length) throw new HttpError(404, 'Meta account not found', 'NOT_FOUND')
  return rows[0]
}

/** Plain-language reason Meta refused, for the person filling in the form. */
function explain(error: unknown, adAccountId: string): string {
  if (error instanceof MetaApiError) {
    if (/appsecret_proof/i.test(error.message)) return 'The App Secret does not belong to the app that issued this token.'
    if (error.tokenInvalid) return 'The access token is not valid or has expired. Generate a new System User token.'
    if (error.noAccess) return `This token cannot read ad account ${adAccountId}. In Business Settings, give the system user access to it with ads_read.`
    if (error.rateLimited) return 'Meta asked us to slow down. Try again in a few minutes.'
  }
  return (error as Error).message
}

interface CheckResult {
  account: AdAccount
  token: TokenInfo | null
  warnings: string[]
}

/** Opens the ad account with the token (and app secret proof), then checks the token against the app. */
async function check(creds: Secrets, appIdValue: string | undefined, adAccountId: string): Promise<CheckResult> {
  if (!creds.access_token) throw new HttpError(422, 'Paste the access token', 'VALIDATION')
  const warnings: string[] = []
  let account: AdAccount
  let tokenInfo: TokenInfo | null = null
  try {
    account = await getAdAccount(new MetaGraph(creds.access_token, { appSecret: creds.app_secret ?? '' }), adAccountId)
    if (appIdValue && creds.app_secret) {
      tokenInfo = await debugToken(creds.access_token, appIdValue, creds.app_secret)
    }
  } catch (error) {
    throw new HttpError(422, explain(error, adAccountId), 'META_REJECTED')
  }
  if (tokenInfo) {
    if (!tokenInfo.valid) throw new HttpError(422, 'Meta says this access token is not valid.', 'META_REJECTED')
    if (tokenInfo.appId && appIdValue && tokenInfo.appId !== appIdValue) {
      throw new HttpError(422, `This token was issued by app ${tokenInfo.appId}, not ${appIdValue}. Check the App ID.`, 'META_REJECTED')
    }
    if (tokenInfo.scopes.length && !tokenInfo.scopes.includes('ads_read') && !tokenInfo.scopes.includes('ads_management')) {
      warnings.push('The token has no ads_read permission; spend may not sync.')
    }
    if (tokenInfo.expiresAt && new Date(tokenInfo.expiresAt).getTime() - Date.now() < 14 * 86_400_000) {
      warnings.push(`The token expires on ${tokenInfo.expiresAt.slice(0, 10)}. A System User token that never expires is better.`)
    }
  } else if (!creds.app_secret) {
    warnings.push('Without the App Secret, calls are not signed with appsecret_proof.')
  }
  if (account.status != null && account.status !== 1) {
    warnings.push(`Meta shows this ad account as ${ACCOUNT_STATUS[account.status] ?? `status ${account.status}`}.`)
  }
  return { account, token: tokenInfo, warnings }
}

/** Store date (Asia/Dhaka by default) for "today" and n-1 days before. */
function syncWindow(days: number, timeZone = 'Asia/Dhaka') {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const until = fmt(new Date())
  const since = fmt(new Date(Date.now() - (days - 1) * 86_400_000))
  return { since, until }
}

async function runSync(admin: SupabaseClient, account: AccountRow, creds: Secrets, days: number) {
  const { since, until } = syncWindow(days, account.timezone ?? 'Asia/Dhaka')
  const totals = { campaigns: 0, adsets: 0, ads: 0, insights: 0, cost: 0, payments: 0 }
  try {
    if (!creds.access_token) throw new MetaApiError('The access token is missing. Edit the account and paste it again.', 190)
    const graph = new MetaGraph(creds.access_token, { appSecret: creds.app_secret ?? '' })
    const structure = await fetchStructure(graph, account.ad_account_id)
    for (const [i, w] of dateWindows(since, until, 7).entries()) {
      const insights = await fetchInsights(graph, account.ad_account_id, w.since, w.until)
      const result = await rpc<Record<string, number>>(admin, 'meta_ads_apply_sync', {
        p: { account_id: account.ad_account_id, since: w.since, until: w.until, complete: true, insights, ...(i === 0 ? structure : {}) },
      })
      totals.campaigns += result.campaigns ?? 0
      totals.adsets += result.adsets ?? 0
      totals.ads += result.ads ?? 0
      totals.insights += result.insights ?? 0
      totals.cost += Number(result.cost ?? 0)
      totals.payments += result.payments ?? 0
    }
    await rpc(admin, 'meta_account_record_sync', { p_id: account.id, p_status: 'OK', p_error: null, p_since: since, p_until: until })
    return { id: account.id, name: account.name, ok: true, since, until, ...totals }
  } catch (error) {
    const status = error instanceof MetaApiError
      ? error.tokenInvalid ? 'TOKEN_INVALID' : error.rateLimited ? 'RATE_LIMITED' : error.noAccess ? 'NO_ACCESS' : 'FAILED'
      : 'FAILED'
    const message = (error as Error).message
    await rpc(admin, 'meta_account_record_sync', { p_id: account.id, p_status: status, p_error: message, p_since: since, p_until: until })
    void logEvent({
      level: status === 'RATE_LIMITED' ? 'WARN' : 'ERROR', category: 'META', source: 'meta-ads',
      message: status === 'TOKEN_INVALID' ? `Meta token for ${account.name} no longer works: ${message}` : `Meta Ads sync failed for ${account.name}: ${message}`,
      context: { account: account.ad_account_id, status, since, until, code: error instanceof MetaApiError ? error.code : null },
    })
    return { id: account.id, name: account.name, ok: false, status, error: message, since, until }
  }
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const input = parse(schema, await readJson(req))
    const admin = adminClient()
    const cron = input.action === 'sync' && await isCronRequest(req, admin)
    const staff = cron ? null : await requireStaff(req, 'marketing.manage')

    switch (input.action) {
      case 'test': {
        // Fields left empty when editing fall back to what is saved.
        const saved = input.id ? await storedSecrets(admin, input.id) : {}
        const result = await check({ access_token: input.access_token ?? saved.access_token, app_secret: input.app_secret ?? saved.app_secret },
          input.app_id, input.ad_account_id)
        return json(req, { ok: true, account: result.account, token: result.token, warnings: result.warnings })
      }
      case 'save': {
        const saved = input.id ? await storedSecrets(admin, input.id) : {}
        const creds: Secrets = { access_token: input.access_token ?? saved.access_token, app_secret: input.app_secret ?? saved.app_secret }
        if (!input.id && !creds.access_token) throw new HttpError(422, 'Paste the access token', 'VALIDATION')
        // Active accounts must connect; a paused one can be saved as it is.
        let result: CheckResult | null = null
        let failure: string | null = null
        if (input.is_active) {
          result = await check(creds, input.app_id, input.ad_account_id)
        } else if (creds.access_token) {
          result = await check(creds, input.app_id, input.ad_account_id).catch((e) => { failure = (e as Error).message; return null })
        }
        const row = await rpc<AccountRow>(admin, 'meta_account_save', {
          p: {
            id: input.id ?? null, name: input.name, app_id: input.app_id ?? null, ad_account_id: input.ad_account_id,
            usd_rate: input.usd_rate, payment_account_id: input.payment_account_id ?? null, is_active: input.is_active,
            meta: result
              ? {
                name: result.account.name, currency: result.account.currency, timezone: result.account.timezone,
                token_hint: creds.access_token ? hintFor(creds.access_token) : null, has_app_secret: !!creds.app_secret,
                token_expires_at: result.token?.expiresAt ?? null, status: 'OK', error: null,
              }
              : failure ? { status: 'FAILED', error: failure, has_app_secret: !!creds.app_secret } : undefined,
          },
          p_actor: staff!.user.id,
        })
        if (input.access_token || input.app_secret) {
          try {
            await rpc(admin, 'integration_secret_store', {
              p_key: secretKey(row.id), p_value: creds, p_hint: creds.access_token ? hintFor(creds.access_token) : null, p_actor: staff!.user.id,
            })
          } catch (error) {
            // Never leave an account active without its credentials.
            if (!input.id) await rpc(admin, 'meta_account_disconnect', { p_id: row.id, p_actor: staff!.user.id })
            throw error
          }
        }
        // First sync for a new account: the last 30 days.
        const sync = !input.id && row.is_active ? await runSync(admin, row, creds, 30) : null
        return json(req, { ok: true, account: row, warnings: result?.warnings ?? [], sync })
      }
      case 'disconnect': {
        await accountRow(admin, input.id)
        await rpc(admin, 'integration_secret_clear', { p_key: secretKey(input.id), p_actor: staff!.user.id })
        await rpc(admin, 'meta_account_disconnect', { p_id: input.id, p_actor: staff!.user.id })
        return json(req, { ok: true })
      }
      case 'sync': {
        const accounts = await rpc<AccountRow[]>(admin, 'meta_accounts_for_sync', { p_id: input.id ?? null })
        if (!accounts.length) {
          if (cron) return json(req, { ok: true, skipped: 'no active Meta accounts' })
          throw new HttpError(422, 'Add a Meta Ads account first', 'NOT_CONNECTED')
        }
        const results = []
        for (const account of accounts) {
          results.push(await runSync(admin, account, await storedSecrets(admin, account.id), input.days))
        }
        const failed = results.filter((r) => !r.ok)
        if (!cron && input.id && failed.length) throw new HttpError(502, failed[0].error ?? 'Meta Ads sync failed', failed[0].status ?? 'FAILED')
        return json(req, {
          ok: failed.length === 0, accounts: results,
          insights: results.reduce((s, r) => s + ('insights' in r ? r.insights : 0), 0),
          cost: results.reduce((s, r) => s + ('cost' in r ? r.cost : 0), 0),
        })
      }
    }
  }),
)

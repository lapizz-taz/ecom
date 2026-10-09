// Meta Ads connection and sync (staff with marketing.manage, or pg_cron):
//   accounts    list the ad accounts and pages a token can see (nothing saved)
//   connect     test the token on the chosen ad account, keep it in Vault, first sync
//   disconnect  erase the token (synced numbers stay)
//   sync        campaigns, ad sets, ads and daily spend per ad and placement
// The token never comes back to a browser; only a masked hint is stored.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import {
  dateWindows, fetchInsights, fetchStructure, getAdAccount, listAdAccounts, listPages, MetaApiError, MetaGraph,
} from '../_shared/meta/graph.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const SECRET_KEY = 'meta.ads'
const token = z.string().trim().min(20).max(1000).regex(/^[A-Za-z0-9_|.-]+$/, 'That does not look like a Meta access token')

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accounts'), access_token: token.optional() }),
  z.object({
    action: z.literal('connect'),
    access_token: token.optional(),
    ad_account_id: z.string().trim().regex(/^(act_)?[0-9]{3,32}$/, 'Choose an ad account'),
    page_id: z.string().regex(/^[0-9]{1,32}$/).optional().nullable(),
    instagram_id: z.string().regex(/^[0-9]{1,32}$/).optional().nullable(),
  }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('sync'), days: z.number().int().min(1).max(90).default(3) }),
])

interface MetaConfig { connected?: boolean; ad_account_id?: string | null; account_timezone?: string | null }

const hintFor = (t: string) => `••••${t.slice(-4)}`

async function storedToken(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: SECRET_KEY })
  if (error) throw new Error(`Could not read the Meta token: ${error.message}`)
  return (data as { access_token?: string } | null)?.access_token ?? null
}

/** Store date (Asia/Dhaka by default) for "today" and n-1 days before. */
function syncWindow(days: number, timeZone = 'Asia/Dhaka') {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const until = fmt(new Date())
  const since = fmt(new Date(Date.now() - (days - 1) * 86_400_000))
  return { since, until }
}

async function runSync(admin: SupabaseClient, config: MetaConfig, accessToken: string, days: number) {
  const graph = new MetaGraph(accessToken)
  const { since, until } = syncWindow(days, config.account_timezone ?? 'Asia/Dhaka')
  const totals = { campaigns: 0, adsets: 0, ads: 0, insights: 0, cost: 0 }
  try {
    const structure = await fetchStructure(graph, config.ad_account_id!)
    const windows = dateWindows(since, until, 7)
    for (const [i, w] of windows.entries()) {
      const insights = await fetchInsights(graph, config.ad_account_id!, w.since, w.until)
      const result = await rpc<Record<string, number>>(admin, 'meta_ads_apply_sync', {
        p: {
          account_id: config.ad_account_id, since: w.since, until: w.until, complete: true, insights,
          ...(i === 0 ? structure : {}),
        },
      })
      totals.campaigns += result.campaigns ?? 0
      totals.adsets += result.adsets ?? 0
      totals.ads += result.ads ?? 0
      totals.insights += result.insights ?? 0
      totals.cost += Number(result.cost ?? 0)
    }
    await rpc(admin, 'meta_ads_record_sync', { p_status: 'OK', p_error: null, p_since: since, p_until: until })
    return { ok: true, since, until, ...totals }
  } catch (error) {
    const status = error instanceof MetaApiError
      ? error.tokenInvalid ? 'TOKEN_INVALID' : error.rateLimited ? 'RATE_LIMITED' : error.noAccess ? 'NO_ACCESS' : 'FAILED'
      : 'FAILED'
    const message = (error as Error).message
    await rpc(admin, 'meta_ads_record_sync', { p_status: status, p_error: message, p_since: since, p_until: until })
    void logEvent({
      level: status === 'RATE_LIMITED' ? 'WARN' : 'ERROR', category: 'META', source: 'meta-ads',
      message: status === 'TOKEN_INVALID' ? `Meta token no longer works; reconnect Meta Ads: ${message}` : `Meta Ads sync failed: ${message}`,
      context: { status, since, until, code: error instanceof MetaApiError ? error.code : null },
    })
    return { ok: false, status, error: message, since, until }
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
      case 'accounts': {
        const accessToken = input.access_token ?? await storedToken(admin)
        if (!accessToken) throw new HttpError(422, 'Paste an access token', 'VALIDATION')
        const graph = new MetaGraph(accessToken)
        try {
          const [accounts, pages] = [await listAdAccounts(graph), await listPages(graph)]
          if (!accounts.length) throw new HttpError(422, 'This token cannot see any ad account. Give it ads_read access to your ad account.', 'NO_ACCOUNTS')
          return json(req, { accounts, pages })
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(422, (error as Error).message, 'META_REJECTED')
        }
      }
      case 'connect': {
        const accessToken = input.access_token ?? await storedToken(admin)
        if (!accessToken) throw new HttpError(422, 'Paste an access token', 'VALIDATION')
        const graph = new MetaGraph(accessToken)
        let account
        let pages
        try {
          account = await getAdAccount(graph, input.ad_account_id)
          pages = input.page_id || input.instagram_id ? await listPages(graph) : []
        } catch (error) {
          throw new HttpError(422, `Could not open this ad account: ${(error as Error).message}`, 'META_REJECTED')
        }
        const page = pages.find((p) => p.id === input.page_id) ?? null
        const ig = pages.find((p) => p.instagram?.id === input.instagram_id)?.instagram ?? null
        await rpc(admin, 'integration_secret_store', {
          p_key: SECRET_KEY, p_value: { access_token: accessToken }, p_hint: hintFor(accessToken), p_actor: staff!.user.id,
        })
        const settings = await rpc<MetaConfig>(admin, 'meta_ads_set_connection', {
          p: {
            ad_account_id: account.id, ad_account_name: account.name, account_currency: account.currency,
            account_timezone: account.timezone, page_id: page?.id ?? null, page_name: page?.name ?? null,
            instagram_id: ig?.id ?? null, instagram_username: ig?.username ?? null, hint: hintFor(accessToken),
          },
          p_actor: staff!.user.id,
        })
        // First sync: the last 30 days.
        const sync = await runSync(admin, settings, accessToken, 30)
        return json(req, { ok: true, account, sync })
      }
      case 'disconnect': {
        await rpc(admin, 'integration_secret_clear', { p_key: SECRET_KEY, p_actor: staff!.user.id })
        await rpc(admin, 'meta_ads_set_connection', { p: null, p_actor: staff!.user.id })
        return json(req, { ok: true })
      }
      case 'sync': {
        const config = await rpc<MetaConfig>(admin, 'meta_ads_config')
        if (!config.connected || !config.ad_account_id) {
          if (cron) return json(req, { ok: true, skipped: 'not connected' })
          throw new HttpError(422, 'Connect Meta Ads first', 'NOT_CONNECTED')
        }
        const accessToken = await storedToken(admin)
        if (!accessToken) throw new HttpError(422, 'The Meta token is missing. Connect Meta Ads again.', 'NOT_CONNECTED')
        const result = await runSync(admin, config, accessToken, input.days)
        if (!result.ok && !cron) throw new HttpError(502, result.error ?? 'Meta Ads sync failed', result.status ?? 'FAILED')
        return json(req, result)
      }
    }
  }),
)

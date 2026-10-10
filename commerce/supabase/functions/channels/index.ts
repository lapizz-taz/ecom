// Sales channels: Shopify and WooCommerce stores whose orders come here.
//   POST shopify_client    {shop, client_id, client_secret}  Dev Dashboard app, client credentials (no redirect)
//   POST shopify_connect   {shop, client_id, client_secret?, return_to} → Shopify's approval screen
//   GET  /channels/callback/shopify          Shopify sends staff back: code → token (Vault). Reached through
//                                            <app domain>/oauth/shopify/callback so its host matches the app URL.
//   POST shopify_token     {shop, access_token, api_secret}   custom-app token instead of OAuth
//   POST woo_connect       {url, return_to} → the store's own WooCommerce approval screen
//   POST /channels/callback/woocommerce      WooCommerce posts the approved API keys here
//   POST woo_keys          {url, consumer_key, consumer_secret}   keys made by hand
//   POST test | webhooks | sync | disconnect {channel_id}
//   POST retry_import      {import_id, overrides}   staff fixed a failed import
//   POST /channels/webhook/<channel_id>      orders, fulfilments, stock from the store (signature checked)
//   POST process_jobs      run due sync jobs (cron every minute, or staff after shipping)
//   POST import_catalog    {channel_id} the store's locations + variants + quantities (to link, compare and import products)
//   POST order_action      {order_id, op: mark_paid | cancel}  staff click only: mark paid / cancel the order on Shopify
//   POST reconnect         {channel_id}  connect again with the saved app keys (after the app was reinstalled)
// Every connection ends with a test, so staff see straight away whether orders
// will come through. Tokens and keys never reach a browser.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { type Check, ChannelError, type NormalizedOrder } from '../_shared/channels/common.ts'
import {
  exchangeShopifyCode, restTouch, seenFromWebhook, ShopifyClient, SHOPIFY_SCOPES, shopifyClientToken, shopDomain, shopifyAuthUrl, verifyShopifyCallback, verifyShopifyWebhook,
  visitExtras,
} from '../_shared/channels/shopify.ts'
import { touchFrom } from '../_shared/channels/common.ts'
import { fulfillJob, inventoryJob, type Job, type Outcome, wooFulfillJob } from '../_shared/channels/sync.ts'
import {
  normalizeWooOrder, siteUrl, verifyWooWebhook, WOO_CANCEL_STATUSES, WOO_IMPORT_STATUSES, WOO_LOCATION, WooClient, wooAuthUrl, type WooOrder, wooStockFromWebhook,
} from '../_shared/channels/woocommerce.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'
import { env, requireEnv } from '../_shared/env.ts'
import { FraudDetectionService, type FraudSettings, loadFraudProviders } from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, getSettings, requireStaff, rpc } from '../_shared/supabase.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined
const background = (task: Promise<unknown>) => { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task) }

interface Channel {
  id: string; platform: 'SHOPIFY' | 'WOOCOMMERCE'; name: string; shop_domain: string; status: string; auth_mode: string | null
  webhooks: Array<{ id: string | number; topic: string }>; settings: Record<string, unknown>
  catalog_imported_at?: string | null; first_sync_at?: string | null
}
interface Secret {
  mode?: 'OAUTH' | 'CLIENT' | 'TOKEN' | 'KEYS'; client_id?: string; client_secret?: string; access_token?: string; api_secret?: string
  /** Client-credentials tokens last 24 hours. */
  expires_at?: string
  consumer_key?: string; consumer_secret?: string; webhook_secret?: string
}
interface IngestResult { status: 'IMPORTED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED'; order_id?: string; order_number?: string; phone?: string; total?: number; error?: string; import_id?: string }

const returnTo = z.string().url().max(500)
const channelId = z.string().uuid()
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('shopify_client'), shop: z.string().trim().min(3).max(200), client_id: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The Client ID is a 32-character code from the app\'s settings'), client_secret: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('shopify_connect'), shop: z.string().trim().min(3).max(200), client_id: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The Client ID is a 32-character code from the app\'s settings'), client_secret: z.string().trim().max(200).optional(), return_to: returnTo,
    scopes: z.array(z.enum(SHOPIFY_SCOPES as [string, ...string[]])).max(30).optional() }),
  z.object({ action: z.literal('shopify_token'), shop: z.string().trim().min(3).max(200), access_token: z.string().trim().regex(/^shp[a-z]{2}_[A-Za-z0-9]{20,64}$/, 'The Admin API access token starts with shpat_'), api_secret: z.string().trim().min(16, 'Enter the app\'s API secret key').max(200) }),
  z.object({ action: z.literal('woo_connect'), url: z.string().trim().min(4).max(300), return_to: returnTo }),
  z.object({ action: z.literal('woo_keys'), url: z.string().trim().min(4).max(300), consumer_key: z.string().trim().regex(/^ck_[a-f0-9]{40}$/, 'The consumer key starts with ck_'), consumer_secret: z.string().trim().regex(/^cs_[a-f0-9]{40}$/, 'The consumer secret starts with cs_') }),
  z.object({ action: z.literal('test'), channel_id: channelId }),
  z.object({ action: z.literal('webhooks'), channel_id: channelId }),
  z.object({ action: z.literal('disconnect'), channel_id: channelId }),
  z.object({ action: z.literal('sync'), channel_id: channelId.optional(), days: z.number().int().min(1).max(60).default(3) }),
  z.object({ action: z.literal('process_jobs'), limit: z.number().int().min(1).max(50).default(20) }),
  z.object({ action: z.literal('import_catalog'), channel_id: channelId }),
  z.object({ action: z.literal('order_action'), order_id: z.string().uuid(), op: z.enum(['mark_paid', 'cancel']), note: z.string().trim().max(255).optional() }),
  z.object({ action: z.literal('reconnect'), channel_id: channelId }),
  z.object({ action: z.literal('retry_import'), import_id: z.string().uuid(), overrides: z.object({
    phone: z.string().trim().max(20).optional(), name: z.string().trim().max(120).optional(),
    address: z.string().trim().max(300).optional(), district: z.string().trim().max(60).optional(),
  }).default({}) }),
])

const publicBase = () => (env('PUBLIC_SUPABASE_URL') ?? requireEnv('SUPABASE_URL')).replace(/\/+$/, '')
const fnBase = () => `${publicBase()}/functions/v1/channels`
/**
 * Shopify requires the redirect URL to be on the same host as the app URL, so
 * Shopify sends staff back to the admin's own domain, which forwards to this
 * function (vercel.json rewrite /oauth/shopify/callback).
 */
export const shopifyRedirectUri = (returnTo?: string) => {
  try {
    if (returnTo) return `${new URL(returnTo).origin}/oauth/shopify/callback`
  } catch { /* fall through */ }
  return `${fnBase()}/callback/shopify`
}
const webhookUrl = (id: string) => `${fnBase()}/webhook/${id}`
const secretKey = (id: string) => `channels.${id.replace(/-/g, '')}`
const hint = (v: string) => `••••${v.slice(-4)}`
const randomHex = (n = 32) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')
const appName = () => env('CHANNEL_APP_NAME') ?? 'Order Management'

async function secretOf(admin: SupabaseClient, id: string): Promise<Secret> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: secretKey(id) })
  if (error) throw new Error(`Could not read stored credentials: ${error.message}`)
  return (data ?? {}) as Secret
}
const storeSecret = (admin: SupabaseClient, id: string, value: Secret, actor: string | null, h: string) =>
  rpc(admin, 'integration_secret_store', { p_key: secretKey(id), p_value: value, p_hint: h, p_actor: actor })

/** Stored credentials, with a client-credentials token fetched again shortly before it expires. */
async function credsOf(admin: SupabaseClient, c: Channel, force = false): Promise<Secret> {
  const s = await secretOf(admin, c.id)
  if (c.platform !== 'SHOPIFY' || s.mode !== 'CLIENT' || !s.client_id || !s.client_secret) return s
  if (!force && s.access_token && s.expires_at && Date.parse(s.expires_at) > Date.now() + 10 * 60_000) return s
  const t = await shopifyClientToken(c.shop_domain, s.client_id, s.client_secret)
  const next = { ...s, access_token: t.accessToken, expires_at: t.expiresAt }
  await storeSecret(admin, c.id, next, null, `App ${hint(s.client_id)}`)
  if (t.scopes.length) await rpc(admin, 'channel_update', { p_id: c.id, p: { scopes: t.scopes } })
  return next
}

async function channelOf(admin: SupabaseClient, id: string): Promise<Channel> {
  const c = await rpc<Channel | null>(admin, 'channel_get', { p_id: id })
  if (!c?.id) throw new HttpError(404, 'Sales channel not found', 'NOT_FOUND')
  return c
}

function shopifyClient(c: Channel, s: Secret) {
  if (!s.access_token) throw new ChannelError('Shopify is not authorised yet. Click Connect.', 401, 'NOT_AUTHORISED')
  return new ShopifyClient(c.shop_domain, s.access_token)
}
function wooClient(c: Channel, s: Secret) {
  if (!s.consumer_key || !s.consumer_secret) throw new ChannelError('WooCommerce is not authorised yet. Click Connect.', 401, 'NOT_AUTHORISED')
  return new WooClient(c.shop_domain, s.consumer_key, s.consumer_secret)
}

/** Webhooks + the connection test; the channel ends CONNECTED only when nothing failed. */
async function finishSetup(admin: SupabaseClient, c: Channel, actor: string | null, registerHooks = true) {
  let s: Secret
  try {
    s = await credsOf(admin, c)
  } catch (error) {
    const checks: Check[] = [{ key: 'store', label: 'Store reachable', status: 'fail', detail: (error as Error).message }]
    const channel = await rpc<Channel>(admin, 'channel_update', {
      p_id: c.id, p_actor: actor, p: { last_test: { checks, at: new Date().toISOString() }, status: 'ERROR', last_error: (error as Error).message },
    })
    return { channel, checks, ok: false }
  }
  let hooks: Array<{ id: string | number; topic: string }> = c.webhooks ?? []
  let hookError: string | null = null
  if (registerHooks) {
    try {
      hooks = c.platform === 'SHOPIFY'
        ? await shopifyClient(c, s).ensureWebhooks(webhookUrl(c.id))
        : await wooClient(c, s).ensureWebhooks(webhookUrl(c.id), s.webhook_secret!)
    } catch (error) {
      hookError = (error as Error).message
    }
  }
  let checks: Check[]
  let patch: Record<string, unknown> = {}
  try {
    if (c.platform === 'SHOPIFY') {
      const t = await shopifyClient(c, s).test(webhookUrl(c.id), hooks.map((h) => String(h.id)))
      checks = t.checks
      patch = { name: t.name, currency: t.currency, scopes: t.scopes }
    } else {
      const t = await wooClient(c, s).test(webhookUrl(c.id))
      checks = t.checks
      patch = { currency: t.currency, name: c.name === c.shop_domain ? t.name : undefined }
    }
  } catch (error) {
    checks = [{ key: 'store', label: 'Store reachable', status: 'fail', detail: (error as Error).message }]
  }
  if (hookError && !checks.some((x) => x.key === 'webhooks' && x.status === 'fail')) {
    checks.push({ key: 'webhooks', label: 'Instant order updates', status: 'fail', detail: hookError })
  }
  const failed = checks.find((x) => x.status === 'fail')
  const channel = await rpc<Channel>(admin, 'channel_update', {
    p_id: c.id, p_actor: actor,
    p: { ...patch, webhooks: hooks, last_test: { checks, at: new Date().toISOString() }, status: failed ? 'ERROR' : 'CONNECTED', last_error: failed ? `${failed.label}: ${failed.detail}` : '' },
  })
  return { channel, checks, ok: !failed }
}

// --- importing ---------------------------------------------------------------------

async function fraudCheckFor(admin: SupabaseClient, phone: string, orderValue: number): Promise<string | null> {
  const settings = await getSettings<FraudSettings>(admin, 'fraud')
  if (settings.enabled === false) return null
  const cached = await rpc<{ id: string | null } | null>(admin, 'recent_fraud_check', { p_phone: phone })
  if (cached?.id) return cached.id
  const payload = await new FraudDetectionService(await loadFraudProviders(admin, settings)).check({ phone, orderValue }, { context: { source: 'sales_channel' } })
  return (await rpc<{ id: string | null }>(admin, 'record_fraud_check', { p_input: payload })).id
}

/** After an order lands: courier-history check for the success rate, and queued messages. */
function afterImport(admin: SupabaseClient, r: IngestResult) {
  if (r.status !== 'IMPORTED' || !r.order_id) return
  background((async () => {
    try {
      const id = r.phone ? await fraudCheckFor(admin, r.phone, Number(r.total ?? 0)) : null
      if (id) await rpc(admin, 'channel_attach_fraud_check', { p_order_id: r.order_id, p_check_id: id })
    } catch (error) {
      void logEvent({ level: 'WARN', category: 'FRAUD', source: 'channels', message: `Courier check after import failed for ${r.order_number}`, error })
    }
  })())
  dispatchNotificationsInBackground()
}

async function ingest(admin: SupabaseClient, c: Channel, order: NormalizedOrder, via: 'WEBHOOK' | 'SYNC' | 'RETRY'): Promise<IngestResult> {
  const r = await rpc<IngestResult>(admin, 'channel_ingest_order', { p_channel_id: c.id, p_order: order, p_via: via })
  if (r.status === 'FAILED') {
    void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: order ${order.number ?? order.external_id} not imported — ${r.error}`, context: { channel: c.id, external_id: order.external_id } })
  }
  afterImport(admin, r)
  return r
}

/** Pull recent orders (also catches anything a webhook missed). */
async function syncChannel(admin: SupabaseClient, c: Channel, days: number): Promise<{ id: string; name: string; ok: boolean; error?: string; found: number; imported: number; duplicate: number; failed: number; skipped: number }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const counts = { found: 0, imported: 0, duplicate: 0, failed: 0, skipped: 0 }
  let failure: ChannelError | null = null
  try {
    const s = await credsOf(admin, c)
    if (c.platform === 'SHOPIFY') {
      for (const o of await shopifyClient(c, s).ordersSince(since)) {
        counts.found++
        const r = await ingest(admin, c, o, 'SYNC')
        bump(counts, r.status)
        // Catch fulfilments a webhook missed (e.g. made by hand in Shopify).
        if (o.fulfillments?.length) {
          await rpc(admin, 'channel_fulfillments_seen', { p_channel_id: c.id, p_external_order_id: o.external_id, p_fulfillments: o.fulfillments })
        }
      }
    } else {
      for (const raw of await wooClient(c, s).ordersSince(since)) {
        if (!WOO_IMPORT_STATUSES.includes(raw.status)) continue
        counts.found++
        const r = await ingest(admin, c, normalizeWooOrder(raw), 'SYNC')
        bump(counts, r.status)
      }
    }
  } catch (error) {
    failure = error as ChannelError
  }
  // Products and stock do not depend on orders: a problem reading orders
  // (e.g. customer data not approved yet) must not stop the catalog.
  if (!failure?.unauthorized) await refreshCatalog(admin, c)
  if (!failure) {
    await rpc(admin, 'channel_update', { p_id: c.id, p: { synced: true, ...(c.status === 'ERROR' ? {} : { last_error: '' }) } })
    return { id: c.id, name: c.name, ok: true, ...counts }
  }
  await rpc(admin, 'channel_update', { p_id: c.id, p: { last_error: `Sync: ${failure.message}`, ...(failure.unauthorized ? { status: 'ERROR' } : {}) } })
  void logEvent({ level: 'ERROR', category: 'JOB', source: 'channels', message: `${c.name}: sync failed — ${failure.message}`, context: { channel: c.id } })
  return { id: c.id, name: c.name, ok: false, error: failure.message, ...counts }
}
function bump(c: { imported: number; duplicate: number; failed: number; skipped: number }, status: IngestResult['status']) {
  if (status === 'IMPORTED') c.imported++
  else if (status === 'DUPLICATE') c.duplicate++
  else if (status === 'FAILED') c.failed++
  else c.skipped++
}

// --- store sync jobs -------------------------------------------------------------------

/**
 * Keeps the store's catalog fresh: right after connecting (so products and
 * locations are there for the first sync), and every hour once stock sync or
 * the first sync is on (new products come in, store numbers are compared).
 */
async function refreshCatalog(admin: SupabaseClient, c: Channel) {
  if (!(c.settings?.inventory_sync === true || c.first_sync_at || !c.catalog_imported_at)) return
  await importCatalog(admin, c).catch((e) => {
    void logEvent({ level: 'WARN', category: 'JOB', source: 'channels', message: `${c.name}: catalog refresh failed — ${(e as Error).message}`, context: { channel: c.id } })
  })
}

/**
 * Where the order came from: Shopify's journey with its own UTM fields and
 * marketing event when ready; else the landing / referring site of the order.
 */
async function journeyOf(client: ShopifyClient, orderId: string, current: NormalizedOrder['attribution'], rest: Record<string, unknown>) {
  const j = await client.orderJourney(orderId)
  const touch = (v: Parameters<typeof visitExtras>[0] | null) => v ? touchFrom(v.landingPage, v.referrerUrl, v.occurredAt, visitExtras(v)) : null
  const first = touch(j?.first ?? null)
  const last = touch(j?.last ?? null)
  if (first || last) return { first_touch: first ?? last, last_touch: last ?? first }
  return current ?? restTouch(rest as { landing_site?: string; referring_site?: string; created_at?: string })
}

/** One product changed in the store (webhook): refresh it, import it if new (after the first sync). */
async function productChanged(admin: SupabaseClient, c: Channel, s: Secret, productId: string, deleted: boolean) {
  const items = deleted ? [] : c.platform === 'SHOPIFY' ? await shopifyClient(c, s).product(productId) : await wooClient(c, s).product(productId)
  return rpc(admin, 'channel_catalog_product_upsert', { p_channel_id: c.id, p_product_id: productId, p_items: items })
}

async function importCatalog(admin: SupabaseClient, c: Channel) {
  const s = await credsOf(admin, c)
  const [locations, items] = c.platform === 'SHOPIFY'
    ? await Promise.all([shopifyClient(c, s).locations(), shopifyClient(c, s).catalog()])
    : [[WOO_LOCATION], await wooClient(c, s).catalog()]
  return rpc<{ items: number; linked: number; mapped: number }>(admin, 'channel_catalog_import', { p_channel_id: c.id, p_items: items, p_locations: locations })
}

/** Runs due jobs one by one; each one's outcome is stored (retry with back-off, or failed for a person). */
async function processJobs(admin: SupabaseClient, limit: number) {
  const jobs = await rpc<Job[]>(admin, 'channel_jobs_claim', { p_limit: limit })
  const channels = new Map<string, Channel>()
  const secrets = new Map<string, Secret>()
  const call = <T>(fn: string, args: Record<string, unknown>) => rpc<T>(admin, fn, args)
  const results: Array<{ id: string; kind: string; outcome: string; error?: string }> = []
  for (const job of jobs) {
    let out: Outcome
    try {
      if (!channels.has(job.channel_id)) channels.set(job.channel_id, await channelOf(admin, job.channel_id))
      const c = channels.get(job.channel_id)!
      if (c.status === 'DISCONNECTED') {
        out = { outcome: 'FAILED', error: 'The store is disconnected' }
      } else {
        if (!secrets.has(c.id)) secrets.set(c.id, await credsOf(admin, c))
        const opts = { notify_customer: c.settings?.notify_customer !== false, fulfill_without_tracking: c.settings?.fulfill_without_tracking === true }
        if (c.platform === 'SHOPIFY') {
          const client = () => shopifyClient(c, secrets.get(c.id)!)
          out = job.kind === 'FULFILL' ? await fulfillJob(job, call, client, opts) : await inventoryJob(job, call, client)
        } else {
          const client = () => wooClient(c, secrets.get(c.id)!)
          out = job.kind === 'FULFILL' ? await wooFulfillJob(job, call, client, opts) : await inventoryJob(job, call, client, Date.now(), 'WooCommerce')
        }
      }
    } catch (error) {
      out = { outcome: 'RETRY', error: (error as Error).message }
    }
    await rpc(admin, 'channel_job_finish', { p_id: job.id, p_outcome: out.outcome, p_error: out.error ?? null, p_result: out.result ?? null, p_delay_seconds: out.delay ?? null })
    if (out.outcome === 'FAILED') {
      void logEvent({ level: 'WARN', category: 'JOB', source: 'channels', message: `${job.kind} job failed: ${out.error}`, context: { job: job.id, channel: job.channel_id } })
    }
    results.push({ id: job.id, kind: job.kind, outcome: out.outcome, error: out.error })
  }
  return { processed: results.length, results }
}

// --- browser-facing pages -------------------------------------------------------------

const page = (title: string, body: string, status = 400) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })

function back(to: string, params: Record<string, string>): Response {
  const url = new URL(to)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } })
}

async function shopifyCallback(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const admin = adminClient()
  const state = url.searchParams.get('state') ?? ''
  const taken = state ? await rpc<{ channel_id: string; created_by: string; return_to: string } | null>(admin, 'channel_oauth_state_take', { p_state: state }) : null
  if (!taken) return page('This link has expired', 'Go back to Sales channels and click Connect again.')
  try {
    const c = await channelOf(admin, taken.channel_id)
    const s = await secretOf(admin, c.id)
    if (!s.client_id || !s.client_secret) throw new Error('The app details are missing; enter them again')
    if (!(await verifyShopifyCallback(url.searchParams, s.client_secret))) throw new Error('Shopify\'s signature did not match. Check the Client secret.')
    if (shopDomain(url.searchParams.get('shop') ?? '') !== c.shop_domain) throw new Error(`Approved for a different store (${url.searchParams.get('shop')})`)
    const code = url.searchParams.get('code')
    if (!code) throw new Error('Shopify did not send an authorisation code')
    const { accessToken, scopes } = await exchangeShopifyCode(c.shop_domain, s.client_id, s.client_secret, code)
    await storeSecret(admin, c.id, { ...s, mode: 'OAUTH', access_token: accessToken }, taken.created_by, `Shopify ${hint(accessToken)}`)
    await rpc(admin, 'channel_update', { p_id: c.id, p: { scopes } })
    const done = await finishSetup(admin, c, taken.created_by)
    background(syncChannel(admin, done.channel, 7))
    return back(taken.return_to, done.ok ? { connected: 'shopify', channel: c.id } : { channel: c.id, error: done.channel.status === 'ERROR' ? 'Connected, but the test found a problem' : 'Check the test' })
  } catch (error) {
    const message = (error as Error).message
    await rpc(admin, 'channel_update', { p_id: taken.channel_id, p: { status: 'ERROR', last_error: message } }).catch(() => undefined)
    void logEvent({ level: 'ERROR', category: 'AUTH', source: 'channels', message: `Shopify connect failed: ${message}`, error })
    return back(taken.return_to, { error: message.slice(0, 200), channel: taken.channel_id })
  }
}

/** WooCommerce posts the keys it created after the owner approved. */
async function wooCallback(req: Request): Promise<Response> {
  const admin = adminClient()
  const body = await readJson<{ key_id?: number; user_id?: string; consumer_key?: string; consumer_secret?: string; key_permissions?: string }>(req)
  const taken = body.user_id ? await rpc<{ channel_id: string; created_by: string } | null>(admin, 'channel_oauth_state_take', { p_state: String(body.user_id) }) : null
  if (!taken) throw new HttpError(400, 'Unknown or expired approval', 'INVALID_STATE')
  if (!body.consumer_key || !body.consumer_secret) throw new HttpError(400, 'Keys missing', 'VALIDATION')
  const c = await channelOf(admin, taken.channel_id)
  const old = await secretOf(admin, c.id)
  await storeSecret(admin, c.id, { mode: 'KEYS', consumer_key: body.consumer_key, consumer_secret: body.consumer_secret, webhook_secret: old.webhook_secret ?? randomHex() }, taken.created_by, `Woo ${hint(body.consumer_key)}`)
  const done = await finishSetup(admin, c, taken.created_by)
  if (body.key_permissions && body.key_permissions !== 'read_write') {
    await rpc(admin, 'channel_update', { p_id: c.id, p: { status: 'ERROR', last_error: `The keys are ${body.key_permissions}; Read/Write is needed for webhooks` } })
  }
  background(syncChannel(admin, done.channel, 7))
  return json(req, { ok: true })
}

// --- webhooks --------------------------------------------------------------------------

async function webhook(req: Request, id: string): Promise<Response> {
  const raw = await req.text()
  if (raw.length > 2_000_000) throw new HttpError(413, 'Too large', 'PAYLOAD_TOO_LARGE')
  const admin = adminClient()
  const c = await rpc<Channel | null>(admin, 'channel_get', { p_id: id })
  if (!c?.id || c.status === 'DISCONNECTED') return json(req, { ok: true, ignored: 'not connected' })
  let s = await secretOf(admin, c.id)

  if (c.platform === 'SHOPIFY') {
    // Apps (OAuth or client credentials) sign with the client secret; a custom-app token with its API secret.
    const signing = s.mode === 'TOKEN' ? s.api_secret : s.client_secret
    if (!signing || !(await verifyShopifyWebhook(raw, req.headers.get('x-shopify-hmac-sha256'), signing))) {
      void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: webhook with a bad signature rejected`, context: { channel: c.id } })
      throw new HttpError(401, 'Invalid signature', 'INVALID_SIGNATURE')
    }
    const topic = req.headers.get('x-shopify-topic') ?? ''
    // Shopify sends the same event again (retries, duplicates) with the same event id.
    const event = req.headers.get('x-shopify-event-id')
    const delivery = event ? `${topic}:${event}` : req.headers.get('x-shopify-webhook-id') ?? ''
    if (delivery && await rpc<boolean>(admin, 'channel_delivery_seen', { p_channel_id: c.id, p_delivery_id: delivery })) return json(req, { ok: true, duplicate: true })
    const body = JSON.parse(raw || '{}') as { id?: number; admin_graphql_api_id?: string; cancel_reason?: string }
    let result: unknown = null
    if ((topic === 'products/create' || topic === 'products/update' || topic === 'products/delete') && body.id) {
      s = await credsOf(admin, c)
      result = await productChanged(admin, c, s, String(body.id), topic === 'products/delete')
    } else if (topic === 'orders/create' && body.id) {
      s = await credsOf(admin, c)
      const client = shopifyClient(c, s)
      const order = await client.order(body.admin_graphql_api_id ?? String(body.id))
      if (order) order.attribution = await journeyOf(client, String(body.id), order.attribution, body as Record<string, unknown>)
      result = order ? await ingest(admin, c, order, 'WEBHOOK') : { status: 'NOT_FOUND' }
    } else if (topic === 'inventory_items/update') {
      const item = body as { id?: number; cost?: string | number | null }
      result = item.id && item.cost !== null && item.cost !== undefined && item.cost !== ''
        ? await rpc(admin, 'channel_cost_seen', { p_channel_id: c.id, p_inventory_item_id: `gid://shopify/InventoryItem/${item.id}`, p_cost: Number(item.cost) })
        : { status: 'NO_COST' }
    } else if (topic === 'orders/cancelled' && body.id) {
      result = await rpc(admin, 'channel_order_cancelled', { p_channel_id: c.id, p_external_id: String(body.id), p_reason: body.cancel_reason ?? null })
    } else if (topic === 'orders/updated' && body.id) {
      // Only fulfilments are taken from updates: the rest of our order is ours to manage.
      const seen = seenFromWebhook(body as Record<string, unknown>)
      result = seen.length ? await rpc(admin, 'channel_fulfillments_seen', { p_channel_id: c.id, p_external_order_id: String(body.id), p_fulfillments: seen }) : { status: 'NO_FULFILMENTS' }
      // The customer journey is often ready only after the order was created.
      const rest = restTouch(body as Record<string, string>)
      if (rest) await rpc(admin, 'channel_order_attribution_fill', { p_channel_id: c.id, p_external_id: String(body.id), p_attribution: rest }).catch(() => undefined)
    } else if ((topic === 'fulfillments/create' || topic === 'fulfillments/update') && (body as { order_id?: number }).order_id) {
      result = await rpc(admin, 'channel_fulfillments_seen', { p_channel_id: c.id, p_external_order_id: String((body as { order_id: number }).order_id),
        p_fulfillments: seenFromWebhook(body as Record<string, unknown>) })
    } else if (topic === 'inventory_levels/update') {
      const lvl = body as { inventory_item_id?: number; location_id?: number; available?: number | null }
      if (lvl.inventory_item_id && lvl.location_id) {
        result = await rpc(admin, 'channel_inventory_seen', { p_channel_id: c.id, p_inventory_item_id: `gid://shopify/InventoryItem/${lvl.inventory_item_id}`,
          p_location_id: `gid://shopify/Location/${lvl.location_id}`, p_available: lvl.available ?? null })
      }
    } else if (topic === 'app/uninstalled') {
      await rpc(admin, 'channel_update', { p_id: c.id, p: { status: 'DISCONNECTED', last_error: 'The app was uninstalled in Shopify' } })
    }
    await rpc(admin, 'channel_delivery_first', { p_channel_id: c.id, p_delivery_id: delivery, p_topic: topic })
    return json(req, { ok: true, result })
  }

  // WooCommerce: the ping sent when a webhook is created is form data, not an order.
  const topic = req.headers.get('x-wc-webhook-topic') ?? ''
  if (!topic && /^webhook_id=\d+$/.test(raw.trim())) return json(req, { ok: true, ping: true })
  if (!s.webhook_secret || !(await verifyWooWebhook(raw, req.headers.get('x-wc-webhook-signature'), s.webhook_secret))) {
    void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: webhook with a bad signature rejected`, context: { channel: c.id } })
    throw new HttpError(401, 'Invalid signature', 'INVALID_SIGNATURE')
  }
  const delivery = req.headers.get('x-wc-webhook-delivery-id') ?? ''
  if (delivery && await rpc<boolean>(admin, 'channel_delivery_seen', { p_channel_id: c.id, p_delivery_id: delivery })) return json(req, { ok: true, duplicate: true })
  let result: unknown = { status: 'IGNORED' }
  if (topic === 'product.updated' || topic === 'product.created' || topic === 'product.deleted') {
    const body = JSON.parse(raw || '{}') as { id?: number; parent_id?: number }
    const seen = topic === 'product.deleted' ? null : wooStockFromWebhook(body)
    if (seen) result = await rpc(admin, 'channel_inventory_seen', { p_channel_id: c.id, p_inventory_item_id: seen.item, p_location_id: WOO_LOCATION.id, p_available: seen.available })
    const pid = body.parent_id || body.id
    if (pid && (c.catalog_imported_at || c.first_sync_at)) {
      result = { stock: result, product: await productChanged(admin, c, await credsOf(admin, c), String(pid), topic === 'product.deleted' && !body.parent_id) }
    }
  } else if (topic === 'order.created' || topic === 'order.updated') {
    const raw0 = JSON.parse(raw || '{}') as WooOrder
    if (raw0.id && WOO_CANCEL_STATUSES.includes(raw0.status)) {
      result = await rpc(admin, 'channel_order_cancelled', { p_channel_id: c.id, p_external_id: String(raw0.id), p_reason: raw0.status })
    } else if (raw0.id && WOO_IMPORT_STATUSES.includes(raw0.status)) {
      result = await ingest(admin, c, normalizeWooOrder(raw0), 'WEBHOOK')
    }
  }
  await rpc(admin, 'channel_delivery_first', { p_channel_id: c.id, p_delivery_id: delivery, p_topic: topic })
  return json(req, { ok: true, result })
}

// --- entry ------------------------------------------------------------------------------

Deno.serve(
  handle(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && /\/callback\/shopify\/?$/.test(path)) return shopifyCallback(req)
    if (req.method === 'POST' && /\/callback\/woocommerce\/?$/.test(path)) return wooCallback(req)
    const hook = /\/webhook\/([0-9a-f-]{36})\/?$/.exec(path)
    if (req.method === 'POST' && hook) return webhook(req, hook[1])
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const input = parse(actions, await readJson(req))
    const admin = adminClient()
    const cron = ((input.action === 'sync' && !input.channel_id) || input.action === 'process_jobs') && await isCronRequest(req, admin)
    const staff = cron ? null : await requireStaff(req,
      input.action === 'retry_import' ? 'orders.create' : input.action === 'process_jobs' || input.action === 'order_action' ? 'orders.update' : input.action === 'import_catalog' ? 'inventory.view' : 'settings.manage')
    const actor = staff?.user.id ?? null

    try {
      switch (input.action) {
        case 'shopify_connect': {
          const shop = shopDomain(input.shop)
          if (!shop) throw new HttpError(422, 'Enter the store address like mystore.myshopify.com', 'VALIDATION')
          const c = await rpc<Channel>(admin, 'channel_upsert', { p: { platform: 'SHOPIFY', shop_domain: shop, auth_mode: 'OAUTH' }, p_actor: actor })
          const old = await secretOf(admin, c.id)
          const clientSecret = input.client_secret || (old.client_id === input.client_id ? old.client_secret : undefined)
          if (!clientSecret) throw new HttpError(422, 'Enter the Client secret', 'VALIDATION')
          await storeSecret(admin, c.id, { ...old, mode: old.access_token ? old.mode : 'OAUTH', client_id: input.client_id, client_secret: clientSecret }, actor, `App ${hint(input.client_id)}`)
          const state = randomHex()
          await rpc(admin, 'channel_oauth_state_create', { p_channel_id: c.id, p_state: state, p_actor: actor, p_return_to: input.return_to })
          const redirectUri = shopifyRedirectUri(input.return_to)
          // Only the permissions for the chosen features (orders are always needed).
          const scopes = input.scopes?.length ? [...new Set(['read_orders', ...input.scopes])] : undefined
          return json(req, { url: shopifyAuthUrl(shop, input.client_id, state, redirectUri, scopes), redirect_uri: redirectUri, channel_id: c.id })
        }
        case 'shopify_client': {
          const shop = shopDomain(input.shop)
          if (!shop) throw new HttpError(422, 'Enter the store address like mystore.myshopify.com', 'VALIDATION')
          const c = await rpc<Channel>(admin, 'channel_upsert', { p: { platform: 'SHOPIFY', shop_domain: shop, auth_mode: 'OAUTH' }, p_actor: actor })
          const old = await secretOf(admin, c.id)
          const clientSecret = input.client_secret || (old.client_id === input.client_id ? old.client_secret : undefined)
          if (!clientSecret) throw new HttpError(422, 'Enter the Client secret', 'VALIDATION')
          // Get a token first: wrong keys or an app not installed fail here, before anything is saved.
          const t = await shopifyClientToken(shop, input.client_id, clientSecret)
          await storeSecret(admin, c.id, { mode: 'CLIENT', client_id: input.client_id, client_secret: clientSecret, access_token: t.accessToken, expires_at: t.expiresAt },
            actor, `App ${hint(input.client_id)}`)
          if (t.scopes.length) await rpc(admin, 'channel_update', { p_id: c.id, p: { scopes: t.scopes } })
          const done = await finishSetup(admin, c, actor)
          if (done.ok) background(syncChannel(admin, done.channel, 7))
          return json(req, done)
        }
        case 'shopify_token': {
          const shop = shopDomain(input.shop)
          if (!shop) throw new HttpError(422, 'Enter the store address like mystore.myshopify.com', 'VALIDATION')
          const c = await rpc<Channel>(admin, 'channel_upsert', { p: { platform: 'SHOPIFY', shop_domain: shop, auth_mode: 'TOKEN' }, p_actor: actor })
          await storeSecret(admin, c.id, { mode: 'TOKEN', access_token: input.access_token, api_secret: input.api_secret }, actor, `Token ${hint(input.access_token)}`)
          const done = await finishSetup(admin, c, actor)
          if (done.ok) background(syncChannel(admin, done.channel, 7))
          return json(req, done)
        }
        case 'woo_connect': {
          const site = siteUrl(input.url)
          if (!site) throw new HttpError(422, 'Enter the store address starting with https:// (WooCommerce needs a secure site)', 'VALIDATION')
          const c = await rpc<Channel>(admin, 'channel_upsert', { p: { platform: 'WOOCOMMERCE', shop_domain: site, auth_mode: 'KEYS' }, p_actor: actor })
          const state = randomHex()
          await rpc(admin, 'channel_oauth_state_create', { p_channel_id: c.id, p_state: state, p_actor: actor, p_return_to: input.return_to })
          const back = new URL(input.return_to)
          back.searchParams.set('channel', c.id)
          return json(req, { url: wooAuthUrl(site, appName(), state, back.toString(), `${fnBase()}/callback/woocommerce`), channel_id: c.id })
        }
        case 'woo_keys': {
          const site = siteUrl(input.url)
          if (!site) throw new HttpError(422, 'Enter the store address starting with https:// (WooCommerce needs a secure site)', 'VALIDATION')
          const c = await rpc<Channel>(admin, 'channel_upsert', { p: { platform: 'WOOCOMMERCE', shop_domain: site, auth_mode: 'KEYS' }, p_actor: actor })
          const old = await secretOf(admin, c.id)
          await storeSecret(admin, c.id, { mode: 'KEYS', consumer_key: input.consumer_key, consumer_secret: input.consumer_secret, webhook_secret: old.webhook_secret ?? randomHex() }, actor, `Woo ${hint(input.consumer_key)}`)
          const done = await finishSetup(admin, c, actor)
          if (done.ok) background(syncChannel(admin, done.channel, 7))
          return json(req, done)
        }
        case 'test':
          return json(req, await finishSetup(admin, await channelOf(admin, input.channel_id), actor, false))
        case 'webhooks':
          return json(req, await finishSetup(admin, await channelOf(admin, input.channel_id), actor, true))
        case 'disconnect': {
          const c = await channelOf(admin, input.channel_id)
          const s = await credsOf(admin, c).catch(() => secretOf(admin, c.id))
          try {
            if (c.platform === 'SHOPIFY' && s.access_token) await shopifyClient(c, s).removeWebhooks(c.webhooks.map((w) => String(w.id)))
            if (c.platform === 'WOOCOMMERCE' && s.consumer_key) await wooClient(c, s).removeWebhooks(c.webhooks.map((w) => Number(w.id)))
          } catch { /* the store may already be gone; our side is cleared regardless */ }
          await rpc(admin, 'integration_secret_clear', { p_key: secretKey(c.id), p_actor: actor })
          await rpc(admin, 'channel_update', { p_id: c.id, p_actor: actor, p: { status: 'DISCONNECTED', webhooks: [], last_error: '' } })
          return json(req, { ok: true })
        }
        case 'sync': {
          const list = input.channel_id
            ? [await channelOf(admin, input.channel_id)]
            : (await rpc<Channel[]>(admin, 'sales_channels_list')).filter((c) => c.status === 'CONNECTED')
          const results = []
          for (const c of list) results.push(await syncChannel(admin, c, cron ? 2 : input.days))
          if (input.channel_id && !results[0].ok) throw new HttpError(502, results[0].error ?? 'Sync failed', 'SYNC_FAILED')
          return json(req, { ok: results.every((r) => r.ok), channels: results })
        }
        case 'process_jobs':
          return json(req, await processJobs(admin, input.limit))
        case 'import_catalog':
          return json(req, await importCatalog(admin, await channelOf(admin, input.channel_id)))
        case 'order_action': {
          const ctx = await rpc<{ channel_id: string | null; external_order_id: string | null; platform: string | null; order_number: string }>(admin, 'channel_order_action_context', { p_order_id: input.order_id })
          if (!ctx.channel_id || !ctx.external_order_id || ctx.platform !== 'SHOPIFY') throw new HttpError(422, 'This order did not come from a Shopify store', 'VALIDATION')
          const c = await channelOf(admin, ctx.channel_id)
          if (c.status === 'DISCONNECTED') throw new HttpError(422, 'The store is disconnected', 'VALIDATION')
          const client = shopifyClient(c, await credsOf(admin, c))
          if (input.op === 'mark_paid') {
            const status = await client.markPaid(ctx.external_order_id)
            await rpc(admin, 'channel_order_action_record', { p_order_id: input.order_id, p_action: 'MARK_PAID', p_actor: actor, p_detail: { financial_status: status } })
            return json(req, { ok: true, financial_status: status })
          }
          const jobId = await client.cancelOrder(ctx.external_order_id, input.note ?? `Cancelled from ${appName()} (${ctx.order_number})`)
          await rpc(admin, 'channel_order_action_record', { p_order_id: input.order_id, p_action: 'CANCEL', p_actor: actor, p_detail: { job_id: jobId } })
          return json(req, { ok: true, job_id: jobId })
        }
        case 'reconnect': {
          const c = await channelOf(admin, input.channel_id)
          const s = await secretOf(admin, c.id)
          if (c.platform !== 'SHOPIFY' || !(s.mode === 'CLIENT' || s.mode === 'TOKEN')) throw new HttpError(422, 'Open Connect and approve the app again', 'VALIDATION')
          if (s.mode === 'CLIENT') {
            if (!s.client_id || !s.client_secret) throw new HttpError(422, 'The app keys are not saved; open Connect and enter them', 'VALIDATION')
            const t = await shopifyClientToken(c.shop_domain, s.client_id, s.client_secret)
            await storeSecret(admin, c.id, { ...s, access_token: t.accessToken, expires_at: t.expiresAt }, actor, `App ${hint(s.client_id)}`)
            if (t.scopes.length) await rpc(admin, 'channel_update', { p_id: c.id, p: { scopes: t.scopes } })
          }
          const done = await finishSetup(admin, c, actor)
          if (done.ok) background(syncChannel(admin, done.channel, 7))
          return json(req, done)
        }
        case 'retry_import': {
          const row = await rpc<{ channel_id: string; payload: NormalizedOrder }>(admin, 'channel_import_for_retry', { p_import_id: input.import_id, p_overrides: input.overrides, p_actor: actor })
          const r = await ingest(admin, await channelOf(admin, row.channel_id), row.payload, 'RETRY')
          return json(req, r)
        }
      }
    } catch (error) {
      if (error instanceof ChannelError) throw new HttpError(error.unauthorized ? 401 : 502, error.message, error.code ?? 'CHANNEL_ERROR')
      throw error
    }
  }),
)

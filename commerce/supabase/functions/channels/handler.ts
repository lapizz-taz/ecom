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
//   POST /channels/plugin/<channel_id>       events from the WooCommerce plugin (Fullfilio Connect), signed
//   POST plugin_pair | plugin_status | plugin_code {channel_id}   connect / check the plugin, or show its connection code
//   POST plugin_config     {channel_id, config}  the plugin's feature switches (sent to the store at once)
//   POST ad_tracking_get | ad_tracking_save {config, tokens?, clear?} | ad_tracking_test {platform}
//                          pixels + server events (Meta CAPI, TikTok, GA4) for the merchant's own store
// Every connection ends with a test, so staff see straight away whether orders
// will come through. Tokens and keys never reach a browser.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { type Check, ChannelError, type NormalizedOrder } from '../_shared/channels/common.ts'
import {
  exchangeShopifyCode, restocksFromWebhook, restTouch, seenFromWebhook, ShopifyClient, SHOPIFY_SCOPES, shopifyClientToken, shopDomain, shopifyAuthUrl, verifyShopifyCallback, verifyShopifyWebhook,
  visitExtras,
} from '../_shared/channels/shopify.ts'
import { touchFrom } from '../_shared/channels/common.ts'
import { connectionCode, leadToAbandoned, PLUGIN_SLUG, pluginEventSchema, verifyPluginRequest } from '../_shared/channels/woo-plugin.ts'
import { fulfillJob, inventoryJob, type Job, type Outcome, wooFulfillJob } from '../_shared/channels/sync.ts'
import {
  normalizeWooOrder, siteUrl, verifyWooWebhook, WOO_CANCEL_STATUSES, WOO_IMPORT_STATUSES, WOO_LOCATION, WooClient, wooAuthUrl, type WooOrder, wooStockFromWebhook,
} from '../_shared/channels/woocommerce.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'
import { env, functionsBase } from '../_shared/env.ts'
import { adTrackingStatus, processAdEvents, saveAdTracking, testAdTracking } from '../_shared/ads/store-tracking-service.ts'
import { FraudDetectionService, type FraudSettings, loadFraudProviders } from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { parse } from '../_shared/schemas.ts'
import { appBase, storefrontBase } from '../_shared/storefront.ts'
import { adminClient, forEachMerchant, getSettings, merchantFor, merchantOf, requireStaff, rpc } from '../_shared/supabase.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined
const background = (task: Promise<unknown>) => { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task) }

interface Channel {
  id: string; platform: 'SHOPIFY' | 'WOOCOMMERCE'; name: string; shop_domain: string; status: string; auth_mode: string | null
  webhooks: Array<{ id: string | number; topic: string }>; settings: Record<string, unknown>
  catalog_imported_at?: string | null; first_sync_at?: string | null
  /** From the store list: false when the merchant sells on another store (see channelInUse). */
  in_use?: boolean
}
interface Secret {
  mode?: 'OAUTH' | 'CLIENT' | 'TOKEN' | 'KEYS'; client_id?: string; client_secret?: string; access_token?: string; api_secret?: string
  /** Client-credentials tokens last 24 hours. */
  expires_at?: string
  consumer_key?: string; consumer_secret?: string; webhook_secret?: string
  /** Signs events from the WooCommerce plugin (Fullfilio Connect). */
  plugin_secret?: string
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
  z.object({ action: z.literal('abandoned_sync'), channel_id: channelId.optional(), days: z.number().int().min(1).max(60).nullable().default(30), cursor: z.string().max(500).nullable().optional() }),
  z.object({ action: z.literal('import_catalog'), channel_id: channelId }),
  z.object({ action: z.literal('order_action'), order_id: z.string().uuid(), op: z.enum(['mark_paid', 'cancel']), note: z.string().trim().max(255).optional() }),
  z.object({ action: z.literal('reconnect'), channel_id: channelId }),
  z.object({ action: z.literal('plugin_pair'), channel_id: channelId }),
  z.object({ action: z.literal('plugin_status'), channel_id: channelId }),
  z.object({ action: z.literal('plugin_code'), channel_id: channelId }),
  z.object({ action: z.literal('plugin_config'), channel_id: channelId, config: z.object({
    order_events: z.boolean(), capture_leads: z.boolean(), attribution: z.boolean(), custom_statuses: z.boolean(),
    shield: z.boolean(), shield_fail_open: z.boolean(), shield_timeout: z.number().int().min(2).max(10),
  }).partial() }),
  z.object({ action: z.literal('ad_tracking_get') }),
  z.object({ action: z.literal('ad_tracking_save'), config: z.record(z.string(), z.unknown()),
    tokens: z.object({ meta_token: z.string().trim().max(600), tiktok_token: z.string().trim().max(200), ga4_secret: z.string().trim().max(100) }).partial().optional(),
    clear: z.array(z.enum(['meta_token', 'tiktok_token', 'ga4_secret'])).max(3).optional() }),
  z.object({ action: z.literal('ad_tracking_test'), platform: z.enum(['meta', 'tiktok', 'google']) }),
  z.object({ action: z.literal('retry_import'), import_id: z.string().uuid(), overrides: z.object({
    phone: z.string().trim().max(20).optional(), name: z.string().trim().max(120).optional(),
    address: z.string().trim().max(300).optional(), district: z.string().trim().max(60).optional(),
  }).default({}) }),
])

const fnBase = () => `${functionsBase()}/channels`
/**
 * Shopify requires the redirect URL to be on the same host as the app URL, so
 * Shopify sends staff back to the admin's own domain, which forwards to this
 * function (the Worker, or vercel.json, maps /oauth/shopify/callback here).
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
const appName = () => env('CHANNEL_APP_NAME') ?? 'Fullfilio'

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

/** Only the store picked under "Where do customers buy?" syncs; the merchant's other stores are paused. */
const channelInUse = (admin: SupabaseClient, id: string) => rpc<boolean>(admin, 'channel_in_use', { p_channel_id: id })
const PAUSED = 'This store is paused because your customers buy on another store. Choose it under "Where do customers buy?" to use it again.'

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
  // The plugin is optional: without it orders still arrive; the check is a warning, never a failure.
  if (c.platform === 'WOOCOMMERCE' && checks.some((x) => x.key === 'api' && x.status === 'ok')) checks.push(await pairPlugin(admin, c, s))
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
  dispatchNotificationsInBackground(merchantOf(admin))
}

async function ingest(admin: SupabaseClient, c: Channel, order: NormalizedOrder, via: 'WEBHOOK' | 'SYNC' | 'RETRY'): Promise<IngestResult> {
  const r = await rpc<IngestResult>(admin, 'channel_ingest_order', { p_channel_id: c.id, p_order: order, p_via: via })
  // The buyer's IP and browser from the store's own checkout (kept only when the order is new to us).
  if (r.status === 'IMPORTED' && r.order_id && order.client?.ip) {
    await rpc(admin, 'record_order_client', { p_order_id: r.order_id, p_ip: order.client.ip, p_user_agent: order.client.user_agent })
      .catch((error) => console.error('Order IP not recorded:', (error as Error).message))
  }
  if (r.status === 'FAILED') {
    void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: order ${order.number ?? order.external_id} not imported — ${r.error}`, context: { channel: c.id, external_id: order.external_id } })
  }
  afterImport(admin, r)
  return r
}

/** Pull recent orders (also catches anything a webhook missed). */
/**
 * Shopify abandoned checkouts into our table: the last `days` days, or the
 * whole history (days null) in batches — `cursor` continues the previous
 * batch. A failure is stored on the channel (shown on the Abandoned Carts
 * page) and never stops the order sync.
 */
async function syncAbandoned(admin: SupabaseClient, c: Channel, days: number | null, cursor: string | null = null):
  Promise<{ id: string; name: string; ok: boolean; fetched: number; cursor: string | null; error?: string }> {
  try {
    const { rows, cursor: next } = await shopifyClient(c, await credsOf(admin, c)).abandonedCheckouts({
      since: days ? new Date(Date.now() - days * 86_400_000).toISOString() : null,
      after: cursor, max: days ? 500 : 600, deadline: Date.now() + 90_000,
    })
    const stored = rows.length ? await rpc<number>(admin, 'channel_abandoned_upsert', { p_channel_id: c.id, p_rows: rows }) : 0
    if (!rows.length) await rpc(admin, 'channel_abandoned_upsert', { p_channel_id: c.id, p_rows: [] })
    return { id: c.id, name: c.name, ok: true, fetched: stored, cursor: next }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await rpc(admin, 'channel_abandoned_upsert', { p_channel_id: c.id, p_rows: [], p_error: message })
      .catch((e) => logEvent({ level: 'WARN', category: 'FUNCTION', source: 'channels', message: 'Could not record the abandoned-checkout error', error: e }))
    void logEvent({ level: 'WARN', category: 'FUNCTION', source: 'channels', message: `${c.name}: abandoned checkouts — ${message}`, context: { channel_id: c.id } })
    return { id: c.id, name: c.name, ok: false, fetched: 0, cursor: null, error: message }
  }
}

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
        const opts = { notify_customer: c.settings?.notify_customer !== false, fulfill_without_tracking: c.settings?.fulfill_without_tracking === true,
          cancel_email: c.settings?.cancel_email !== false }
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
  const state = url.searchParams.get('state') ?? ''
  // The approval state was created by one merchant's staff; finish inside that merchant.
  const merchantId = await merchantFor('channel_oauth_state', state)
  if (!merchantId) return page('This link has expired', 'Go back to Sales channels and click Connect again.')
  const admin = adminClient(merchantId)
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
  const body = await readJson<{ key_id?: number; user_id?: string; consumer_key?: string; consumer_secret?: string; key_permissions?: string }>(req)
  const merchantId = body.user_id ? await merchantFor('channel_oauth_state', String(body.user_id)) : null
  if (!merchantId) throw new HttpError(400, 'Unknown or expired approval', 'INVALID_STATE')
  const admin = adminClient(merchantId)
  const taken = body.user_id ? await rpc<{ channel_id: string; created_by: string } | null>(admin, 'channel_oauth_state_take', { p_state: String(body.user_id) }) : null
  if (!taken) throw new HttpError(400, 'Unknown or expired approval', 'INVALID_STATE')
  if (!body.consumer_key || !body.consumer_secret) throw new HttpError(400, 'Keys missing', 'VALIDATION')
  const c = await channelOf(admin, taken.channel_id)
  const old = await secretOf(admin, c.id)
  await storeSecret(admin, c.id, { mode: 'KEYS', consumer_key: body.consumer_key, consumer_secret: body.consumer_secret, webhook_secret: old.webhook_secret ?? randomHex(), plugin_secret: old.plugin_secret ?? randomHex() }, taken.created_by, `Woo ${hint(body.consumer_key)}`)
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
  // The store's webhook address names the channel, and the channel its merchant.
  const merchantId = await merchantFor('channel', id)
  if (!merchantId) return json(req, { ok: true, ignored: 'not connected' })
  const admin = adminClient(merchantId)
  const c = await rpc<Channel | null>(admin, 'channel_get', { p_id: id })
  if (!c?.id || c.status === 'DISCONNECTED') return json(req, { ok: true, ignored: 'not connected' })
  // A paused store's events are acknowledged and dropped, before any work.
  if (!(await channelInUse(admin, c.id))) return json(req, { ok: true, ignored: 'paused' })
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
    // Shopify's own restock for an order we also have: not counted twice here.
    const restocked = async (orderId: string) => {
      const lines = restocksFromWebhook(body as Record<string, unknown>)
      return lines.length ? await rpc(admin, 'channel_store_restock_seen', { p_channel_id: c.id, p_external_order_id: orderId, p_lines: lines }) : null
    }
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
      result = { order: result, restock: await restocked(String(body.id)) }
    } else if (topic === 'orders/updated' && body.id) {
      const restock = await restocked(String(body.id))
      // Only fulfilments are taken from updates: the rest of our order is ours to manage.
      const seen = seenFromWebhook(body as Record<string, unknown>)
      result = seen.length ? await rpc(admin, 'channel_fulfillments_seen', { p_channel_id: c.id, p_external_order_id: String(body.id), p_fulfillments: seen }) : { status: 'NO_FULFILMENTS' }
      if (restock) result = { fulfilments: result, restock }
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
    result = await wooOrderSeen(admin, c, JSON.parse(raw || '{}') as WooOrder)
  }
  await rpc(admin, 'channel_delivery_first', { p_channel_id: c.id, p_delivery_id: delivery, p_topic: topic })
  return json(req, { ok: true, result })
}

/** A WooCommerce order as the store has it now (webhook body or read back for a plugin event): cancel, import or ignore. */
async function wooOrderSeen(admin: SupabaseClient, c: Channel, o: WooOrder): Promise<unknown> {
  if (!o?.id) return { status: 'IGNORED' }
  if (WOO_CANCEL_STATUSES.includes(o.status)) return rpc(admin, 'channel_order_cancelled', { p_channel_id: c.id, p_external_id: String(o.id), p_reason: o.status })
  if (WOO_IMPORT_STATUSES.includes(o.status)) return ingest(admin, c, normalizeWooOrder(o), 'WEBHOOK')
  return { status: 'IGNORED', woo_status: o.status }
}

// --- the WooCommerce plugin (Fullfilio Connect) ------------------------------------------------

const PLUGIN_DEFAULTS = { order_events: true, capture_leads: true, attribution: true, custom_statuses: true, shield: false, shield_fail_open: true, shield_timeout: 4 }
type PluginConfig = typeof PLUGIN_DEFAULTS
const pluginConfigOf = (c: Channel): PluginConfig & { stock_sync: boolean } => ({
  ...PLUGIN_DEFAULTS, ...((c.settings?.plugin_config ?? {}) as Partial<PluginConfig>), stock_sync: c.settings?.inventory_sync === true,
})

/** The store logo (Settings → Store), shown on the plugin's page. HTTPS only. */
async function appLogo(admin: SupabaseClient): Promise<string | undefined> {
  const url = (await getSettings<{ logo_url?: string | null }>(admin, 'store')).logo_url?.trim()
  return url && /^https:\/\//i.test(url) ? url : undefined
}

/** Where staff land from the plugin's "open" link. */
async function appUrl(admin: SupabaseClient, c: Channel) {
  // The link is optional in the plugin: leave it out rather than fail pairing when no address is set.
  const base = await Promise.resolve().then(() => appBase()).catch(() => storefrontBase(admin)).catch(() => null)
  return base ? `${base}/admin/store/sync?channel=${c.id}&tab=plugin` : ''
}

/** A secret for the plugin's signatures (made once per store). */
async function pluginSecret(admin: SupabaseClient, c: Channel, s: Secret): Promise<{ s: Secret; secret: string }> {
  if (s.plugin_secret) return { s, secret: s.plugin_secret }
  const next = { ...s, plugin_secret: randomHex() }
  await storeSecret(admin, c.id, next, null, s.consumer_key ? `Woo ${hint(s.consumer_key)}` : 'Woo plugin')
  return { s: next, secret: next.plugin_secret! }
}

/** Gives the store's plugin our address, its secret and its switches (with the store's API keys). */
async function pairPlugin(admin: SupabaseClient, c: Channel, s0: Secret): Promise<Check> {
  const label = 'Fullfilio Connect plugin'
  try {
    const { s, secret } = await pluginSecret(admin, c, s0)
    const r = await wooClient(c, s).pluginPair({ endpoint: fnBase(), channel_id: c.id, secret, app_name: appName(), app_url: await appUrl(admin, c), app_logo: await appLogo(admin), config: pluginConfigOf(c) })
    await rpc(admin, 'channel_plugin_paired', { p_channel_id: c.id, p_ok: true, p_detail: `v${r.version}`, p_report: r.report ?? null })
    return { key: 'plugin', label, status: 'ok', detail: `Version ${r.version} connected: unfinished checkouts, attribution and instant orders` }
  } catch (error) {
    const e = error as ChannelError
    const missing = e.code === 'NO_PLUGIN'
    await rpc(admin, 'channel_plugin_paired', { p_channel_id: c.id, p_ok: false, p_detail: missing ? 'not installed' : e.message }).catch(() => undefined)
    return { key: 'plugin', label, status: 'warn', detail: missing
      ? 'Not installed (optional). Install it for unfinished checkouts, the order shield and ad attribution — download it on the WooCommerce card.'
      : `Installed, but it could not be connected: ${e.message}` }
  }
}

async function pluginLog(admin: SupabaseClient, c: Channel, eventId: string | null, type: string, status: 'OK' | 'DUPLICATE' | 'FAILED' | 'REJECTED', detail: Record<string, unknown> = {}) {
  await rpc(admin, 'channel_plugin_log', { p_channel_id: c.id, p_event_id: eventId, p_type: type, p_status: status, p_detail: detail })
    .catch((e) => logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: 'Could not record a plugin event', error: e }))
}

/** The order shield: block list first, then the courier record (within the plugin's time budget). */
async function checkoutDecision(admin: SupabaseClient, c: Channel, d: { phone: string; total: number; address: string; ip: string }, budgetMs: number) {
  const args = { p_channel_id: c.id, p_phone: d.phone, p_ip: d.ip || null, p_address: d.address || null }
  const first = await rpc<{ decision: string; message?: string; reason: string }>(admin, 'channel_checkout_decision', { ...args, p_check_id: null })
  if (first.decision === 'block') return first
  const check = fraudCheckFor(admin, d.phone, d.total).catch((error) => {
    void logEvent({ level: 'WARN', category: 'FRAUD', source: 'channels', message: `${c.name}: courier check at checkout failed`, error })
    return null
  })
  const id = await Promise.race([check, new Promise<null>((r) => setTimeout(() => r(null), budgetMs))])
  if (!id) {
    background(check) // the check finishes and is reused when the order arrives
    return { decision: 'allow', reason: 'CHECK_PENDING' }
  }
  return rpc<{ decision: string; message?: string; reason: string }>(admin, 'channel_checkout_decision', { ...args, p_check_id: id })
}

/** POST /channels/plugin/<channel_id>: a signed event from the store's plugin. */
async function pluginEvent(req: Request, id: string): Promise<Response> {
  const raw = await req.text()
  if (raw.length > 512_000) throw new HttpError(413, 'Too large', 'PAYLOAD_TOO_LARGE')
  const merchantId = await merchantFor('channel', id)
  if (!merchantId) throw new HttpError(404, 'Unknown store', 'NOT_FOUND')
  const admin = adminClient(merchantId)
  const c = await rpc<Channel | null>(admin, 'channel_get', { p_id: id })
  if (!c?.id || c.platform !== 'WOOCOMMERCE') throw new HttpError(404, 'Unknown store', 'NOT_FOUND')
  if (c.status === 'DISCONNECTED') throw new HttpError(410, 'This store is disconnected in Fullfilio. Connect it again there.', 'DISCONNECTED')
  // Paused: nothing is recorded, and checkouts are never held up.
  if (!(await channelInUse(admin, c.id))) return json(req, { ok: true, ignored: 'paused', decision: 'allow', reason: 'PAUSED' })
  const s = await secretOf(admin, c.id)
  const type = (req.headers.get('x-ffc-event') ?? '').slice(0, 40)
  const eventId = (req.headers.get('x-ffc-event-id') ?? '').slice(0, 80) || null
  const verified = s.plugin_secret ? await verifyPluginRequest(raw, req.headers, s.plugin_secret) : { ok: false as const, reason: 'SIGNATURE' as const }
  if (!verified.ok) {
    await pluginLog(admin, c, eventId, type || 'unknown', 'REJECTED', { reason: verified.reason })
    void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: plugin request rejected (${verified.reason})`, context: { channel: c.id } })
    throw new HttpError(401, verified.reason === 'STALE' ? 'The request is too old — check the clock of the web server' : 'Invalid signature', 'INVALID_SIGNATURE')
  }
  let body: unknown
  try { body = JSON.parse(raw) } catch { throw new HttpError(400, 'Invalid JSON', 'INVALID_JSON') }
  const parsed = pluginEventSchema.safeParse(body)
  if (!parsed.success) {
    await pluginLog(admin, c, eventId, type || 'unknown', 'REJECTED', { error: parsed.error.issues[0]?.message ?? 'invalid' })
    throw new HttpError(422, `Invalid ${type || 'event'}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`, 'VALIDATION')
  }
  const ev = parsed.data
  const config = pluginConfigOf(c)

  // Synchronous answers, never stored as deliveries.
  if (ev.type === 'heartbeat') {
    const cfg = await rpc<PluginConfig>(admin, 'channel_plugin_seen', { p_channel_id: c.id, p_report: ev.data })
    // WooCommerce pauses a webhook after repeated failed deliveries: switch ours back on.
    const hooks = Array.isArray(ev.data.webhooks) ? ev.data.webhooks as Array<{ status?: string }> : []
    if (hooks.some((h) => h.status && h.status !== 'active') && s.webhook_secret) {
      background(wooClient(c, s).ensureWebhooks(webhookUrl(c.id), s.webhook_secret)
        .then(() => pluginLog(admin, c, null, 'webhooks', 'OK', { action: 'paused webhooks switched back on' }))
        .catch((e) => pluginLog(admin, c, null, 'webhooks', 'FAILED', { error: (e as Error).message })))
    }
    return json(req, { ok: true, config: cfg })
  }
  if (ev.type === 'checkout_check') {
    if (!config.shield) return json(req, { ok: true, decision: 'allow', reason: 'OFF' })
    const d = await checkoutDecision(admin, c, ev.data, Math.max(1000, config.shield_timeout * 1000 - 1500))
    if (d.decision !== 'allow') await pluginLog(admin, c, eventId, 'checkout_check', 'OK', { decision: d.decision, reason: d.reason, phone_end: ev.data.phone.slice(-3) })
    return json(req, { ok: true, decision: d.decision, message: d.message ?? '', reason: d.reason })
  }

  // Queued events: one id per event, the same on every retry.
  const delivery = eventId ? `ffc:${eventId}` : ''
  if (delivery && await rpc<boolean>(admin, 'channel_delivery_seen', { p_channel_id: c.id, p_delivery_id: delivery })) {
    await pluginLog(admin, c, eventId, ev.type, 'DUPLICATE')
    return json(req, { ok: true, duplicate: true })
  }
  let result: unknown
  try {
    if (ev.type === 'lead') {
      result = config.capture_leads
        ? { stored: await rpc<number>(admin, 'channel_abandoned_upsert', { p_channel_id: c.id, p_rows: [leadToAbandoned(ev.data)] }) }
        : { ignored: 'capture off' }
    } else if (ev.type === 'lead_completed') {
      result = { recovered: await rpc<boolean>(admin, 'channel_abandoned_complete', { p_channel_id: c.id, p_external_id: ev.data.id, p_completed_at: ev.data.completed_at ?? new Date().toISOString() }) }
    } else if (ev.type === 'order') {
      if (!config.order_events) {
        result = { ignored: 'order events off' }
      } else {
        // Always WooCommerce's own copy of the order, read with the store's keys.
        let order: WooOrder | null = null
        try {
          order = await wooClient(c, await credsOf(admin, c)).order(ev.data.order_id)
        } catch (error) {
          if (error instanceof ChannelError && error.status === 404) order = null
          else throw error
        }
        result = order ? await wooOrderSeen(admin, c, order) : { status: 'NOT_FOUND' }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pluginLog(admin, c, eventId, ev.type, 'FAILED', { error: message.slice(0, 300) })
    // Not recorded as delivered: the plugin sends it again later.
    throw error instanceof ChannelError ? new HttpError(502, message, error.code ?? 'CHANNEL_ERROR') : error
  }
  await rpc(admin, 'channel_delivery_first', { p_channel_id: c.id, p_delivery_id: delivery, p_topic: `plugin.${ev.type}` })
  await pluginLog(admin, c, eventId, ev.type, 'OK', (result ?? {}) as Record<string, unknown>)
  return json(req, { ok: true, result })
}

/** Delivered / Returned on WooCommerce orders (queued by the database when the courier reports it). */
async function processStatusPushes(admin: SupabaseClient, limit = 20) {
  const due = await rpc<Array<{ id: string; channel_id: string; external_order_id: string; target: 'delivered' | 'returned' }>>(admin, 'channel_status_push_due', { p_limit: limit })
  const out = { done: 0, failed: 0, waiting: 0 }
  const channels = new Map<string, Channel>()
  for (const p of due) {
    try {
      const c = channels.get(p.channel_id) ?? await channelOf(admin, p.channel_id)
      channels.set(c.id, c)
      if (c.status === 'DISCONNECTED') {
        await rpc(admin, 'channel_status_push_result', { p_id: p.id, p_ok: false, p_error: 'The store is disconnected', p_retry: false })
        out.failed++
        continue
      }
      const status = await wooClient(c, await credsOf(admin, c)).setStatus(p.external_order_id, p.target)
      if (status !== p.target) throw new ChannelError(`WooCommerce kept the order ${status}`, 422, 'USER_ERROR')
      await rpc(admin, 'channel_status_push_result', { p_id: p.id, p_ok: true })
      out.done++
    } catch (error) {
      const e = error as ChannelError
      // An unknown status means the plugin (which adds Delivered and Returned) is not installed.
      const invalid = e.status === 400 || /invalid|status/i.test(e.code ?? '')
      const message = invalid ? `WooCommerce has no "${p.target}" status — install the ${PLUGIN_SLUG} plugin (${e.message})` : e.message
      const retry = !invalid && !(e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)
      await rpc(admin, 'channel_status_push_result', { p_id: p.id, p_ok: false, p_error: message, p_retry: retry })
      if (retry) out.waiting++
      else out.failed++
    }
  }
  return out
}

// --- entry ------------------------------------------------------------------------------

export default (
  handle(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && /\/callback\/shopify\/?$/.test(path)) return shopifyCallback(req)
    if (req.method === 'POST' && /\/callback\/woocommerce\/?$/.test(path)) return wooCallback(req)
    const hook = /\/webhook\/([0-9a-f-]{36})\/?$/.exec(path)
    if (req.method === 'POST' && hook) return webhook(req, hook[1])
    const plugin = /\/plugin\/([0-9a-f-]{36})\/?$/.exec(path)
    if (req.method === 'POST' && plugin) return pluginEvent(req, plugin[1])
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    const input = parse(actions, await readJson(req))
    const cron = ((input.action === 'sync' && !input.channel_id) || input.action === 'process_jobs') && await isCronRequest(req, adminClient())
    // Scheduled runs go through every merchant, each with its own stores and keys.
    if (cron && input.action === 'sync') {
      return json(req, await forEachMerchant('channels', async (admin) => {
        const list = (await rpc<Channel[]>(admin, 'sales_channels_list')).filter((c) => c.status === 'CONNECTED' && c.in_use !== false)
        const results = []
        for (const c of list) results.push(await syncChannel(admin, c, 2))
        // The hourly run also refreshes Shopify's abandoned checkouts (last 7 days).
        for (const c of list.filter((x) => x.platform === 'SHOPIFY')) await syncAbandoned(admin, c, 7)
        return { ok: results.every((r) => r.ok), channels: results }
      }))
    }
    if (cron && input.action === 'process_jobs') {
      return json(req, await forEachMerchant('channels', async (admin) => {
        const jobs = await processJobs(admin, input.limit)
        const statuses = await processStatusPushes(admin).catch((e) => ({ error: (e as Error).message }))
        const ads = await processAdEvents(admin).catch((e) => ({ error: (e as Error).message }))
        return { ...jobs, statuses, ads }
      }))
    }
    const staff = await requireStaff(req,
      input.action === 'retry_import' ? 'orders.create' : input.action === 'process_jobs' || input.action === 'order_action' ? 'orders.update' : input.action === 'import_catalog' ? 'inventory.view' : input.action === 'abandoned_sync' ? 'orders.view'
        : input.action === 'ad_tracking_get' ? 'settings.view' : 'settings.manage',
      { supportView: input.action === 'ad_tracking_get' })
    const admin = staff.admin
    const actor = staff.user.id

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
          await storeSecret(admin, c.id, { mode: 'KEYS', consumer_key: input.consumer_key, consumer_secret: input.consumer_secret, webhook_secret: old.webhook_secret ?? randomHex(), plugin_secret: old.plugin_secret ?? randomHex() }, actor, `Woo ${hint(input.consumer_key)}`)
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
            if (c.platform === 'WOOCOMMERCE' && s.consumer_key) {
              await wooClient(c, s).removeWebhooks(c.webhooks.map((w) => Number(w.id)))
              await wooClient(c, s).pluginUnpair().catch(() => undefined)
            }
          } catch { /* the store may already be gone; our side is cleared regardless */ }
          await rpc(admin, 'integration_secret_clear', { p_key: secretKey(c.id), p_actor: actor })
          await rpc(admin, 'channel_update', { p_id: c.id, p_actor: actor, p: { status: 'DISCONNECTED', webhooks: [], last_error: '' } })
          return json(req, { ok: true })
        }
        case 'sync': {
          if (input.channel_id && !(await channelInUse(admin, input.channel_id))) throw new HttpError(422, PAUSED, 'PAUSED')
          const list = input.channel_id
            ? [await channelOf(admin, input.channel_id)]
            : (await rpc<Channel[]>(admin, 'sales_channels_list')).filter((c) => c.status === 'CONNECTED' && c.in_use !== false)
          const results = []
          for (const c of list) results.push(await syncChannel(admin, c, input.days))
          if (input.channel_id && !results[0].ok) throw new HttpError(502, results[0].error ?? 'Sync failed', 'SYNC_FAILED')
          return json(req, { ok: results.every((r) => r.ok), channels: results })
        }
        case 'process_jobs': {
          const jobs = await processJobs(admin, input.limit)
          const statuses = await processStatusPushes(admin).catch((e) => ({ error: (e as Error).message }))
          const ads = await processAdEvents(admin).catch((e) => ({ error: (e as Error).message }))
          return json(req, { ...jobs, statuses, ads })
        }
        // Ad tracking for the merchant's own store (pixels + server events). Tokens stay in Vault.
        case 'ad_tracking_get':
          return json(req, await adTrackingStatus(admin))
        case 'ad_tracking_save':
          return json(req, await saveAdTracking(admin, { config: input.config, tokens: input.tokens, clear: input.clear }, actor))
        case 'ad_tracking_test':
          return json(req, await testAdTracking(admin, input.platform))
        case 'abandoned_sync': {
          if (input.channel_id && !(await channelInUse(admin, input.channel_id))) throw new HttpError(422, PAUSED, 'PAUSED')
          const list = (input.channel_id ? [await channelOf(admin, input.channel_id)] : await rpc<Channel[]>(admin, 'sales_channels_list'))
            .filter((c) => c.platform === 'SHOPIFY' && c.status !== 'DISCONNECTED' && c.in_use !== false)
          if (!list.length) throw new HttpError(422, 'No Shopify store is in use', 'NOT_CONNECTED')
          // Continuing a history import: one store per call, with its cursor.
          if (input.cursor && list.length > 1) throw new HttpError(422, 'Choose the store to continue', 'VALIDATION')
          const results = []
          for (const c of list) results.push(await syncAbandoned(admin, c, input.days, input.cursor ?? null))
          return json(req, { ok: results.every((r) => r.ok), channels: results })
        }
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
          const jobId = await client.cancelOrder(ctx.external_order_id, input.note ?? `Cancelled from ${appName()} (${ctx.order_number})`, false,
            c.settings?.cancel_email !== false)
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
        case 'plugin_pair': {
          const c = await channelOf(admin, input.channel_id)
          if (c.platform !== 'WOOCOMMERCE') throw new HttpError(422, 'Only WooCommerce stores use the plugin', 'VALIDATION')
          return json(req, { check: await pairPlugin(admin, c, await credsOf(admin, c)) })
        }
        case 'plugin_status': {
          const c = await channelOf(admin, input.channel_id)
          if (c.platform !== 'WOOCOMMERCE') throw new HttpError(422, 'Only WooCommerce stores use the plugin', 'VALIDATION')
          const started = Date.now()
          try {
            const r = await wooClient(c, await credsOf(admin, c)).pluginStatus()
            if (r.report) await rpc(admin, 'channel_plugin_seen', { p_channel_id: c.id, p_report: r.report })
            return json(req, { reachable: true, connected: r.connected, ms: Date.now() - started, report: r.report })
          } catch (error) {
            const e = error as ChannelError
            return json(req, { reachable: false, installed: e.code !== 'NO_PLUGIN', ms: Date.now() - started, error: e.message })
          }
        }
        case 'plugin_code': {
          const c = await channelOf(admin, input.channel_id)
          if (c.platform !== 'WOOCOMMERCE') throw new HttpError(422, 'Only WooCommerce stores use the plugin', 'VALIDATION')
          const { secret } = await pluginSecret(admin, c, await secretOf(admin, c.id))
          return json(req, { code: connectionCode(fnBase(), c.id, secret, appName()) }, 200, { 'Cache-Control': 'no-store' })
        }
        case 'plugin_config': {
          const c = await channelOf(admin, input.channel_id)
          const cfg = await rpc<PluginConfig>(staff.client, 'channel_plugin_config_save', { p_channel_id: c.id, p: input.config })
          // Sent to the store at once; otherwise it arrives with the next heartbeat.
          const check = await pairPlugin(admin, { ...c, settings: { ...c.settings, plugin_config: cfg } }, await credsOf(admin, c))
          return json(req, { config: cfg, delivered: check.status === 'ok', detail: check.detail })
        }
        case 'retry_import': {
          const row = await rpc<{ channel_id: string; payload: NormalizedOrder }>(admin, 'channel_import_for_retry', { p_import_id: input.import_id, p_overrides: input.overrides, p_actor: actor })
          if (!(await channelInUse(admin, row.channel_id))) throw new HttpError(422, PAUSED, 'PAUSED')
          const r = await ingest(admin, await channelOf(admin, row.channel_id), row.payload, 'RETRY')
          return json(req, r)
        }
      }
    } catch (error) {
      if (error instanceof ChannelError) throw new HttpError(error.unauthorized ? 401 : 502, error.message, error.code ?? 'CHANNEL_ERROR')
      throw error
    }
  })
)

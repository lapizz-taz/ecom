// Sales channels: Shopify and WooCommerce stores whose orders come here.
//   POST shopify_connect   {shop, client_id, client_secret?, return_to} → Shopify's approval screen
//   GET  /channels/callback/shopify          Shopify sends staff back: code → token (Vault)
//   POST shopify_token     {shop, access_token, api_secret}   custom-app token instead of OAuth
//   POST woo_connect       {url, return_to} → the store's own WooCommerce approval screen
//   POST /channels/callback/woocommerce      WooCommerce posts the approved API keys here
//   POST woo_keys          {url, consumer_key, consumer_secret}   keys made by hand
//   POST test | webhooks | sync | disconnect {channel_id}
//   POST retry_import      {import_id, overrides}   staff fixed a failed import
//   POST /channels/webhook/<channel_id>      orders from the store (signature checked)
// Every connection ends with a test, so staff see straight away whether orders
// will come through. Tokens and keys never reach a browser.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { type Check, ChannelError, type NormalizedOrder } from '../_shared/channels/common.ts'
import { exchangeShopifyCode, ShopifyClient, shopDomain, shopifyAuthUrl, verifyShopifyCallback, verifyShopifyWebhook } from '../_shared/channels/shopify.ts'
import { normalizeWooOrder, siteUrl, verifyWooWebhook, WOO_CANCEL_STATUSES, WOO_IMPORT_STATUSES, WooClient, wooAuthUrl, type WooOrder } from '../_shared/channels/woocommerce.ts'
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
}
interface Secret {
  mode?: 'OAUTH' | 'TOKEN' | 'KEYS'; client_id?: string; client_secret?: string; access_token?: string; api_secret?: string
  consumer_key?: string; consumer_secret?: string; webhook_secret?: string
}
interface IngestResult { status: 'IMPORTED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED'; order_id?: string; order_number?: string; phone?: string; total?: number; error?: string; import_id?: string }

const returnTo = z.string().url().max(500)
const channelId = z.string().uuid()
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('shopify_connect'), shop: z.string().trim().min(3).max(200), client_id: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'The Client ID is a 32-character code from the app\'s settings'), client_secret: z.string().trim().max(200).optional(), return_to: returnTo }),
  z.object({ action: z.literal('shopify_token'), shop: z.string().trim().min(3).max(200), access_token: z.string().trim().regex(/^shp[a-z]{2}_[A-Za-z0-9]{20,64}$/, 'The Admin API access token starts with shpat_'), api_secret: z.string().trim().min(16, 'Enter the app\'s API secret key').max(200) }),
  z.object({ action: z.literal('woo_connect'), url: z.string().trim().min(4).max(300), return_to: returnTo }),
  z.object({ action: z.literal('woo_keys'), url: z.string().trim().min(4).max(300), consumer_key: z.string().trim().regex(/^ck_[a-f0-9]{40}$/, 'The consumer key starts with ck_'), consumer_secret: z.string().trim().regex(/^cs_[a-f0-9]{40}$/, 'The consumer secret starts with cs_') }),
  z.object({ action: z.literal('test'), channel_id: channelId }),
  z.object({ action: z.literal('webhooks'), channel_id: channelId }),
  z.object({ action: z.literal('disconnect'), channel_id: channelId }),
  z.object({ action: z.literal('sync'), channel_id: channelId.optional(), days: z.number().int().min(1).max(60).default(3) }),
  z.object({ action: z.literal('retry_import'), import_id: z.string().uuid(), overrides: z.object({
    phone: z.string().trim().max(20).optional(), name: z.string().trim().max(120).optional(),
    address: z.string().trim().max(300).optional(), district: z.string().trim().max(60).optional(),
  }).default({}) }),
])

const publicBase = () => (env('PUBLIC_SUPABASE_URL') ?? requireEnv('SUPABASE_URL')).replace(/\/+$/, '')
const fnBase = () => `${publicBase()}/functions/v1/channels`
export const shopifyRedirectUri = () => `${fnBase()}/callback/shopify`
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
  const s = await secretOf(admin, c.id)
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
  const s = await secretOf(admin, c.id)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const counts = { found: 0, imported: 0, duplicate: 0, failed: 0, skipped: 0 }
  try {
    if (c.platform === 'SHOPIFY') {
      for (const o of await shopifyClient(c, s).ordersSince(since)) {
        counts.found++
        const r = await ingest(admin, c, o, 'SYNC')
        bump(counts, r.status)
      }
    } else {
      for (const raw of await wooClient(c, s).ordersSince(since)) {
        if (!WOO_IMPORT_STATUSES.includes(raw.status)) continue
        counts.found++
        const r = await ingest(admin, c, normalizeWooOrder(raw), 'SYNC')
        bump(counts, r.status)
      }
    }
    await rpc(admin, 'channel_update', { p_id: c.id, p: { synced: true, ...(c.status === 'ERROR' ? {} : { last_error: '' }) } })
    return { id: c.id, name: c.name, ok: true, ...counts }
  } catch (error) {
    const e = error as ChannelError
    await rpc(admin, 'channel_update', { p_id: c.id, p: { last_error: `Sync: ${e.message}`, ...(e.unauthorized ? { status: 'ERROR' } : {}) } })
    void logEvent({ level: 'ERROR', category: 'JOB', source: 'channels', message: `${c.name}: sync failed — ${e.message}`, context: { channel: c.id } })
    return { id: c.id, name: c.name, ok: false, error: e.message, ...counts }
  }
}
function bump(c: { imported: number; duplicate: number; failed: number; skipped: number }, status: IngestResult['status']) {
  if (status === 'IMPORTED') c.imported++
  else if (status === 'DUPLICATE') c.duplicate++
  else if (status === 'FAILED') c.failed++
  else c.skipped++
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
  const s = await secretOf(admin, c.id)

  if (c.platform === 'SHOPIFY') {
    const signing = s.mode === 'OAUTH' ? s.client_secret : s.api_secret
    if (!signing || !(await verifyShopifyWebhook(raw, req.headers.get('x-shopify-hmac-sha256'), signing))) {
      void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'channels', message: `${c.name}: webhook with a bad signature rejected`, context: { channel: c.id } })
      throw new HttpError(401, 'Invalid signature', 'INVALID_SIGNATURE')
    }
    const topic = req.headers.get('x-shopify-topic') ?? ''
    const delivery = req.headers.get('x-shopify-webhook-id') ?? req.headers.get('x-shopify-event-id') ?? ''
    if (delivery && await rpc<boolean>(admin, 'channel_delivery_seen', { p_channel_id: c.id, p_delivery_id: delivery })) return json(req, { ok: true, duplicate: true })
    const body = JSON.parse(raw || '{}') as { id?: number; admin_graphql_api_id?: string; cancel_reason?: string }
    let result: unknown = null
    if (topic === 'orders/create' && body.id) {
      const order = await shopifyClient(c, s).order(body.admin_graphql_api_id ?? String(body.id))
      result = order ? await ingest(admin, c, order, 'WEBHOOK') : { status: 'NOT_FOUND' }
    } else if (topic === 'orders/cancelled' && body.id) {
      result = await rpc(admin, 'channel_order_cancelled', { p_channel_id: c.id, p_external_id: String(body.id), p_reason: body.cancel_reason ?? null })
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
  if (topic === 'order.created' || topic === 'order.updated') {
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
    const cron = input.action === 'sync' && !input.channel_id && await isCronRequest(req, admin)
    const staff = cron ? null : await requireStaff(req, input.action === 'retry_import' ? 'orders.create' : 'settings.manage')
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
          return json(req, { url: shopifyAuthUrl(shop, input.client_id, state, shopifyRedirectUri()), redirect_uri: shopifyRedirectUri(), channel_id: c.id })
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
          const s = await secretOf(admin, c.id)
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

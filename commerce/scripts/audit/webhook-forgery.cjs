// Audit round 4, pass 8: every endpoint that outside services call without a staff sign-in (courier
// status callbacks, payment notifications, Shopify and WooCommerce webhooks, the WordPress plugin, the
// Meta inbox webhook, the Clerk webhook, the store-connect callbacks), sent forged, unsigned, wrongly
// signed and stale requests against the real Worker on this machine. Each must be refused (or, for a
// gateway notification, verified with the gateway and ignored) without changing any business table;
// one correctly signed request per endpoint shows the refusals come from the signature check.
// Never deployed; outside services are not reachable from here.
//
// Run (from commerce/), after the build in functions-auth-sweep.cjs:
//   node scripts/audit/webhook-forgery.cjs
const { spawn } = require('node:child_process')
const { createHmac, randomUUID } = require('node:crypto')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '../..')
const S = __dirname
const port = 8000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const SERVICE = 'e2e-service-key-not-a-secret'
const M1 = '00000000-0000-4000-8000-000000000001'
// Test-only signing keys for this local run.
const CLERK_KEY = Buffer.from('clerk-webhook-test-key-32-bytes!').toString('base64')
const SHOP_SECRET = 'shop-client-secret-test'
const WOO_HOOK = 'woo-webhook-secret-test'
const WOO_PLUGIN = 'woo-plugin-secret-test'
const COURIER_SECRET = 'courier-webhook-secret-test'
const META = { app_id: '1000000000', app_secret: 'meta-app-secret-test', login_config_id: '2000000000', verify_token: 'meta-verify-token-test' }
const persist = mkdtempSync(join(tmpdir(), 'audit-r4-hooks-'))

const dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'),
  ['dev', '--local', '--config', join(S, 'wrangler.jsonc'), '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist,
    '--var', `PLATFORM_URL:${base}`, '--var', `FUNCTIONS_URL:${base}/functions/v1`, '--var', `CLERK_WEBHOOK_SECRET:whsec_${CLERK_KEY}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
let devLog = ''
dev.stdout.on('data', (d) => { devLog += d })
dev.stderr.on('data', (d) => { devLog += d })

const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail).slice(0, 600) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 600)}`}`)
}
/** A request as an outside service sends it: no apikey, no sign-in. */
async function send(method, path, { body, headers = {}, raw } = {}) {
  const text = raw ?? (body === undefined ? undefined : JSON.stringify(body))
  const res = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: text })
  const out = await res.text()
  let json = null
  try { json = out ? JSON.parse(out) : null } catch { json = out }
  return { status: res.status, body: json, location: res.headers.get('location') }
}
/** The database as the service role, for setup and the before/after counts. */
async function db(method, path, body, extra = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'x-merchant-id': M1, Prefer: 'return=representation', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return json
}
const rpc = (fn, args) => db('POST', `/rest/v1/rpc/${fn}`, args)

// Business tables a forged call could change, counted (and fingerprinted) before and after.
const WATCHED = ['orders', 'order_status_history', 'shipments', 'shipment_events', 'courier_webhook_events', 'payments', 'payment_events',
  'sales_channels', 'channel_webhook_deliveries', 'products', 'product_variants', 'inventory', 'inventory_movements', 'stock_reservations',
  'inbox_conversations', 'inbox_messages', 'profiles', 'customers']
async function snapshot() {
  const out = {}
  for (const t of WATCHED) {
    try {
      const rows = await db('GET', `/rest/v1/${t}?select=*&limit=1000`)
      out[t] = JSON.stringify(rows.map((x) => JSON.stringify(x)).sort())
    } catch (e) {
      out[t] = `unreadable: ${e.message.slice(0, 80)}`
    }
  }
  return out
}
const changed = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t])

const hmac = (key, data, enc = 'base64') => createHmac('sha256', key).update(data).digest(enc)
function svix(body, { key = CLERK_KEY, ts = Math.floor(Date.now() / 1000), id = `msg_${randomUUID()}` } = {}) {
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${hmac(Buffer.from(key, 'base64'), `${id}.${ts}.${body}`)}` }
}

async function main() {
  for (let i = 0; i < 180; i++) {
    try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
  step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))

  // --- setup: a courier with its own webhook secret, a Shopify and a WooCommerce channel, the Meta app.
  const [courier] = await db('POST', '/rest/v1/couriers', { merchant_id: M1, name: 'Pathao (forgery test)', provider: 'pathao' })
  await rpc('courier_webhook_secret_set', { p_courier_id: courier.id, p_secret: COURIER_SECRET, p_actor: null })
  const [shop] = await db('POST', '/rest/v1/sales_channels', { merchant_id: M1, platform: 'SHOPIFY', name: 'Forge Shop', shop_domain: 'forge-test.myshopify.com', status: 'CONNECTED', auth_mode: 'OAUTH' })
  await rpc('integration_secret_store', { p_key: `channels.${shop.id.replace(/-/g, '')}`, p_value: { mode: 'OAUTH', client_id: 'x', client_secret: SHOP_SECRET, access_token: 'shpat_test' }, p_hint: 'test', p_actor: null })
  const [woo] = await db('POST', '/rest/v1/sales_channels', { merchant_id: M1, platform: 'WOOCOMMERCE', name: 'Forge Woo', shop_domain: 'forge-woo.example.test', status: 'CONNECTED', auth_mode: 'KEYS' })
  await rpc('integration_secret_store', { p_key: `channels.${woo.id.replace(/-/g, '')}`, p_value: { mode: 'KEYS', consumer_key: 'ck_x', consumer_secret: 'cs_x', webhook_secret: WOO_HOOK, plugin_secret: WOO_PLUGIN }, p_hint: 'test', p_actor: null })
  await rpc('platform_secret_store', { p_key: 'meta.inbox_app', p_value: META, p_hint: 'test', p_actor: null })
  const storeMode = (mode) => db('POST', '/rest/v1/settings?on_conflict=merchant_id,key', { merchant_id: M1, key: 'storefront', value: { mode } }, { Prefer: 'resolution=merge-duplicates,return=representation' })
  step('setup: courier secret, two channels and the Meta app saved', true)

  const before = await snapshot()
  const refused = (r) => r.status === 401 || r.status === 403

  // --- couriers
  const pathaoBody = JSON.stringify({ consignment_id: 'DT0000FORGED', order_status: 'Delivered', event: 'order.delivered', updated_at: new Date().toISOString() })
  let r = await send('POST', `/functions/v1/courier-webhook?courier=${courier.id}`, { raw: pathaoBody })
  step('courier: no signature → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/courier-webhook?courier=${courier.id}`, { raw: pathaoBody, headers: { 'X-PATHAO-Signature': 'guess' } })
  step('courier: wrong secret → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/courier-webhook?courier=${courier.id}`, { raw: pathaoBody, headers: { 'X-PATHAO-Signature': `${COURIER_SECRET}x` } })
  step('courier: secret plus one character → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', '/functions/v1/courier-webhook?provider=pathao', { raw: pathaoBody, headers: { 'X-PATHAO-Signature': COURIER_SECRET } })
  step('courier: the store\'s secret on the provider-wide address (no platform secret set) → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', '/functions/v1/courier-webhook?provider=steadfast', { raw: '{"consignment_id":1,"status":"delivered"}', headers: { Authorization: 'Bearer anything' } })
  step('courier: Steadfast provider-wide with a made-up token → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/courier-webhook?courier=${randomUUID()}`, { raw: pathaoBody, headers: { 'X-PATHAO-Signature': COURIER_SECRET } })
  step('courier: an unknown courier address → 404', r.status === 404, JSON.stringify(r))
  r = await send('POST', `/functions/v1/courier-webhook?courier=${courier.id}`, { raw: JSON.stringify({ event: 'webhook_integration' }), headers: { 'X-PATHAO-Signature': COURIER_SECRET } })
  step('courier (control): the right secret is accepted (202)', r.status === 202, JSON.stringify(r))

  // --- payment notifications: the gateway is asked; unknown sessions are acknowledged and ignored.
  for (const [provider, field] of [['bkash', 'paymentID'], ['paystation', 'invoice_number'], ['sslcommerz', 'tran_id']]) {
    r = await send('POST', `/functions/v1/payment-webhook?provider=${provider}`, { body: { [field]: `FORGED-${randomUUID()}`, status: 'Completed', trxID: 'FAKE1', amount: '99999' } })
    step(`payment: forged ${provider} "paid" notice for an unknown payment → acknowledged, nothing recorded`, r.status === 200 && r.body?.status === 'unknown_payment', JSON.stringify(r))
  }
  r = await send('POST', '/functions/v1/payment-webhook?reconcile=1', { headers: { 'x-cron-secret': 'guess' } })
  step('payment: the reconcile job without the cron secret → 401', r.status === 401, JSON.stringify(r))

  // --- Shopify
  await storeMode('SHOPIFY')
  const shopBody = JSON.stringify({ id: 990001, cost: '1' })
  const shopHeaders = { 'x-shopify-topic': 'inventory_items/update', 'x-shopify-event-id': randomUUID() }
  r = await send('POST', `/functions/v1/channels/webhook/${shop.id}`, { raw: shopBody, headers: shopHeaders })
  step('Shopify: no HMAC → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${shop.id}`, { raw: shopBody, headers: { ...shopHeaders, 'x-shopify-hmac-sha256': hmac('wrong-secret', shopBody) } })
  step('Shopify: HMAC with another secret → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${shop.id}`, { raw: shopBody.replace('990001', '990002'), headers: { ...shopHeaders, 'x-shopify-hmac-sha256': hmac(SHOP_SECRET, shopBody) } })
  step('Shopify: body changed after signing → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${shop.id}`, { raw: JSON.stringify({}), headers: { 'x-shopify-topic': 'app/uninstalled', 'x-shopify-hmac-sha256': hmac('wrong-secret', '{}') } })
  step('Shopify: forged "app uninstalled" → 401 (the channel stays connected)', r.status === 401, JSON.stringify(r))
  r = await send('GET', `/functions/v1/channels/callback/shopify?state=${randomUUID()}&shop=forge-test.myshopify.com&code=x&hmac=x`)
  step('Shopify: a made-up connect callback changes nothing (error, no keys stored)', r.status >= 300 && r.status < 500, `${r.status} ${r.location ?? JSON.stringify(r.body)}`)

  // --- WooCommerce (webhooks and the plugin)
  await storeMode('WOOCOMMERCE')
  const wooBody = JSON.stringify({ id: 5, status: 'cancelled' })
  const wooHeaders = { 'x-wc-webhook-topic': 'order.updated', 'x-wc-webhook-delivery-id': '1' }
  r = await send('POST', `/functions/v1/channels/webhook/${woo.id}`, { raw: wooBody, headers: wooHeaders })
  step('WooCommerce: no signature → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${woo.id}`, { raw: wooBody, headers: { ...wooHeaders, 'x-wc-webhook-signature': hmac('wrong', wooBody) } })
  step('WooCommerce: signature with another secret → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${woo.id}`, { raw: wooBody, headers: { ...wooHeaders, 'x-wc-webhook-signature': hmac(WOO_PLUGIN, wooBody) } })
  step('WooCommerce: signed with the plugin secret instead of the webhook secret → 401', r.status === 401, JSON.stringify(r))
  const pluginBody = JSON.stringify({ type: 'order_status', data: { order_id: 5, status: 'cancelled' } })
  r = await send('POST', `/functions/v1/channels/plugin/${woo.id}`, { raw: pluginBody, headers: { 'x-ffc-event': 'order_status', 'x-ffc-timestamp': String(Math.floor(Date.now() / 1000)), 'x-ffc-signature': hmac('wrong', pluginBody, 'hex') } })
  step('WordPress plugin: wrong signature → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/plugin/${woo.id}`, { raw: pluginBody, headers: { 'x-ffc-event': 'order_status' } })
  step('WordPress plugin: no signature → 401', r.status === 401, JSON.stringify(r))
  const old = String(Math.floor(Date.now() / 1000) - 3600)
  r = await send('POST', `/functions/v1/channels/plugin/${woo.id}`, { raw: pluginBody, headers: { 'x-ffc-event': 'order_status', 'x-ffc-timestamp': old, 'x-ffc-signature': hmac(WOO_PLUGIN, `${old}.${pluginBody}`) } })
  step('WordPress plugin: correctly signed but an hour old (replay) → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', '/functions/v1/channels/callback/woocommerce', { body: { user_id: randomUUID(), consumer_key: 'ck_forged', consumer_secret: 'cs_forged', key_permissions: 'read_write' } })
  step('WooCommerce: made-up keys callback (unknown approval) → 400, keys not stored', r.status === 400, JSON.stringify(r))
  r = await send('POST', `/functions/v1/channels/webhook/${woo.id}`, { raw: JSON.stringify({ id: 1 }), headers: { 'x-wc-webhook-topic': 'product.updated', 'x-wc-webhook-delivery-id': '2', 'x-wc-webhook-signature': hmac(WOO_HOOK, JSON.stringify({ id: 1 })) } })
  step('WooCommerce (control): the right webhook signature is accepted', r.status === 200, JSON.stringify(r))
  await storeMode('SHOPIFY')
  r = await send('POST', `/functions/v1/channels/webhook/${shop.id}`, { raw: shopBody, headers: { ...shopHeaders, 'x-shopify-hmac-sha256': hmac(SHOP_SECRET, shopBody) } })
  step('Shopify (control): the right HMAC is accepted', r.status === 200, JSON.stringify(r))
  await storeMode('OWN')

  // --- Meta inbox webhook
  r = await send('GET', `/functions/v1/inbox?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=123`)
  step('Meta: subscribe with a wrong verify token → refused, no challenge echoed', refused(r) && String(r.body) !== '123', JSON.stringify(r))
  const metaBody = JSON.stringify({ object: 'page', entry: [{ id: '123', time: Date.now(), messaging: [{ sender: { id: '9' }, recipient: { id: '123' }, timestamp: Date.now(), message: { mid: 'm.forged', text: 'forged' } }] }] })
  r = await send('POST', '/functions/v1/inbox', { raw: metaBody, headers: { 'x-hub-signature-256': `sha256=${hmac('wrong', metaBody, 'hex')}` } })
  step('Meta: message event with a wrong signature → refused', refused(r), JSON.stringify(r))
  r = await send('POST', '/functions/v1/inbox', { raw: metaBody, headers: { 'x-hub-signature-256': 'sha256=' } })
  step('Meta: empty signature → refused', refused(r), JSON.stringify(r))
  r = await send('POST', '/functions/v1/inbox', { raw: metaBody })
  step('Meta: no signature (goes to the staff path) → refused', refused(r), JSON.stringify(r))
  r = await send('GET', `/functions/v1/inbox?hub.mode=subscribe&hub.verify_token=${META.verify_token}&hub.challenge=4242`)
  step('Meta (control): the right verify token gets the challenge back', r.status === 200 && String(r.body) === '4242', JSON.stringify(r))
  const emptyMeta = JSON.stringify({ object: 'page', entry: [] })
  r = await send('POST', '/functions/v1/inbox', { raw: emptyMeta, headers: { 'x-hub-signature-256': `sha256=${hmac(META.app_secret, emptyMeta, 'hex')}` } })
  step('Meta (control): a correctly signed event is accepted', r.status === 200, JSON.stringify(r))

  // --- Clerk webhook
  const clerkBody = JSON.stringify({ type: 'user.deleted', data: { id: 'user_victim', deleted: true } })
  r = await send('POST', '/functions/v1/clerk-webhook', { raw: clerkBody })
  step('Clerk: unsigned "user deleted" → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', '/functions/v1/clerk-webhook', { raw: clerkBody, headers: svix(clerkBody, { key: Buffer.from('another-key-of-32-bytes-length!!').toString('base64') }) })
  step('Clerk: signed with another key → 401', r.status === 401, JSON.stringify(r))
  r = await send('POST', '/functions/v1/clerk-webhook', { raw: clerkBody, headers: svix(clerkBody, { ts: Math.floor(Date.now() / 1000) - 3600 }) })
  step('Clerk: correctly signed but an hour old (replay) → 401', r.status === 401, JSON.stringify(r))
  const signed = svix(clerkBody)
  r = await send('POST', '/functions/v1/clerk-webhook', { raw: clerkBody.replace('user_victim', 'user_other'), headers: signed })
  step('Clerk: body changed after signing → 401', r.status === 401, JSON.stringify(r))
  const harmless = JSON.stringify({ type: 'session.created', data: {} })
  r = await send('POST', '/functions/v1/clerk-webhook', { raw: harmless, headers: svix(harmless) })
  step('Clerk (control): a correctly signed event is accepted', r.status === 200, JSON.stringify(r))

  const after = await snapshot()
  const diff = changed(before, after)
  const unreadable = Object.entries(before).filter(([, v]) => v.startsWith('unreadable')).map(([k]) => k)
  // The two accepted controls may record their own delivery id; nothing else may change.
  const expected = new Set(['channel_webhook_deliveries'])
  step('no business table changed by any forged request (only the controls\' own delivery ids)', diff.every((t) => expected.has(t)),
    `changed: ${diff.join(', ') || 'none'}; not readable here: ${unreadable.join(', ') || 'none'}`)
  r = (await db('GET', `/rest/v1/sales_channels?select=status&id=eq.${shop.id}`))[0]
  step('the Shopify channel is still connected after the forged "app uninstalled"', r?.status === 'CONNECTED', JSON.stringify(r))
}

main().catch((e) => step('run', false, e.stack ?? e)).finally(() => {
  writeFileSync(join(S, 'webhook-forgery-results.json'), JSON.stringify(results, null, 1))
  writeFileSync(join(S, 'webhook-forgery-dev.log'), devLog)
  const failed = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  dev.kill('SIGTERM')
  process.exit(failed ? 1 : 0)
})

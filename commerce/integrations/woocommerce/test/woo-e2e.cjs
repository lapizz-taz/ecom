// WooCommerce A–Z against the demo store (real WordPress + WooCommerce stand-in) and the local SaaS.
// See README.md in this folder. Run from a folder where playwright is installed:
//   WOO_E2E_OUT=/tmp/woo node integrations/woocommerce/test/woo-e2e.cjs
const { chromium } = require('playwright')
const path = require('path')
const { execSync } = require('child_process')
const crypto = require('crypto')
const SP = process.env.WOO_E2E_OUT || '/tmp/woo-e2e'
require('fs').mkdirSync(`${SP}/shots`, { recursive: true })
const STORE = process.env.WOO_STORE_URL || 'http://172.18.0.1:8090'
const APP = process.env.APP_URL || 'http://localhost:5173'
const ZIP = path.resolve(__dirname, '../../../public/downloads/fullfilio-connect.zip')
const sql = (q) => execSync(`PGPASSWORD=postgres psql -h localhost -p 54322 -U postgres -d postgres -tAc "${q.replace(/"/g, '\\"')}"`).toString().trim()
const wpsql = (q) => execSync('docker exec -i woo-db mariadb -uwordpress -pwp-pass wordpress -N', { input: q }).toString().trim()
// Raw output (no escaping) for JSON columns.
const wpjson = (q) => execSync('docker exec -i woo-db mariadb -uwordpress -pwp-pass wordpress -N -r', { input: q }).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// WordPress holds a 60 s lock while a page-load spawned cron runs; drop it so the test's run is not skipped.
const cron = async () => { wpsql(`delete from wp_options where option_name = '_transient_doing_cron'`); await fetch(`${STORE}/wp-cron.php`).catch(() => null); await sleep(1500) }
let failures = 0
const assert = (c, m) => { if (!c) { failures++; console.error('FAIL:', m) } else console.log('ok -', m) }
const shot = (p, n) => p.screenshot({ path: `${SP}/shots/woo-${n}.png` })
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(500) } throw new Error(`timeout: ${what}`) }

const linen = () => JSON.parse(wpjson(`select data from wp_standin_products where data like '%Linen Shirt%'`))
const stockOf = (vid) => linen().variations.find((v) => v.id === vid).stock_quantity
const wooOrderOf = (id) => JSON.parse(wpjson(`select data from wp_standin_orders where id = ${id}`))
const wooNotes = (id) => wpjson(`select data from wp_standin_notes where data like '%"order_id":${id},%'`).split('\n').filter(Boolean).map((l) => JSON.parse(l).note)

async function wpLogin(p) {
  await p.goto(`${STORE}/wp-login.php`)
  await p.fill('#user_login', 'admin'); await p.fill('#user_pass', 'admin-pass-123'); await p.click('#wp-submit')
  await p.waitForURL(/wp-admin/)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
  const errors = []
  try {
    // ------------------------------------------------------------------ 0. clean slate
    const t0 = sql('select now()')
    sql(`update sales_channels set status = 'DISCONNECTED' where platform = 'WOOCOMMERCE' and status <> 'DISCONNECTED'`)
    sql(`update sales_channels set settings = settings - 'plugin_config' where platform = 'WOOCOMMERCE'`)
    execSync('docker exec woo-wp rm -rf /var/www/html/wp-content/plugins/fullfilio-connect')
    wpsql(`update wp_options set option_value = 'a:0:{}' where option_name = 'active_plugins'`)
    wpsql(`delete from wp_options where option_name like 'ffc\\_%' or option_name like '_transient%ffc%'`)
    wpsql(`drop table if exists wp_ffc_outbox`)

    // ------------------------------------------------------------------ 1. install the plugin in WordPress (Upload Plugin)
    const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
    await wpLogin(owner)
    const already = wpsql(`select option_value from wp_options where option_name = 'active_plugins'`)
    if (!already.includes('fullfilio-connect')) {
      await owner.goto(`${STORE}/wp-admin/plugin-install.php?tab=upload`)
      await owner.setInputFiles('#pluginzip', ZIP)
      await owner.click('#install-plugin-submit')
      await owner.getByText(/Plugin installed successfully/).waitFor({ timeout: 30000 })
      await shot(owner, 'installed')
      await owner.getByRole('link', { name: 'Activate Plugin' }).click()
      await owner.getByText(/Plugin activated|Fullfilio Connect/).first().waitFor({ timeout: 15000 })
    }
    assert(wpsql(`select option_value from wp_options where option_name = 'active_plugins'`).includes('fullfilio-connect/fullfilio-connect.php'), 'plugin uploaded and activated through WordPress → Plugins → Upload')
    await owner.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect`)
    await owner.getByText('Connection').first().waitFor()
    assert((await owner.textContent('body')).includes('Sales channels → WooCommerce → Connect'), 'plugin page explains how to connect')

    // ------------------------------------------------------------------ 2. connect from the SaaS (download link, wizard, approval)
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const app = await staffCtx.newPage()
    app.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
    await app.goto(`${APP}/admin/login`)
    await app.fill('#email', 'owner@example.com'); await app.fill('#password', 'Password123!')
    await app.click('button[type=submit]'); await app.waitForURL((u) => !u.pathname.startsWith('/admin/login'))
    await app.goto(`${APP}/admin/channels`)
    const zip = await fetch(`${APP}/downloads/fullfilio-connect.zip`)
    assert(zip.ok && (await zip.arrayBuffer()).byteLength > 10000, 'plugin zip downloadable from the app')
    const card = app.locator('div', { hasText: 'Install our plugin, then approve' }).last()
    await card.getByRole('button', { name: /Connect|Add store/ }).click()
    await app.getByRole('link', { name: /Download plugin/ }).waitFor()
    await shot(app, 'wizard')
    await app.fill('#wc-url', STORE)
    await app.getByRole('button', { name: 'Continue to my site' }).click()
    // The store's WordPress asks to log in, then to approve.
    await app.waitForURL(/wp-login\.php|wc-auth/, { timeout: 30000 })
    if (app.url().includes('wp-login')) {
      await app.fill('#user_login', 'admin'); await app.fill('#user_pass', 'admin-pass-123'); await app.click('#wp-submit')
    }
    await app.locator('#wc-auth-approve').click()
    await app.waitForURL((u) => u.href.startsWith(APP), { timeout: 60000 })
    const ch = await waitFor(() => sql(`select id || '|' || status from sales_channels where platform = 'WOOCOMMERCE' and shop_domain = '${STORE}'`), 15000, 'channel')
    const [channelId, chStatus] = ch.split('|')
    assert(chStatus === 'CONNECTED', `store connected (${chStatus}) — ${sql(`select last_error from sales_channels where id = '${channelId}'`)}`)
    assert(sql(`select settings #>> '{plugin_pair,ok}' from sales_channels where id = '${channelId}'`) === 'true', 'plugin connected by itself after approval (pair)')
    const conn = wpsql(`select option_value from wp_options where option_name = 'ffc_connection'`)
    assert(conn.includes(channelId), 'plugin holds the store id and endpoint')
    const secret = /"secret";s:\d+:"([a-f0-9]+)"/.exec(conn)?.[1]
    const hooks = JSON.parse(sql(`select webhooks from sales_channels where id = '${channelId}'`))
    assert(hooks.length >= 2, `WooCommerce webhooks registered (${hooks.map((h) => h.topic).join(', ')})`)
    await cron()
    await waitFor(() => sql(`select settings #>> '{plugin,plugin_version}' from sales_channels where id = '${channelId}'`) === '1.1.0', 15000, 'heartbeat')
    assert(true, 'heartbeat arrived: plugin 1.1.0 reported its health')
    await app.goto(`${APP}/admin/channels`); await app.waitForTimeout(2500)
    await shot(app, 'channel-card')
    assert((await app.textContent('body')).includes('Plugin 1.1.0'), 'channel card shows the plugin version')

    // ------------------------------------------------------------------ 3. unfinished checkout (lead) with attribution
    const shirt = wpsql(`select id from wp_standin_products where data like '%Linen Shirt%'`)
    const stockStart = stockOf(101)
    const customer = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
    await customer.goto(`${STORE}/?utm_source=facebook&utm_medium=paid&utm_campaign=eid-sale&fbclid=AbC123`)
    await customer.goto(`${STORE}/?add-to-cart=${shirt}&variation_id=101&quantity=2`)
    await customer.waitForURL(/checkout/)
    const phone = `017${String(Date.now()).slice(-8)}`
    await customer.fill('#billing_first_name', 'Rina'); await customer.fill('#billing_last_name', 'Akter')
    await customer.fill('#billing_phone', phone); await customer.fill('#billing_address_1', 'House 9, Road 2, Mirpur')
    await customer.fill('#billing_city', 'Dhaka')
    await customer.waitForTimeout(3500)
    await cron()
    const lead = await waitFor(() => sql(`select external_id || '|' || item_count || '|' || total || '|' || status from shopify_abandoned_checkouts where channel_id = '${channelId}' and phone = '${phone}'`), 20000, 'lead')
    const [leadId, leadItems, leadTotal, leadStatus] = lead.split('|')
    assert(leadItems === '2' && Number(leadTotal) === 1360 && leadStatus === 'OPEN', `unfinished checkout captured with the cart from WooCommerce (2 items, ${leadTotal} tk)`)

    // ------------------------------------------------------------------ 4. place the order (COD): webhook + plugin event, imported once
    await customer.click('#place_order')
    await customer.getByText(/Your order has been received/).waitFor({ timeout: 30000 })
    const wooOrder = /Order #(\d+)/.exec(await customer.textContent('body'))[1]
    await cron(); await cron()
    const imported = await waitFor(() => sql(`select count(*) from orders where sales_channel_id = '${channelId}' and external_order_id = '${wooOrder}'`) === '1' ? '1' : null, 30000, 'order import')
    assert(imported === '1', `order #${wooOrder} imported once`)
    const ord = JSON.parse(sql(`select json_build_object('id', o.id, 'number', o.order_number, 'phone', o.customer_phone, 'total', o.total_amount, 'items', (select count(*) from order_items where order_id = o.id)) from orders o where o.sales_channel_id = '${channelId}' and o.external_order_id = '${wooOrder}'`))
    assert(ord.phone === phone && Number(ord.total) === 1360, `order ${ord.number}: phone and total match (${ord.total})`)
    const attr = sql(`select coalesce((select first_touch::text from order_attributions where order_id = '${ord.id}'), '')`)
    assert(attr.includes('facebook') && attr.includes('AbC123'), 'attribution from the plugin (utm_source=facebook, fbclid) saved on the order')
    await waitFor(() => sql(`select status from shopify_abandoned_checkouts where channel_id = '${channelId}' and external_id = '${leadId}'`) === 'RECOVERED', 15000, 'lead recovered')
    assert(true, 'the unfinished checkout is marked recovered')
    const pluginOrderEvents = sql(`select count(*) from channel_plugin_events where channel_id = '${channelId}' and type = 'order' and status = 'OK'`)
    const imports = sql(`select count(*) from channel_order_imports where channel_id = '${channelId}' and external_id = '${wooOrder}'`)
    assert(Number(pluginOrderEvents) >= 1 && imports === '1', `plugin order event handled (${pluginOrderEvents}) and the webhook too, still one import row`)
    assert(stockOf(101) === stockStart - 2, `WooCommerce took the 2 shirts off its stock at checkout (${stockStart} → ${stockOf(101)})`)
    const rejected = sql(`select coalesce(string_agg(type || ': ' || coalesce(detail ->> 'error', ''), '; '), '') from channel_plugin_events where channel_id = '${channelId}' and status = 'REJECTED' and created_at >= '${t0}'`)
    assert(rejected === '', `no plugin event refused (leads without page details included) ${rejected}`)

    // ------------------------------------------------------------------ 5. signatures, replays, duplicates
    const endpoint = `http://127.0.0.1:54321/functions/v1/channels/plugin/${channelId}`
    const send = async (type, data, eventId, { ts = Math.floor(Date.now() / 1000), key = secret } = {}) => {
      const body = JSON.stringify({ type, site: STORE, sent_at: new Date().toISOString(), data })
      const sig = crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('base64')
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FFC-Event': type, 'X-FFC-Event-Id': eventId, 'X-FFC-Timestamp': String(ts), 'X-FFC-Signature': sig }, body })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const replayId = wpsql(`select event_id from wp_ffc_outbox where type = 'order' and status = 'sent' order by id desc limit 1`)
    const replay = await send('order', { order_id: Number(wooOrder), event: 'created', status: 'processing' }, replayId)
    assert(replay.status === 200 && replay.body?.duplicate === true, 'a repeated plugin event (same id) is recognised and skipped')
    assert((await send('order', { order_id: Number(wooOrder), event: 'created', status: 'processing' }, crypto.randomUUID(), { key: 'f'.repeat(64) })).status === 401, 'wrong signature → 401')
    assert((await send('heartbeat', {}, crypto.randomUUID(), { ts: Math.floor(Date.now() / 1000) - 900 })).status === 401, 'request older than 5 minutes → 401')
    const fresh = await send('order', { order_id: Number(wooOrder), event: 'status', status: 'processing' }, crypto.randomUUID())
    assert(fresh.status === 200 && sql(`select count(*) from orders where sales_channel_id = '${channelId}' and external_order_id = '${wooOrder}'`) === '1', 'a new event for the same order does not create a second order')
    // WooCommerce re-delivering the same webhook delivery id.
    const hookRow = JSON.parse(wpsql(`select data from wp_standin_webhooks where data like '%order.created%' limit 1`))
    const delivery = wpsql(`select max(id) from wp_standin_deliveries where data like '%order.created%'`)
    const orderJson = JSON.stringify({ id: Number(wooOrder), status: 'processing' })
    const hookRes = await fetch(`http://127.0.0.1:54321/functions/v1/channels/webhook/${channelId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': 'order.created', 'X-WC-Webhook-Delivery-ID': delivery,
      'X-WC-Webhook-Signature': crypto.createHmac('sha256', hookRow.secret).update(orderJson).digest('base64') }, body: orderJson })
    assert((await hookRes.json()).duplicate === true, 'a re-delivered WooCommerce webhook is skipped')

    // ------------------------------------------------------------------ 6. Fullfilio unreachable → queued, retried, delivered once
    const conn0 = wpsql(`select option_value from wp_options where option_name = 'ffc_connection'`)
    // Same length, so the serialized option stays valid.
    wpsql(`update wp_options set option_value = replace(option_value, ':54321/functions/', ':54399/functions/') where option_name = 'ffc_connection'`)
    const broken = wpsql(`select option_value from wp_options where option_name = 'ffc_connection'`)
    assert(broken.includes(':54399/'), 'test: plugin pointed at an address where nothing answers')
    await customer.goto(`${STORE}/?add-to-cart=${shirt}&variation_id=102&quantity=1`)
    const phone2 = `018${String(Date.now()).slice(-8)}`
    await customer.fill('#billing_first_name', 'Karim'); await customer.fill('#billing_phone', phone2); await customer.fill('#billing_address_1', 'Road 5, Uttara'); await customer.fill('#billing_city', 'Dhaka')
    await customer.waitForTimeout(3500)
    await cron()
    const pend = wpsql(`select concat(status, '|', attempts) from wp_ffc_outbox where type = 'lead' order by id desc limit 1`)
    assert(pend.startsWith('pending|1'), `send failed and the event waits for a retry (${pend})`)
    wpsql(`update wp_options set option_value = '${conn0.replace(/'/g, "''").replace(/"/g, '\\"')}' where option_name = 'ffc_connection'`)
    // No new order and no heartbeat: the retry must be planned by itself for the backoff time (30 s).
    const planned = wpsql(`select option_value from wp_options where option_name = 'cron'`)
    assert(planned.includes('ffc_outbox_flush'), 'a retry run is planned in WP-Cron')
    await sleep(31000)
    await cron()
    const retried = wpsql(`select concat(status, '|', attempts, '|', next_at, '|', coalesce(last_error, ''), '|', utc_timestamp()) from wp_ffc_outbox where type = 'lead' order by id desc limit 1`)
    if (!retried.startsWith('sent')) console.log('DEBUG', retried, '\nCRON', wpsql(`select option_value from wp_options where option_name = 'cron'`).slice(0, 600), '\nCONN', wpsql(`select option_value from wp_options where option_name = 'ffc_connection'`).slice(0, 100))
    assert(retried.startsWith('sent'), `retried after Fullfilio came back: sent (${retried})`)
    await sleep(1000)
    assert(sql(`select count(*) from shopify_abandoned_checkouts where channel_id = '${channelId}' and phone = '${phone2}'`) === '1', 'the retried checkout arrived exactly once')

    // ------------------------------------------------------------------ 7. paused WooCommerce webhook is switched back on
    const hid = wpsql(`select id from wp_standin_webhooks where data like '%order.updated%' limit 1`)
    wpsql(`update wp_standin_webhooks set data = replace(data, '\\"status\\":\\"active\\"', '\\"status\\":\\"disabled\\"') where id = ${hid}`)
    await owner.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect`)
    await owner.getByRole('button', { name: 'Test connection' }).click()
    await owner.getByText(/Fullfilio answered/).waitFor({ timeout: 20000 })
    await waitFor(() => wpsql(`select data from wp_standin_webhooks where id = ${hid}`).includes('"status":"active"'), 20000, 'webhook re-enabled')
    assert(true, 'a webhook WooCommerce paused was switched back on from the heartbeat')
    await shot(owner, 'plugin-page')

    // ------------------------------------------------------------------ 8. the WooCommerce order follows ours (like Shopify)
    const cronSecret = (await import('fs')).readFileSync(process.env.FUNCTIONS_ENV_FILE || 'supabase/functions/.env', 'utf8').match(/CRON_SECRET=(.+)/)?.[1]?.trim()
    const run = () => fetch('http://127.0.0.1:54321/functions/v1/channels', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret }, body: JSON.stringify({ action: 'process_jobs' }) }).then((r) => r.json())
    const syncOf = (id) => JSON.parse(sql(`select coalesce((select json_build_object('status', store_status, 'error', store_status_error, 'restock', store_restock) from channel_order_sync where order_id = '${id}'), '{}'::json)`))
    // Sets our status (the triggers queue the store update) and runs the jobs.
    const move = async (id, status, extra = '') => { sql(`update orders set status = '${status}'${extra} where id = '${id}'`); await run(); await run() }
    const outboxBefore = wpsql(`select count(*) from wp_ffc_outbox where type = 'order'`)
    await move(ord.id, 'CONFIRMED')
    assert(wooOrderOf(wooOrder).status === 'confirmed' && syncOf(ord.id).status === 'confirmed', `confirmed here → "Confirmed" in WooCommerce (${wooOrderOf(wooOrder).status}, ${JSON.stringify(syncOf(ord.id))})`)
    assert(wooNotes(wooOrder).some((n) => /Fullfilio|Confirmed/.test(n)), 'WooCommerce order note says who changed it')
    await move(ord.id, 'SHIPPED', ', shipped_at = now()')
    assert(wooOrderOf(wooOrder).status === 'shipped', `shipped here → "Shipped" in WooCommerce (${wooOrderOf(wooOrder).status})`)
    await move(ord.id, 'DELIVERED', ', delivered_at = now()')
    assert(wooOrderOf(wooOrder).status === 'delivered', `delivered here → "Delivered" in WooCommerce (${wooOrderOf(wooOrder).status})`)
    sql(`update orders set updated_at = now() where id = '${ord.id}'`); await run()
    assert(wooNotes(wooOrder).filter((n) => /to Delivered/.test(n)).length === 1, 'set once: running the jobs again changes nothing')
    await sleep(1500); await cron()
    assert(wpsql(`select count(*) from wp_ffc_outbox where type = 'order'`) === outboxBefore, 'statuses set by Fullfilio are not sent back to Fullfilio')
    assert(sql(`select status from orders where id = '${ord.id}'`) === 'DELIVERED', 'the WooCommerce webhooks for these changes leave our order as it is')

    // A return: the 2 shirts come back in good condition → back in WooCommerce stock, once.
    await move(ord.id, 'RETURNING')
    assert(wooOrderOf(wooOrder).status === 'returning', `return in transit → "Return in transit" in WooCommerce (${wooOrderOf(wooOrder).status})`)
    const beforeReturn = stockOf(101)
    sql(`update order_items set returned_quantity = quantity where order_id = '${ord.id}'`)
    await move(ord.id, 'RETURNED')
    assert(wooOrderOf(wooOrder).status === 'returned', `returned → "Returned" in WooCommerce (${wooOrderOf(wooOrder).status})`)
    assert(stockOf(101) === beforeReturn + 2, `the 2 returned shirts are back in WooCommerce stock (${beforeReturn} → ${stockOf(101)})`)
    sql(`update orders set updated_at = now() where id = '${ord.id}'`); await run(); await run()
    assert(stockOf(101) === beforeReturn + 2, 'running the jobs again does not add them twice')
    assert(wooNotes(wooOrder).some((n) => /2 × .*put back in stock/.test(n)), 'WooCommerce order note lists what was put back')
    assert(sql(`select count(*) from order_status_history where order_id = '${ord.id}' and message like '%put back in WooCommerce stock%'`) === '1', 'our order history shows it once')

    // A partial delivery: 3 sent, 1 came back, later 1 more → 1 then 1 more put back, never more.
    const place = async (variation, qty, name) => {
      await customer.goto(`${STORE}/?add-to-cart=${shirt}&variation_id=${variation}&quantity=${qty}`)
      const ph = `013${String(Date.now()).slice(-8)}`
      await customer.fill('#billing_first_name', name); await customer.fill('#billing_phone', ph); await customer.fill('#billing_address_1', 'Road 3, Dhanmondi'); await customer.fill('#billing_city', 'Dhaka')
      await customer.click('#place_order'); await customer.getByText(/Your order has been received/).waitFor({ timeout: 30000 })
      const w = /Order #(\d+)/.exec(await customer.textContent('body'))[1]
      await cron()
      const id = await waitFor(() => sql(`select id from orders where sales_channel_id = '${channelId}' and external_order_id = '${w}'`), 20000, `order ${w}`)
      return { woo: w, id }
    }
    const before3 = stockOf(102)
    const o3 = await place(102, 3, 'Partial')
    const qty3 = Number(sql(`select sum(quantity) from order_items where order_id = '${o3.id}'`))
    const after3 = stockOf(102)
    assert(qty3 >= 3 && after3 === before3 - qty3, `${qty3} taken off at checkout (${before3} → ${after3})`)
    await move(o3.id, 'SHIPPED', ', shipped_at = now()')
    sql(`update order_items set returned_quantity = 1 where order_id = '${o3.id}'`)
    await move(o3.id, 'PARTIALLY_DELIVERED', ', delivered_at = now()')
    assert(wooOrderOf(o3.woo).status === 'partial-delivered', `partly delivered → "Partially delivered" in WooCommerce (${wooOrderOf(o3.woo).status})`)
    assert(stockOf(102) === after3 + 1, `the 1 that came back is in WooCommerce stock (${after3} → ${stockOf(102)})`)
    sql(`update order_items set returned_quantity = 2 where order_id = '${o3.id}'`); await run(); await run()
    assert(stockOf(102) === after3 + 2, `a second one back adds only that one (${stockOf(102)})`)

    // Cancelled here → cancelled in WooCommerce; WooCommerce puts its own stock back once.
    const before4 = stockOf(101)
    const o4 = await place(101, 1, 'Cancel')
    await move(o4.id, 'CANCELLED')
    assert(wooOrderOf(o4.woo).status === 'cancelled', `cancelled here → "Cancelled" in WooCommerce (${wooOrderOf(o4.woo).status})`)
    assert(stockOf(101) === before4, `WooCommerce put the cancelled item back once (${before4} → ${stockOf(101)})`)
    await move(o4.id, 'CONFIRMED')
    assert(wooOrderOf(o4.woo).status === 'cancelled' && /cancelled in WooCommerce/i.test(syncOf(o4.id).error ?? ''), `a cancelled WooCommerce order is not brought back (${syncOf(o4.id).error})`)
    sql(`update orders set status = 'CANCELLED' where id = '${o4.id}'`)

    // Fullfilio keeps the stock (stock sync on): WooCommerce must not put it back as well.
    sql(`update sales_channels set settings = settings || '{"inventory_sync": true}' where id = '${channelId}'`)
    const before5 = stockOf(101)
    const o5 = await place(101, 1, 'Synced')
    await move(o5.id, 'CANCELLED')
    assert(wooOrderOf(o5.woo).status === 'cancelled', 'cancelled in WooCommerce (stock sync on)')
    assert(stockOf(101) === before5 - 1, `WooCommerce did not put it back itself — Fullfilio sends the count (${before5} → ${stockOf(101)})`)
    assert(wooNotes(o5.woo).some((n) => /Fullfilio keeps this store/.test(n)), 'the WooCommerce order says why')
    sql(`update sales_channels set settings = settings || '{"inventory_sync": false}' where id = '${channelId}'`)
    await owner.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect`)
    await owner.getByText('Put back by').first().waitFor({ timeout: 15000 })
    const stockPage = await owner.textContent('body')
    assert(stockPage.includes('Put back by') && /Linen Shirt - M/.test(stockPage) && !/critical error/i.test(stockPage), 'plugin page lists the stock put back by Fullfilio')
    await shot(owner, 'plugin-stock')

    // ------------------------------------------------------------------ 9. store owner cancels in WooCommerce → cancelled here
    const keys = JSON.parse(wpsql(`select data from wp_standin_keys order by id desc limit 1`))
    const auth = 'Basic ' + Buffer.from(`${keys.consumer_key}:${keys.consumer_secret}`).toString('base64')
    // second order to cancel
    await customer.goto(`${STORE}/?add-to-cart=${shirt}&variation_id=101&quantity=1`)
    const phone3 = `019${String(Date.now()).slice(-8)}`
    await customer.fill('#billing_first_name', 'Nila'); await customer.fill('#billing_phone', phone3); await customer.fill('#billing_address_1', 'Road 7, Banani'); await customer.fill('#billing_city', 'Dhaka')
    await customer.click('#place_order'); await customer.getByText(/Your order has been received/).waitFor({ timeout: 30000 })
    const woo2 = /Order #(\d+)/.exec(await customer.textContent('body'))[1]
    await cron()
    await waitFor(() => sql(`select count(*) from orders where sales_channel_id = '${channelId}' and external_order_id = '${woo2}'`) === '1', 20000, 'order 2')
    await fetch(`${STORE}/wp-json/wc/v3/orders/${woo2}`, { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) })
    await cron()
    const st2 = await waitFor(() => { const s = sql(`select status from orders where sales_channel_id = '${channelId}' and external_order_id = '${woo2}'`); return s === 'CANCELLED' || s === 'PENDING_CANCEL' ? s : null }, 20000, 'cancel')
    assert(!!st2, `cancelled in WooCommerce → ${st2} here`)

    // ------------------------------------------------------------------ 10. order shield (block list)
    await app.goto(`${APP}/admin/store/sync?channel=${channelId}&tab=plugin`)
    await app.getByText('Fullfilio Connect plugin').first().waitFor({ timeout: 20000 })
    await app.getByRole('switch', { name: 'Order shield' }).click()
    await app.getByText(/Saved and sent to the store|Saved/).first().waitFor({ timeout: 20000 })
    await app.waitForTimeout(1000)
    await shot(app, 'plugin-tab')
    assert(wpsql(`select option_value from wp_options where option_name = 'ffc_config'`).includes('"shield";b:1'), 'switching the shield on reached the store at once')
    const blocked = `016${String(Date.now()).slice(-8)}`
    sql(`insert into order_blocks(kind, value, reason) values ('PHONE', '${blocked}', 'e2e test block')`)
    await customer.goto(`${STORE}/?add-to-cart=${shirt}&variation_id=101&quantity=1`)
    await customer.fill('#billing_first_name', 'Blocked'); await customer.fill('#billing_phone', blocked); await customer.fill('#billing_address_1', 'Somewhere 1'); await customer.fill('#billing_city', 'Dhaka')
    const before = wpsql('select count(*) from wp_standin_orders')
    await customer.click('#place_order')
    await customer.getByText(/unable to accept this order online/i).waitFor({ timeout: 20000 })
    assert(wpsql('select count(*) from wp_standin_orders') === before, 'block-listed number refused at the WooCommerce checkout (no order created)')
    await shot(customer, 'shield')
    sql(`update order_blocks set is_active = false where value = '${blocked}'`)

    const ordersBefore = sql(`select count(*) from orders where sales_channel_id = '${channelId}'`)
    // ------------------------------------------------------------------ 11. disconnect and reconnect
    await app.goto(`${APP}/admin/channels`)
    const wcard = app.locator('div.space-y-4', { hasText: STORE.replace('http://', '') }).first()
    await wcard.getByRole('button', { name: 'Disconnect' }).click()
    await app.getByRole('button', { name: 'Disconnect', exact: true }).last().click()
    await waitFor(() => sql(`select status from sales_channels where id = '${channelId}'`) === 'DISCONNECTED', 15000, 'disconnect')
    assert(!wpsql(`select count(*) from wp_options where option_name = 'ffc_connection'`).startsWith('1'), 'disconnecting forgets the plugin connection on the store')
    const gone = await send('heartbeat', {}, crypto.randomUUID())
    assert(gone.status === 410 || gone.status === 401, `events from a disconnected store are refused (${gone.status})`)
    await app.goto(`${APP}/admin/channels`)
    await app.locator('div', { hasText: 'Install our plugin, then approve' }).last().getByRole('button', { name: /Connect|Add store/ }).click()
    await app.fill('#wc-url', STORE)
    await app.getByRole('button', { name: 'Continue to my site' }).click()
    await app.locator('#wc-auth-approve').click()
    await app.waitForURL((u) => u.href.startsWith(APP), { timeout: 60000 })
    await waitFor(() => sql(`select status from sales_channels where id = '${channelId}'`) === 'CONNECTED', 15000, 'reconnect')
    assert(sql(`select settings #>> '{plugin_pair,ok}' from sales_channels where id = '${channelId}'`) === 'true' && wpsql(`select count(*) from wp_options where option_name = 'ffc_connection'`) === '1', 'reconnected: same store record, plugin paired again')
    await cron(); await sleep(1500)
    assert(sql(`select count(*) from orders where sales_channel_id = '${channelId}'`) === ordersBefore, `orders imported before the disconnect are kept, none duplicated (${ordersBefore})`)
  } catch (e) {
    failures++
    console.error('ERROR', e.message)
  } finally {
    if (errors.length) console.log('browser errors:', errors.join('\n'))
    await browser.close()
    console.log(failures ? `\n${failures} FAILED` : '\nALL WOOCOMMERCE CHECKS PASSED')
    process.exitCode = failures ? 1 : 0
  }
})()

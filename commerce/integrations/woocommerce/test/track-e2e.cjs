// Ad tracking + updates A–Z in a real WordPress (WooCommerce stand-in), store NOT connected to Fullfilio.
// Meta / TikTok / Google calls are captured by ffc-capture.php (nothing leaves the machine); browser
// pixel scripts are answered with an empty script. The update check talks to a local manifest server.
// Needs the test store running:
//   docker compose -f integrations/woocommerce/test/docker-compose.yml up -d
//   NODE_PATH=<dir with playwright> node integrations/woocommerce/test/track-e2e.cjs [out-dir]
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const { execSync, spawn } = require('child_process')
const crypto = require('crypto')
const { zipSync, unzipSync } = require(path.resolve(__dirname, '../../../node_modules/fflate'))
const STORE = process.env.WOO_STORE_URL || 'http://172.18.0.1:8090', OUT = process.argv[2] || '/tmp/woo-track'
fs.mkdirSync(OUT, { recursive: true })
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'inherit'] }).toString()
const act = (...a) => JSON.parse(sh(`docker exec woo-wp php /tmp/track-act.php ${a.join(' ')}`))
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
let ok = 0, bad = 0
const check = (c, m) => { if (c) { ok++; console.log('  PASS ', m) } else { bad++; console.log('  FAIL ', m) } }
const body = (x) => (typeof x.body === 'string' && x.body ? JSON.parse(x.body) : x.body)
const metaEvents = (cap) => cap.filter((x) => x.url.includes('graph.facebook.com') && x.method === 'POST').map((x) => body(x).data[0])
const purchases = (cap) => cap.filter((x) => (x.url.includes('graph.facebook.com') && x.method === 'POST' && body(x).data[0].event_name === 'Purchase')
  || (x.url.includes('tiktok') && body(x).data[0].event === 'CompletePayment') || (x.url.includes('/mp/collect') && !x.url.includes('/debug/')))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let server = null
process.on('exit', () => { if (server) server.kill() })

function setup() {
  // Install WordPress once (admin / admin-pass-123, like woo-e2e.cjs).
  sh(`curl --noproxy '*' -s -o /dev/null -X POST '${STORE}/wp-admin/install.php?step=2' --data-urlencode weblog_title='Demo Store' --data-urlencode user_name=admin --data-urlencode admin_password=admin-pass-123 --data-urlencode admin_password2=admin-pass-123 --data-urlencode pw_weak=1 --data-urlencode admin_email=admin@example.test --data-urlencode blog_public=0`)
  sh('docker exec woo-wp rm -rf /var/www/html/wp-content/plugins/fullfilio-connect /var/www/html/wp-content/mu-plugins/ffc-update-test.php')
  sh(`docker cp ${path.resolve(__dirname, '../fullfilio-connect')} woo-wp:/var/www/html/wp-content/plugins/fullfilio-connect`)
  sh(`docker cp ${path.join(__dirname, 'ffc-capture.php')} woo-wp:/var/www/html/wp-content/mu-plugins/ffc-capture.php`)
  sh(`docker cp ${path.join(__dirname, 'track-act.php')} woo-wp:/tmp/track-act.php`)
  sh('docker exec woo-wp chown -R www-data:www-data /var/www/html/wp-content/plugins')
  // Fresh orders for a clean run.
  sh(`docker exec -i woo-db mariadb -uwordpress -pwp-pass wordpress -e "delete from wp_standin_orders; delete from wp_standin_notes; alter table wp_standin_orders auto_increment=1;" 2>/dev/null || true`)
  console.log(sh('docker exec woo-wp php /tmp/track-act.php setup').trim())
}

async function checkout(ctx, label, phone, email) {
  const p = await ctx.newPage()
  await p.goto(`${STORE}/?add-to-cart=2&quantity=2`)
  await p.waitForSelector('#standin-checkout')
  await p.fill('#billing_first_name', label); await p.fill('#billing_last_name', 'Akter')
  await p.fill('#billing_phone', phone); await p.fill('#billing_email', email)
  await p.fill('#billing_address_1', 'House 12, Road 5, Dhanmondi'); await p.fill('#billing_city', 'Dhaka')
  await Promise.all([p.waitForURL(/order-received=\d+/), p.click('#place_order')])
  return { p, id: Number(new URL(p.url()).searchParams.get('order-received')) }
}
const queue = (p) => p.evaluate(() => ({
  fbq: (window.fbq && window.fbq.queue || []).map((a) => JSON.parse(JSON.stringify(Array.from(a)))),
  ttq: Array.isArray(window.ttq) ? window.ttq.map((a) => JSON.parse(JSON.stringify(Array.from(a)))) : [],
  dl: (window.dataLayer || []).map((a) => JSON.parse(JSON.stringify(Array.from(a)))),
}))

;(async () => {
  setup()
  // The test store is plain http; real stores are https (a secure context, needed for crypto.subtle).
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: [`--unsafely-treat-insecure-origin-as-secure=${STORE}`] })
  const ctx = await browser.newContext()
  await ctx.addCookies([
    { name: '_ttp', value: 'TTP_BROWSER_COOKIE', url: STORE },
    { name: '_ga', value: 'GA1.1.555666777.1760000000', url: STORE },
  ])
  const ext = []
  await ctx.route(/^https:\/\/(connect\.facebook\.net|analytics\.tiktok\.com|www\.googletagmanager\.com|www\.facebook\.com|www\.google-analytics\.com)\//, (r) => { ext.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }) })

  console.log('\n1. A visitor lands from an ad — browser pixel + server copy, one event id (store NOT connected)')
  const land = await ctx.newPage()
  await land.goto(`${STORE}/?fbclid=FBCLID_AD_1&ttclid=TTCLID_AD_1&gclid=GCLID_AD_1&utm_source=facebook&utm_campaign=eid`)
  await sleep(1500)
  const q = await queue(land)
  const cookies = Object.fromEntries((await ctx.cookies(STORE)).map((c) => [c.name, decodeURIComponent(c.value)]))
  const init = q.fbq.find((a) => a[0] === 'init')
  check(init && init[1] === '111222333', 'Meta Pixel initialised with the merchant pixel id')
  check(/^[a-z0-9]{20}$/.test(cookies.ffc_vid || ''), 'first-party visitor id cookie set')
  check(init && init[2] && init[2].external_id === sha(cookies.ffc_vid), 'pixel advanced matching carries the hashed visitor id')
  check(/^fb\.1\.\d{13}\.\d+$/.test(cookies._fbp || ''), '_fbp created in Meta\'s format')
  check(/^fb\.1\.\d{13}\.FBCLID_AD_1$/.test(cookies._fbc || ''), '_fbc created from the fbclid')
  const pv = q.fbq.find((a) => a[0] === 'track' && a[1] === 'PageView')
  check(pv && /^ffc_pa_[a-z0-9]{18}$/.test(pv[3].eventID), 'browser PageView has an event id')
  let cap = act('captured', 0)
  const spv = metaEvents(cap).find((e) => e.event_name === 'PageView')
  check(spv && pv && spv.event_id === pv[3].eventID, 'server PageView sent with the SAME event id (Meta de-duplicates)')
  check(spv && spv.user_data.fbp === cookies._fbp && spv.user_data.fbc === cookies._fbc && spv.user_data.external_id[0] === sha(cookies.ffc_vid), 'server PageView: same fbp, fbc and visitor id as the browser')
  check(spv && spv.user_data.client_ip_address && spv.user_data.client_user_agent, 'server PageView: IP + browser')
  check(!cap.some((x) => x.url.includes('tiktok')), 'no TikTok server PageView (TikTok counts page views from the pixel)')
  check(ext.some((u) => u.includes('analytics.tiktok.com') && u.includes('CTEST123')) && ext.some((u) => u.includes('googletagmanager.com/gtag/js')), 'TikTok + Google pixels loaded with the merchant ids')
  check(q.ttq.some((a) => a[0] === 'identify' && a[1].external_id === sha(cookies.ffc_vid)), 'TikTok identify with the hashed visitor id')
  check(decodeURIComponent((await ctx.cookies(STORE)).find((c) => c.name === 'ffc_attr').value).includes('FBCLID_AD_1'), 'click ids kept in the first-party attribution cookie')

  console.log('\n2. Checkout: InitiateCheckout in the browser and from the server, same id; Purchase held')
  act('clear', 0)
  const a = await checkout(ctx, 'Shanta', '01712-345678', 'Shanta@Example.com')
  cap = act('captured', 0)
  const ic = metaEvents(cap).find((e) => e.event_name === 'InitiateCheckout')
  const tic = cap.find((x) => x.url.includes('tiktok') && body(x).data[0].event === 'InitiateCheckout')
  check(ic && ic.custom_data.value === 960 && ic.custom_data.currency === 'BDT', 'server InitiateCheckout with the cart value from the store (960 BDT)')
  check(tic && ic && body(tic).data[0].event_id === ic.event_id, 'TikTok InitiateCheckout with the same event id')
  check(purchases(cap).length === 0, 'no Purchase yet (waiting for call confirmation)')
  const tq = await queue(a.p)
  check(!tq.fbq.some((x) => x[1] === 'Purchase'), 'no browser Purchase on the thank-you page')
  const m1 = act('meta', a.id)
  check(m1.attr && m1.attr.vid === cookies.ffc_vid && m1.attr.last_touch.params.fbclid === 'FBCLID_AD_1' && m1.attr.ttp === 'TTP_BROWSER_COOKIE' && m1.attr.ga_cid === '555666777.1760000000', `order #${a.id} keeps visitor id, click ids and cookies`)
  const b = await checkout(ctx, 'Rakib', '01811-000111', 'rakib@example.com')
  const c = await checkout(ctx, 'Mitu', '01911-222333', 'mitu@example.com')
  const dup = await checkout(ctx, 'Shanta', '+880 1712 345678', 'shanta2@example.com')

  console.log('\n3. Confirmed with a LOW receive rate (25% < 40%) → not counted, reason shown')
  act('clear', 0)
  const r1 = act('rest-confirm', b.id, 25)
  check(r1.http === 200 && r1.data.status === 'confirmed', `order #${b.id} confirmed through the plugin API (the call Fullfilio makes)`)
  check(purchases(act('captured', 0)).length === 0, 'not sent to Meta / TikTok / Google')
  check(/^Low receive rate: 25%/.test(act('meta-full', b.id).skip), 'reason saved on the order')

  console.log('\n4. Confirmed GOOD order (82%) → one Purchase each to Meta, TikTok and Google, all match keys')
  act('rest-confirm', a.id, 82)
  cap = purchases(act('captured', 0))
  check(cap.length === 3, `3 Purchases sent (got ${cap.length})`)
  const meta = cap.find((x) => x.url.includes('graph.facebook.com')), ev = body(meta).data[0], u = ev.user_data
  check(ev.event_id === `ffc_ord_${a.id}` && ev.custom_data.value === 960, 'Meta Purchase, order event id, value 960')
  check(u.em[0] === sha('shanta@example.com') && u.ph[0] === sha('8801712345678') && u.fn[0] === sha('shanta') && u.ct[0] === sha('dhaka') && u.country[0] === sha('bd'), 'Meta: email, phone, name, city, country hashed')
  check(u.external_id[0] === sha(cookies.ffc_vid) && u.fbp === cookies._fbp && u.fbc === cookies._fbc, 'Meta: the same visitor id, fbp and fbc as the browser')
  check(body(meta).access_token === 'META_TEST_TOKEN', 'Meta token only sent to Meta')
  const tt = cap.find((x) => x.url.includes('tiktok')), te = body(tt).data[0]
  check(tt.headers['Access-Token'] === 'TT_TEST_TOKEN' && te.event_id === `ffc_ord_${a.id}` && te.user.ttclid === 'TTCLID_AD_1' && te.user.ttp === 'TTP_BROWSER_COOKIE' && te.user.phone === sha('+8801712345678'), 'TikTok CompletePayment: ttclid, _ttp, E.164 phone, same id')
  const ga = cap.find((x) => x.url.includes('/mp/collect')), gb = body(ga)
  check(ga.url.includes('measurement_id=G-TEST') && gb.client_id === '555666777.1760000000' && gb.events[0].params.gclid === 'GCLID_AD_1', 'GA4 purchase joins the browser visitor and carries gclid')
  check(gb.user_data.sha256_email_address[0] === sha('shanta@example.com') && gb.user_data.sha256_phone_number[0] === sha('+8801712345678') && gb.user_data.address[0].country === 'BD', 'GA4 enhanced conversions: email, phone, address')

  console.log('\n5. The same customer orders again (duplicate) → counted once')
  act('clear', 0)
  act('rest-confirm', dup.id, 90)
  check(purchases(act('captured', 0)).length === 0, `order #${dup.id} (same phone, +880 format) not counted again`)
  check(/^Duplicate: the same customer's order #/.test(act('meta-full', dup.id).skip), 'reason: duplicate of the earlier order')
  act('rest-confirm', a.id, 82); act('manual', a.id, 'shipped'); act('manual', a.id, 'confirmed')
  check(purchases(act('captured', 0)).length === 0, 'the first order confirmed again → still no second Purchase')

  console.log('\n6. Not connected: the shop manager marks an order Confirmed by hand → sent')
  act('clear', 0)
  check(act('manual', c.id, 'confirmed').status === 'confirmed' && purchases(act('captured', 0)).length === 3, 'manual Confirmed sends to all three')

  console.log('\n7. "When the order is placed" (normal): Purchase at once — browser and server, one id')
  act('mode', 'placed'); act('clear', 0)
  const pl = await checkout(ctx, 'Nadia', '01511-777888', 'nadia@example.com')
  cap = purchases(act('captured', 0))
  check(cap.length === 3, `sent when placed (got ${cap.length})`)
  const pq = await queue(pl.p)
  const bp = pq.fbq.find((x) => x[0] === 'track' && x[1] === 'Purchase')
  check(bp && bp[3].eventID === `ffc_ord_${pl.id}`, 'browser Purchase on the thank-you page with the order\'s event id (de-duplicates with the server)')
  check(pq.ttq.some((x) => x[0] === 'track' && x[1] === 'CompletePayment' && x[3] && x[3].event_id === `ffc_ord_${pl.id}`), 'TikTok browser CompletePayment with the same id')
  check(pq.dl.some((x) => x[0] === 'event' && x[1] === 'purchase' && x[2].transaction_id === String(pl.id)), 'GA4 browser purchase with the same transaction id as the server')
  act('rest-confirm', pl.id, 90)
  check(purchases(act('captured', 0)).length === 3, 'a later confirm does not send it again')
  act('mode', 'confirmed')

  console.log('\n8. Admin: Ad tracking page (WordPress look), Save & test connection')
  const adm = await ctx.newPage()
  await adm.setViewportSize({ width: 1440, height: 1000 })
  await adm.goto(`${STORE}/wp-login.php`); await adm.fill('#user_login', 'admin'); await adm.fill('#user_pass', 'admin-pass-123')
  await Promise.all([adm.waitForURL(/wp-admin/), adm.click('#wp-submit')])
  await adm.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect&tab=tracking`)
  let html = await adm.content()
  check(html.includes('111222333') && html.includes('CTEST123') && html.includes('G-TEST'), 'saved pixel ids shown')
  check(!html.includes('META_TEST_TOKEN') && !html.includes('TT_TEST_TOKEN') && !html.includes('GA4_TEST_SECRET'), 'tokens and secrets are never printed into the page')
  check(/Not counted<\/span> <span class="ffc-muted">Low receive rate: 25%/.test(html) && /Not counted<\/span> <span class="ffc-muted">Duplicate/.test(html), 'recent purchases show what was held and why')
  check(/class="ffc-mq-n">10\.0|class="ffc-mq-n">[89]\.\d/.test(html), 'match quality estimate shown')
  const submit = async (sel) => { await Promise.all([adm.waitForEvent('framenavigated', (f) => f === adm.mainFrame()), adm.click(sel)]); await adm.waitForLoadState('load') }
  await submit('button[name="ffc_test"][value="meta"]')
  html = await adm.content()
  check(html.includes('Connected to pixel “Demo Store pixel”'), 'Meta: Save & test connection → "Connected to pixel"')
  check(/ffc-badge ffc-green[^>]*>.*Connected/.test(html), 'Meta card footer shows Connected')
  await submit('button[name="ffc_test"][value="tiktok"]')
  check((await adm.content()).includes('Add a test event code'), 'TikTok without a test code: asks for one (no real event is counted)')
  await submit('button[name="ffc_test"][value="google"]')
  check((await adm.content()).includes('validation server accepted'), 'Google: validation server accepted the purchase format')
  // A wrong Meta token is reported, not hidden.
  await adm.fill('input[name="meta_token"]', 'WRONG_TOKEN')
  await submit('button[name="ffc_test"][value="meta"]')
  check((await adm.content()).includes('Meta refused: Invalid OAuth access token'), 'wrong token → "Meta refused: …" with Meta\'s message')
  await adm.fill('input[name="meta_token"]', 'META_TEST_TOKEN')
  await submit('button[name="ffc_test"][value="meta"]')
  for (const t of ['tracking', 'overview', 'connect', 'protect', 'logs']) {
    await adm.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect&tab=${t}`)
    await adm.screenshot({ path: `${OUT}/plugin-${t}.png`, fullPage: true })
  }
  const mobile = await ctx.newPage()
  await mobile.setViewportSize({ width: 390, height: 844 })
  await mobile.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect&tab=tracking`)
  const wide = await mobile.evaluate(() => [...document.querySelectorAll('.ffc-wrap *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.ffc-scroll')).slice(0, 5).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)))
  check(!wide.length, 'phone width: nothing in the plugin page is wider than the screen' + (wide.length ? ' — ' + wide.join(' | ') : ''))
  await mobile.screenshot({ path: `${OUT}/plugin-tracking-phone.png`, fullPage: true })

  console.log('\n9. Updates: WordPress shows a new version; a tampered download is refused; Update now installs it')
  const dir = fs.mkdtempSync(path.join(OUT, 'upd-'))
  const files = {}
  const src = path.resolve(__dirname, '../fullfilio-connect')
  const walk = (d) => fs.readdirSync(d).sort().forEach((n) => { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : (files[`fullfilio-connect/${path.relative(src, p)}`] = new Uint8Array(fs.readFileSync(p))) })
  walk(src)
  const mainFile = 'fullfilio-connect/fullfilio-connect.php'
  files[mainFile] = new TextEncoder().encode(new TextDecoder().decode(files[mainFile]).replace(/Version:(\s+)1\.4\.0/, 'Version:$11.4.1').replace("'FFC_VERSION', '1.4.0'", "'FFC_VERSION', '1.4.1'"))
  const zip = Buffer.from(zipSync(files))
  fs.writeFileSync(path.join(dir, 'fullfilio-connect.zip'), zip)
  const manifest = (hash) => JSON.stringify({ version: '1.4.1', package: 'http://172.18.0.1:8080/fullfilio-connect.zip?v=1.4.1', sha256: hash, requires: '6.2', tested: '6.8', requires_php: '7.4', homepage: 'https://fullfilio.com', changelog: '<h4>1.4.1</h4><ul><li>Test release.</li></ul>' })
  const busy = await new Promise((r) => { const c = require('net').connect(8080, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true) }); c.on('error', () => r(false)) })
  if (busy) throw new Error('port 8080 is already in use — stop that server and run again')
  // A separate process serves the files (execSync below blocks this one).
  const serve = (m) => fs.writeFileSync(path.join(dir, 'fullfilio-connect.json'), m)
  serve(manifest(sha(zip)))
  server = spawn('python3', ['-m', 'http.server', '8080', '--bind', '0.0.0.0', '--directory', dir], { stdio: 'ignore' })
  await sleep(1200)
  sh(`docker cp ${path.join(__dirname, 'ffc-update-test.php')} woo-wp:/var/www/html/wp-content/mu-plugins/ffc-update-test.php`)
  const chk = act('update-check')
  check(chk.available && chk.available.version === '1.4.1' && chk.response && chk.response.new_version === '1.4.1', 'update check finds 1.4.1 and puts it in WordPress\'s update list')
  await adm.goto(`${STORE}/wp-admin/plugins.php`)
  html = await adm.content()
  check(/There is a new version of Fullfilio Connect for WooCommerce available/.test(html), 'Plugins screen: "There is a new version … available"')
  await adm.screenshot({ path: `${OUT}/plugins-update.png`, fullPage: false })
  await adm.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect`)
  check((await adm.content()).includes('Version 1.4.1 is available.'), 'plugin page: "Version 1.4.1 is available" with Update now')
  await adm.goto(`${STORE}/wp-admin/plugin-install.php?tab=plugin-information&plugin=fullfilio-connect`)
  check((await adm.content()).includes('Test release.'), '"View details" shows the changelog')
  serve(manifest('0'.repeat(64))); act('update-check')
  const badUp = act('upgrade')
  check(badUp.version === '1.4.0' && JSON.stringify(badUp).includes('did not match its published checksum'), 'a download that does not match its SHA-256 is refused (still 1.4.0)')
  serve(manifest(sha(zip))); act('update-check')
  await adm.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect`)
  await adm.click('a.ffc-btn.primary:has-text("Update now")')
  await adm.waitForSelector('text=/Plugin updated successfully|Updating Plugin/', { timeout: 60000 })
  await adm.waitForLoadState('networkidle')
  const after = sh("docker exec woo-wp grep -m1 'Version:' /var/www/html/wp-content/plugins/fullfilio-connect/fullfilio-connect.php")
  check(after.includes('1.4.1') && (await adm.content()).includes('Plugin updated successfully'), 'Update now → "Plugin updated successfully", 1.4.1 installed')
  server.kill()
  sh('docker exec woo-wp rm -f /var/www/html/wp-content/mu-plugins/ffc-update-test.php')

  console.log(`\n${ok} passed, ${bad} failed`)
  await browser.close()
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })

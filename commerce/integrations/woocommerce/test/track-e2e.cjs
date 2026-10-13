// Ad tracking A–Z in a real WordPress (WooCommerce stand-in), store NOT connected to Fullfilio.
// Meta / TikTok / Google server calls are captured by ffc-capture.php (nothing leaves the machine);
// browser pixel scripts are answered with an empty script. Needs the test store running:
//   docker compose -f integrations/woocommerce/test/docker-compose.yml up -d
//   NODE_PATH=<dir with playwright> node integrations/woocommerce/test/track-e2e.cjs [out-dir]
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const crypto = require('crypto')
const STORE = process.env.WOO_STORE_URL || 'http://172.18.0.1:8090', OUT = process.argv[2] || '/tmp/woo-track'
fs.mkdirSync(OUT, { recursive: true })
const act = (...a) => JSON.parse(execSync(`docker exec woo-wp php /tmp/track-act.php ${a.join(' ')}`).toString())

function setup() {
  const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'inherit'] }).toString()
  // Install WordPress once (admin / admin-pass-123, like woo-e2e.cjs).
  sh(`curl --noproxy '*' -s -o /dev/null -X POST '${STORE}/wp-admin/install.php?step=2' --data-urlencode weblog_title='Demo Store' --data-urlencode user_name=admin --data-urlencode admin_password=admin-pass-123 --data-urlencode admin_password2=admin-pass-123 --data-urlencode pw_weak=1 --data-urlencode admin_email=admin@example.test --data-urlencode blog_public=0`)
  const plugin = path.resolve(__dirname, '../fullfilio-connect')
  sh('docker exec woo-wp rm -rf /var/www/html/wp-content/plugins/fullfilio-connect')
  sh(`docker cp ${plugin} woo-wp:/var/www/html/wp-content/plugins/fullfilio-connect`)
  sh(`docker cp ${path.join(__dirname, 'ffc-capture.php')} woo-wp:/var/www/html/wp-content/mu-plugins/ffc-capture.php`)
  sh(`docker cp ${path.join(__dirname, 'track-act.php')} woo-wp:/tmp/track-act.php`)
  sh('docker exec woo-wp chown -R www-data:www-data /var/www/html/wp-content/plugins/fullfilio-connect')
  console.log(sh('docker exec woo-wp php /tmp/track-act.php setup').trim())
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
let ok = 0, bad = 0
const check = (c, m) => { if (c) { ok++; console.log('  PASS ', m) } else { bad++; console.log('  FAIL ', m) } }

async function checkout(ctx, label, phone, email) {
  const p = await ctx.newPage()
  await p.goto(`${STORE}/?add-to-cart=2&quantity=2`)
  await p.waitForSelector('#standin-checkout')
  await p.fill('#billing_first_name', label); await p.fill('#billing_last_name', 'Akter')
  await p.fill('#billing_phone', phone); await p.fill('#billing_email', email)
  await p.fill('#billing_address_1', 'House 12, Road 5, Dhanmondi'); await p.fill('#billing_city', 'Dhaka')
  await Promise.all([p.waitForURL(/order-received=\d+/), p.click('#place_order')])
  const id = Number(new URL(p.url()).searchParams.get('order-received'))
  return { p, id }
}

;(async () => {
  setup()
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
  const ctx = await browser.newContext()
  // A visitor who came from ads already has the platforms' browser cookies.
  await ctx.addCookies([
    { name: '_fbp', value: 'fb.1.1760000000000.123456789', url: STORE },
    { name: '_ttp', value: 'TTP_BROWSER_COOKIE', url: STORE },
    { name: '_ga', value: 'GA1.1.555666777.1760000000', url: STORE },
  ])
  // No real ad network: record what the browser would load, answer with an empty script.
  const ext = []
  await ctx.route(/^https:\/\/(connect\.facebook\.net|analytics\.tiktok\.com|www\.googletagmanager\.com|www\.facebook\.com|www\.google-analytics\.com)\//, (r) => { ext.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }) })
  act('clear', 0)

  console.log('\n1. Visitor lands from an ad (fbclid + ttclid + gclid), store NOT connected to Fullfilio')
  const land = await ctx.newPage()
  await land.goto(`${STORE}/?fbclid=FBCLID_AD_1&ttclid=TTCLID_AD_1&gclid=GCLID_AD_1&utm_source=facebook&utm_campaign=eid`)
  await land.waitForTimeout(800)
  const q = await land.evaluate(() => ({ fbq: (window.fbq && window.fbq.queue || []).map((a) => Array.from(a)), ttq: Array.isArray(window.ttq) ? window.ttq.map((a) => Array.from(a)) : null, dl: (window.dataLayer || []).map((a) => Array.from(a)) }))
  check(q.fbq.some((a) => a[0] === 'init' && a[1] === '111222333'), 'Meta Pixel initialised with the merchant pixel id')
  check(q.fbq.some((a) => a[0] === 'track' && a[1] === 'PageView'), 'Meta PageView fired')
  check(ext.some((u) => u.includes('analytics.tiktok.com') && u.includes('CTEST123')), 'TikTok pixel loaded with the merchant pixel id')
  check(ext.some((u) => u.includes('googletagmanager.com/gtag/js')), 'Google gtag loaded')
  check(q.dl.some((a) => a[0] === 'config' && (a[1] === 'G-TEST' || a[1] === 'AW-999')), 'gtag configured with the merchant ids')
  const attrCookie = (await ctx.cookies(STORE)).find((c) => c.name.startsWith('ffc'))
  check(!!attrCookie && decodeURIComponent(attrCookie.value).includes('FBCLID_AD_1'), 'click ids stored in the first-party attribution cookie')

  console.log('\n2. Customer orders (COD) — Purchase is held, nothing goes to the ad platforms yet')
  const a = await checkout(ctx, 'Shanta', '01712-345678', 'Shanta@Example.com')
  const icq = await a.p.evaluate(() => (window.fbq && window.fbq.queue || []).map((x) => Array.from(x)))
  check(!icq.some((x) => x[1] === 'Purchase'), 'no browser Purchase on the thank-you page (held until confirmed)')
  const m1 = act('meta', a.id)
  check(m1.attr && m1.attr.last_touch && m1.attr.last_touch.params.fbclid === 'FBCLID_AD_1' && m1.attr.last_touch.params.ttclid === 'TTCLID_AD_1' && m1.attr.last_touch.params.gclid === 'GCLID_AD_1', `order #${a.id} keeps fbclid / ttclid / gclid`)
  check(m1.attr && m1.attr.fbp === 'fb.1.1760000000000.123456789' && m1.attr.ttp === 'TTP_BROWSER_COOKIE' && m1.attr.ga_cid === '555666777.1760000000', 'order keeps _fbp, _ttp and the GA client id')
  check(act('captured', 0).length === 0, 'no server event sent at checkout (status processing)')
  const b = await checkout(ctx, 'Rakib', '01811-000111', 'rakib@example.com')
  const c = await checkout(ctx, 'Mitu', '01911-222333', 'mitu@example.com')

  console.log('\n3. Fullfilio confirms a LOW receive-rate order (25% < 40%) → held, not sent')
  const r1 = act('rest-confirm', b.id, 25)
  check(r1.http === 200 && r1.data.status === 'confirmed', `order #${b.id} confirmed through the plugin API`)
  check(Number(act('meta', b.id).rr) === 25, 'receive rate stored on the order')
  check(act('captured', 0).length === 0, 'low-rate order NOT sent to Meta / TikTok / Google')

  console.log('\n4. Fullfilio confirms a GOOD order (82%) → sent once to all three')
  const r2 = act('rest-confirm', a.id, 82)
  check(r2.http === 200 && r2.data.status === 'confirmed', `order #${a.id} confirmed through the plugin API`)
  const cap = act('captured', 0)
  check(cap.length === 3, `3 server events sent (got ${cap.length})`)
  const meta = cap.find((x) => x.url.includes('graph.facebook.com')), tt = cap.find((x) => x.url.includes('tiktok')), ga = cap.find((x) => x.url.includes('google-analytics'))
  const mb = meta && JSON.parse(meta.body), ev = mb && mb.data[0]
  check(meta && /graph\.facebook\.com\/v\d+\.0\/111222333\/events/.test(meta.url), 'Meta CAPI endpoint for the merchant pixel')
  check(ev && ev.event_name === 'Purchase' && ev.event_id === `ffc_ord_${a.id}` && ev.action_source === 'website', 'Meta Purchase with the stable event id')
  check(ev && ev.custom_data.value === 960 && ev.custom_data.currency === 'BDT', `Meta value = order total 960 BDT (2 × 450 + 60 delivery) (got ${ev && ev.custom_data.value})`)
  check(ev && ev.user_data.em[0] === sha('shanta@example.com') && ev.user_data.ph[0] === sha('8801712345678'), 'Meta email + phone hashed (SHA-256, normalised)')
  check(ev && ev.user_data.fbc && ev.user_data.fbc.endsWith('.FBCLID_AD_1') && ev.user_data.fbp === 'fb.1.1760000000000.123456789', 'Meta fbc from the click id + fbp cookie')
  check(ev && ev.user_data.client_ip_address && ev.user_data.client_user_agent, 'Meta has the buyer IP + user agent from checkout')
  check(mb && mb.access_token === 'META_TEST_TOKEN', 'Meta token sent only to Meta')
  const tb = tt && JSON.parse(tt.body), te = tb && tb.data[0]
  check(tt && tt.headers['Access-Token'] === 'TT_TEST_TOKEN' && te.event === 'CompletePayment' && te.event_id === `ffc_ord_${a.id}`, 'TikTok CompletePayment, token in header, same event id')
  check(te && te.user.ttclid === 'TTCLID_AD_1' && te.user.ttp === 'TTP_BROWSER_COOKIE' && te.user.email === sha('shanta@example.com'), 'TikTok ttclid + _ttp + hashed email')
  const gb = ga && JSON.parse(ga.body)
  check(ga && ga.url.includes('measurement_id=G-TEST') && ga.url.includes('api_secret=GA4_TEST_SECRET'), 'GA4 Measurement Protocol with the merchant ids')
  check(gb && gb.client_id === '555666777.1760000000' && gb.events[0].name === 'purchase' && gb.events[0].params.transaction_id && gb.events[0].params.gclid === 'GCLID_AD_1', 'GA4 purchase joins the browser visitor and carries gclid')
  check(gb && gb.user_data.sha256_email_address === sha('shanta@example.com') && gb.user_data.sha256_phone_number === sha('+8801712345678'), 'GA4 enhanced conversions: hashed email + E.164 phone')
  check(!!act('meta', a.id).sent, 'order marked as sent')

  console.log('\n5. The same confirm arrives again → no double count')
  act('rest-confirm', a.id, 82); act('manual', a.id, 'shipped'); act('manual', a.id, 'confirmed')
  check(act('captured', 0).length === 3, 'still 3 events (no duplicates)')

  console.log('\n6. Not connected to Fullfilio: the shop manager marks an order Confirmed by hand → sent')
  act('clear', 0)
  const r3 = act('manual', c.id, 'confirmed')
  const cap3 = act('captured', 0)
  check(r3.status === 'confirmed' && cap3.length === 3, `manual Confirmed sends to all three (got ${cap3.length})`)

  console.log('\n7. Admin: Fullfilio → Ad tracking tab')
  const adm = await ctx.newPage()
  await adm.goto(`${STORE}/wp-login.php`); await adm.fill('#user_login', 'admin'); await adm.fill('#user_pass', 'admin-pass-123')
  await Promise.all([adm.waitForURL(/wp-admin/), adm.click('#wp-submit')])
  await adm.goto(`${STORE}/wp-admin/admin.php?page=fullfilio-connect&tab=tracking`)
  const html = await adm.content()
  check(html.includes('111222333') && html.includes('CTEST123') && html.includes('G-TEST'), 'saved pixel ids shown')
  check(!html.includes('META_TEST_TOKEN') && !html.includes('TT_TEST_TOKEN') && !html.includes('GA4_TEST_SECRET'), 'tokens/secrets are not printed back into the page')
  check(html.includes(`#${a.id}`) || html.includes(`>${a.id}<`), 'recently sent list shows the order')
  await adm.setViewportSize({ width: 1280, height: 1600 })
  await adm.screenshot({ path: `${OUT}/ad-tracking-tab.png`, fullPage: true })

  console.log(`\n${ok} passed, ${bad} failed`)
  await browser.close()
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })

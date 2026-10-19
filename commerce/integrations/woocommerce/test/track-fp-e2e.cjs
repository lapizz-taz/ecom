// First-party tracking A–Z in a real browser: Browser → the store's own domain → (captured) Meta.
// The store is track-fp-server.php under PHP's web server; shop.test resolves to it. Meta's pixel
// script is answered with a small stand-in that records fbq calls — or blocked, like an ad blocker.
// Nothing leaves the machine.
//   NODE_PATH=/opt/node-tools/node_modules node integrations/woocommerce/test/track-fp-e2e.cjs
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const PORT = 8095
const HOST = `shop.test:${PORT}`
const STORE = `http://${HOST}`
let ok = 0, bad = 0
const check = (c, m) => { if (c) { ok++; console.log('  PASS ', m) } else { bad++; console.log('  FAIL ', m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A stand-in for fbevents.js: the real script replaces callMethod and sets its own version.
const FAKE_PIXEL = `(function(){var f=window.fbq;window.__fb=[];f.version='2.9.200';
  f.callMethod=function(){window.__fb.push([].slice.call(arguments))};
  (f.queue||[]).forEach(function(a){f.callMethod.apply(f,a)});f.queue=[]})()`

async function startStore(plain) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ffc-fp-'))
  const srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, path.join(__dirname, 'track-fp-server.php')], {
    env: { ...process.env, FFC_STATE: state, FFC_PLAIN: plain ? '1' : '' }, stdio: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/__summary`, { headers: { host: HOST } }); break } catch { await sleep(100) }
  }
  return { srv, state }
}
const json = async (p) => (await (await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { host: HOST } })).json())
const metaSent = async () => (await json('/__state')).sent.filter((x) => x.url.includes('graph.facebook.com')).map((x) => x.body.data[0])

async function browserCtx(browser, blocked) {
  const ctx = await browser.newContext()
  await ctx.route('https://connect.facebook.net/**', (r) => blocked ? r.abort('blockedbyclient') : r.fulfill({ contentType: 'application/javascript', body: FAKE_PIXEL }))
  return ctx
}
async function visit(ctx, url) {
  const p = await ctx.newPage()
  await p.goto(`${STORE}${url}`)
  await sleep(1900) // the store copy waits for the pixel (≤ 1.5 s) before it is sent
  const fb = await p.evaluate(() => window.__fb || [])
  return { p, fb }
}

;(async () => {
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP shop.test 127.0.0.1`] })
  let store = await startStore(false)
  try {
    const st = await json('/__state')
    console.log(`Route: ${st.endpoint}`)
    // (Node's fetch cannot set Host, so the store names itself 127.0.0.1 here; the browser uses shop.test.)
    check(/^\/[a-z][a-z0-9]{7}\/$/.test(new URL(st.endpoint).pathname), 'the route is a random path on the store\'s own domain')

    console.log('\n1. Pixel loads — product page from a Facebook ad click')
    const ctx = await browserCtx(browser, false)
    const { p, fb } = await visit(ctx, '/product/?fbclid=IwAR0abcDEF123_xyz')
    const browserIds = fb.filter((c) => c[0] === 'track').map((c) => [c[1], c[3] && c[3].eventID])
    let sent = await metaSent()
    check(browserIds.length === 2 && sent.length === 2, `browser pixel fired ${browserIds.length} events, the store sent ${sent.length} to Meta`)
    check(browserIds.every(([n, id]) => sent.some((e) => e.event_name === n && e.event_id === id)), 'every server event has the same name + event id as the pixel event (Meta counts each once)')
    const cookies = await ctx.cookies(STORE)
    const ck = (n) => cookies.find((c) => c.name === n)
    check(ck('_fbp') && /^fb\.1\.\d{13}\.\d+$/.test(ck('_fbp').value), '_fbp in Meta\'s format')
    check(ck('_fbp') && ck('_fbp').domain === '.shop.test', '_fbp on the domain Meta\'s pixel uses (.shop.test)')
    check(ck('_fbp') && ck('_fbp').expires > Date.now() / 1000 + 170 * 86400, '_fbp renewed by the store\'s server for 180 days (not a 7-day script cookie)')
    check(ck('_fbc') && /^fb\.1\.\d{13}\.IwAR0abcDEF123_xyz$/.test(ck('_fbc').value), '_fbc built from the ad click id')
    check(ck('ffc_vid') && ck('ffc_vid').expires > Date.now() / 1000 + 390 * 86400, 'visitor id kept for 395 days')
    check(sent.every((e) => e.user_data.fbp === ck('_fbp').value && e.user_data.fbc === ck('_fbc').value), 'server events carry the same _fbp and _fbc as the browser')
    check(sent.every((e) => Array.isArray(e.user_data.external_id) && e.user_data.external_id.length > 0), 'server events carry the hashed visitor id')
    const vc = sent.find((e) => e.event_name === 'ViewContent')
    check(vc && vc.custom_data.value === 700 && vc.custom_data.content_ids[0] === 'SKU-7', 'ViewContent value and product come from the store, not the browser')

    console.log('\n2. Add to cart (form posts and leaves the page) — sent on the way out')
    await Promise.all([p.waitForNavigation(), p.click('button[name="add-to-cart"]')])
    await sleep(600)
    sent = await metaSent()
    const atc = sent.filter((e) => e.event_name === 'AddToCart')
    check(atc.length === 1 && atc[0].custom_data.value === 1400, 'AddToCart reached Meta once, value 2 × 700 from the store')

    console.log('\n3. Checkout twice with the same cart — InitiateCheckout counts once')
    const c1 = await visit(ctx, '/checkout/')
    await c1.p.reload(); await sleep(1900)
    const fbIc = (await c1.p.evaluate(() => window.__fb || [])).filter((c) => c[1] === 'InitiateCheckout').length
    sent = await metaSent()
    check(sent.filter((e) => e.event_name === 'InitiateCheckout').length === 1 && c1.fb.filter((c) => c[1] === 'InitiateCheckout').length === 1 && fbIc === 0, 'one InitiateCheckout (pixel and server) for the same cart, none on reload')
    await visit(ctx, '/checkout/?qty=3')
    sent = await metaSent()
    check(sent.filter((e) => e.event_name === 'InitiateCheckout').length === 2, 'a changed cart is a new checkout')

    console.log('\n4. Thank-you page reloaded — the browser Purchase fires once')
    const t1 = await visit(ctx, '/thanks/')
    await t1.p.reload(); await sleep(500)
    const again = await t1.p.evaluate(() => window.__fb || [])
    check(t1.fb.filter((c) => c[1] === 'Purchase' && c[3].eventID === 'ffc_ord_42').length === 1 && again.filter((c) => c[1] === 'Purchase').length === 0, 'Purchase with the order\'s id once; nothing on reload')

    console.log('\n5. Ad blocker stops the pixel — the store\'s own domain still delivers')
    const before = (await metaSent()).length
    const blk = await browserCtx(browser, true)
    const b = await visit(blk, '/product/')
    sent = await metaSent()
    check(b.fb.length === 0, 'the browser pixel sent nothing')
    check(sent.length - before === 2 && sent.slice(before).map((e) => e.event_name).join() === 'PageView,ViewContent', 'PageView + ViewContent reached Meta through the store')
    const bc = await blk.cookies(STORE)
    check(bc.some((c) => c.name === '_fbp' && c.expires > Date.now() / 1000 + 170 * 86400), 'the visitor still gets a long-lived _fbp from the store')

    console.log('\n6. A replayed request is refused — each event id once')
    const replayId = sent[sent.length - 1].event_id
    const form = new URLSearchParams({ ev: 'ViewContent', id: replayId, url: `${STORE}/product/`, pid: '7', qty: '1', px: '1' })
    const r = await (await fetch(`http://127.0.0.1:${PORT}${new URL(st.endpoint).pathname}`, { method: 'POST', body: form, headers: { host: HOST } })).json()
    await sleep(300)
    check(r.ok && r.dup === 1 && (await metaSent()).length === sent.length, 'the same event id again is answered but not sent')
    const other = await (await fetch(`http://127.0.0.1:${PORT}/some-page/`, { method: 'POST', body: form, headers: { host: HOST } })).text()
    check(other === 'not the route', 'other addresses are not the route')
    const ping = await (await fetch(`http://127.0.0.1:${PORT}${new URL(st.endpoint).pathname}`, { method: 'POST', body: new URLSearchParams({ ev: 'ping' }), headers: { host: HOST } })).json()
    check(ping.route === 1 && (await metaSent()).length === sent.length, 'the admin\'s route check answers and sends nothing')

    console.log('\n7. A page cached before 1.6.0 still asks for ffc-track.js')
    const n0 = (await metaSent()).length
    const old = await visit(ctx, '/old-product/')
    check(old.fb.filter((c) => c[0] === 'track').length === 2 && (await metaSent()).length - n0 === 2, 'the old file loads the new script: pixel and server events as before')

    console.log('\n8. Coverage report')
    const s = await json('/__summary')
    console.log(`   events ${s.r}, pixel state known ${s.k}, pixel blocked ${s.b}, delivered ${s.ok}, refused ${s.f} → pixel alone ${s.pixel_pct}%, your server ${s.coverage_pct}%`)
    check(s.r === (await metaSent()).length && s.b === 2 && s.coverage_pct === 100, 'every event counted; the 2 blocked ones show; 100% delivered by the server')
    check(s.pixel_pct !== null && s.pixel_pct < 100, 'the browser pixel alone missed events')
    await ctx.close(); await blk.close()
  } finally {
    store.srv.kill()
  }

  console.log('\n9. Plain permalinks — the route is /?<path>=1')
  await sleep(300)
  store = await startStore(true)
  try {
    const st = await json('/__state')
    check(/^\/\?[a-z][a-z0-9]{7}=1$/.test(new URL(st.endpoint).pathname + new URL(st.endpoint).search), `route ${st.endpoint}`)
    const ctx = await browserCtx(browser, false)
    await visit(ctx, '/product/')
    check((await metaSent()).length === 2, 'events arrive through the query-string route')
    await ctx.close()
  } finally {
    store.srv.kill()
  }
  await browser.close()
  console.log(`\n${ok} passed, ${bad} failed`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })

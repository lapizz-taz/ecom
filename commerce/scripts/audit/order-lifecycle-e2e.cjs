// Audit round 3, pass 3: the order lifecycle, stock, profit & loss, the Call role and a second
// store, against the real Worker (site + backend functions + Cloudflare database) on this machine.
// Never deployed; no outside service is called.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/order-lifecycle-e2e.cjs
// Needs Chromium (PLAYWRIGHT_BROWSERS_PATH) and worker/db/generated/seed.sql (npm run db:seed).
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createClient } = require(join(__dirname, '../../node_modules/@supabase/supabase-js'))
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const ROOT = join(__dirname, '../..')
const S = __dirname
const port = 8000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const SERVICE = 'e2e-service-key-not-a-secret'
const ANON = 'sb_publishable_e2e'
const M1 = '00000000-0000-4000-8000-000000000001'
const persist = mkdtempSync(join(tmpdir(), 'audit-r3-'))

const dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'),
  ['dev', '--local', '--config', join(S, 'wrangler.jsonc'), '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist,
    '--var', `PLATFORM_URL:${base}`, '--var', `FUNCTIONS_URL:${base}/functions/v1`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
let devLog = ''
dev.stdout.on('data', (d) => { devLog += d })
dev.stderr.on('data', (d) => { devLog += d })

const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail).slice(0, 900) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 900)}`}`)
}
async function call(method, path, { body, key = SERVICE, token, merchant = M1, prefer } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token ?? key}` }
  if (merchant) headers['x-merchant-id'] = merchant
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json }
}
async function sessionFor(email) {
  const server = createClient(base, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const link = await server.auth.admin.generateLink({ type: 'magiclink', email })
  const client = createClient(base, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const opened = await client.auth.verifyOtp({ type: 'magiclink', token_hash: link.data?.properties?.hashed_token })
  return { session: opened.data?.session, client, error: link.error ?? opened.error }
}
async function staff(email, role, merchant = M1) {
  const user = await call('POST', '/auth/v1/admin/users', { merchant, body: { email, email_confirm: true, user_metadata: { full_name: email.split('@')[0] }, app_metadata: { clerk_user_id: `user_${email.split('@')[0]}` } } })
  const set = await call('POST', '/rest/v1/rpc/admin_set_user_role', { merchant, body: { p_user_id: user.body?.id, p_role_code: role, p_is_active: true } })
  const s = await sessionFor(email)
  return { ...s, id: user.body?.id, setError: set.status >= 300 ? set.body : null }
}
async function place(variantId, name, phone, key, quantity = 1) {
  const res = await fetch(`${base}/functions/v1/checkout`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}`, 'x-merchant-id': M1 },
    body: JSON.stringify({ action: 'place', customer: { full_name: name, phone }, shipping: { address: 'House 7, Road 3, Dhanmondi', district: 'Dhaka' },
      items: [{ variant_id: variantId, quantity }], payment_method: 'COD', idempotency_key: key }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
async function settle(page, re, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (re.test(await text(page))) return true
    await page.waitForTimeout(500)
  }
  return false
}
const inv = async (vid) => (await call('GET', `/rest/v1/inventory?variant_id=eq.${vid}&select=on_hand,reserved,available`)).body?.[0]
const order = async (id) => (await call('GET', `/rest/v1/orders?id=eq.${id}&select=id,order_number,status,subtotal,delivery_charge,total_amount,cost_total`)).body?.[0]

;(async () => {
  let browser
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const cur = await call('GET', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront&select=value`)
    await call('PATCH', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront`, { body: { value: { ...(cur.body?.[0]?.value ?? {}), mode: 'OWN' } } })
    const owner = await staff('r3-owner@example.com', 'OWNER')
    step('owner signed in', Boolean(owner.session), JSON.stringify(owner.error ?? owner.setError))

    // --- catalogue ---------------------------------------------------------------------------
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Audit Tee', slug: 'audit-tee', status: 'ACTIVE', price: 1000, cost_price: 400, track_inventory: true, requires_production: false,
      variants: [{ sku: 'AT1', title: 'Default', initial_stock: 10 }] } })
    const vid = (await call('GET', `/rest/v1/product_variants?product_id=eq.${product.data?.id}&select=id`)).body?.[0]?.id
    const i0 = await inv(vid)
    step('product saved with 10 in stock', Boolean(vid) && i0?.on_hand === 10 && i0?.reserved === 0, JSON.stringify([product.error, i0]))

    // --- storefront order, and the same request sent twice --------------------------------------
    const p1 = await place(vid, 'Karim Mia', '01812345678', 'r3-order-1-000001', 2)
    const p1again = await place(vid, 'Karim Mia', '01812345678', 'r3-order-1-000001', 2)
    const all1 = (await call('GET', `/rest/v1/orders?merchant_id=eq.${M1}&select=id`)).body ?? []
    const o1id = p1.body?.order?.id
    const i1 = await inv(vid)
    step('storefront order placed; the same request again makes no second order and reserves stock once',
      (p1.status === 200 || p1.status === 201) && all1.length === 1 && p1again.body?.order?.id === o1id && i1?.reserved === 2 && i1?.on_hand === 10,
      JSON.stringify({ first: p1.status, again: p1again.status, againId: p1again.body?.order?.id, orders: all1.length, i1 }))
    const o1 = await order(o1id)
    step('order money: subtotal 2 × 1000, total = subtotal + delivery', Number(o1?.subtotal) === 2000 && Number(o1?.total_amount) === 2000 + Number(o1?.delivery_charge),
      JSON.stringify(o1))

    // --- lifecycle to delivered --------------------------------------------------------------------
    const courier = await call('POST', '/rest/v1/couriers', { body: { name: 'Pathao', provider: 'pathao', api_enabled: false, default_shipping_cost: 70 }, prefer: 'return=representation' })
    const courierId = courier.body?.[0]?.id
    const moves = []
    for (const to of ['CONFIRMED', 'PROCESSING', 'PACKING']) moves.push([to, (await owner.client.rpc('transition_order_status', { p_order_id: o1id, p_to: to })).error])
    moves.push(['assign', (await owner.client.rpc('assign_courier', { p_order_id: o1id, p_courier_id: courierId, p_tracking_number: 'R3TRK0001', p_shipping_cost: 70 })).error])
    for (const to of ['READY_TO_SHIP', 'SHIPPED']) {
      const st = (await order(o1id))?.status
      if (st !== to) moves.push([to, (await owner.client.rpc('transition_order_status', { p_order_id: o1id, p_to: to })).error])
    }
    const iShip = await inv(vid)
    moves.push(['DELIVERED', (await owner.client.rpc('transition_order_status', { p_order_id: o1id, p_to: 'DELIVERED' })).error])
    const o1d = await order(o1id)
    const iDel = await inv(vid)
    step('lifecycle Pending → Confirmed → Processing → Packing → courier → Ready → Shipped → Delivered, each saved',
      o1d?.status === 'DELIVERED' && moves.every(([, e]) => !e), JSON.stringify({ moves: moves.filter(([, e]) => e), status: o1d?.status }))
    step('stock: 2 leave the shelf once (on hand 10 → 8, reserved back to 0), not twice', iDel?.on_hand === 8 && iDel?.reserved === 0,
      JSON.stringify({ atShip: iShip, delivered: iDel }))
    const skip = await owner.client.rpc('transition_order_status', { p_order_id: o1id, p_to: 'PENDING' })
    step('a delivered order cannot be moved back to Pending', Boolean(skip.error), JSON.stringify(skip.error))
    const hist = (await call('GET', `/rest/v1/order_status_history?order_id=eq.${o1id}&select=to_status`)).body ?? []
    step('every status change is in the order history', hist.length >= 6, JSON.stringify(hist.map((h) => h.to_status)))

    // --- a failed delivery that comes back -----------------------------------------------------------
    const p2 = await place(vid, 'Rahim Uddin', '01712345678', 'r3-order-2-000001', 1)
    const o2id = p2.body?.order?.id
    for (const to of ['CONFIRMED', 'PROCESSING', 'PACKING']) await owner.client.rpc('transition_order_status', { p_order_id: o2id, p_to: to })
    await owner.client.rpc('assign_courier', { p_order_id: o2id, p_courier_id: courierId, p_tracking_number: 'R3TRK0002', p_shipping_cost: 70 })
    for (const to of ['READY_TO_SHIP', 'SHIPPED']) if ((await order(o2id))?.status !== to) await owner.client.rpc('transition_order_status', { p_order_id: o2id, p_to: to })
    const iShip2 = await inv(vid)
    const failed = await owner.client.rpc('transition_order_status', { p_order_id: o2id, p_to: 'FAILED_DELIVERY', p_note: 'Customer not reachable (audit)' })
    const back = await owner.client.rpc('transition_order_status', { p_order_id: o2id, p_to: 'RETURNING' })
    const items2 = (await call('GET', `/rest/v1/order_items?order_id=eq.${o2id}&select=id,quantity`)).body ?? []
    const ret = await owner.client.rpc('process_order_return', { p_order_id: o2id, p_items: items2.map((i) => ({ order_item_id: i.id, quantity: i.quantity, condition: 'RESTOCK' })), p_note: 'Back in good condition (audit)' })
    const o2r = await order(o2id)
    const iRet = await inv(vid)
    step('failed delivery → coming back → received: order Returned and the unit is back on the shelf (once)',
      !failed.error && !back.error && !ret.error && o2r?.status === 'RETURNED' && iRet?.on_hand === iShip2?.on_hand + 1 && iRet?.reserved === 0,
      JSON.stringify({ failed: failed.error, back: back.error, ret: ret.error, status: o2r?.status, shipped: iShip2, returned: iRet }))
    const ret2 = await owner.client.rpc('process_order_return', { p_order_id: o2id, p_items: items2.map((i) => ({ order_item_id: i.id, quantity: i.quantity, condition: 'RESTOCK' })) })
    step('receiving the same return again adds no stock', (await inv(vid))?.on_hand === iRet?.on_hand, JSON.stringify({ err: ret2.error, after: await inv(vid) }))

    // --- cancel releases the reservation -------------------------------------------------------------
    const p3 = await place(vid, 'Salma Akter', '01912345678', 'r3-order-3-000001', 3)
    const o3id = p3.body?.order?.id
    const iRes = await inv(vid)
    const noReason = await owner.client.rpc('transition_order_status', { p_order_id: o3id, p_to: 'CANCELLED' })
    const cancel = await owner.client.rpc('transition_order_status', { p_order_id: o3id, p_to: 'CANCELLED', p_note: 'Customer changed mind (audit)' })
    const iCan = await inv(vid)
    step('cancel needs a reason; with one, the 3 reserved units are released', Boolean(noReason.error) && !cancel.error && iCan?.reserved === iRes?.reserved - 3 && iCan?.on_hand === iRes?.on_hand,
      JSON.stringify({ noReason: noReason.error?.message, cancel: cancel.error, before: iRes, after: iCan }))

    // --- profit & loss, checked by hand ----------------------------------------------------------------
    // The store's own date (money is booked by the store's day, Asia/Dhaka), not the UTC date: they differ after 18:00 UTC.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const pl = await owner.client.rpc('report_profit_loss', { p_from: today, p_to: today })
    const d = pl.data ?? {}
    // Independently: only the delivered order counts. 2 × 1000 product revenue, cost 2 × 400.
    step('P&L product revenue = 2,000 (delivered only; returned and cancelled excluded)', Number(d.product_revenue) === 2000, JSON.stringify(d))
    step('P&L cost of goods = 800 (2 × 400)', Number(d.cogs) === 800, JSON.stringify({ cogs: d.cogs }))
    step('P&L gross profit = net revenue − cost of goods', Math.abs(Number(d.gross_profit) - (Number(d.net_revenue) - Number(d.cogs))) < 0.01,
      JSON.stringify({ net_revenue: d.net_revenue, cogs: d.cogs, gross_profit: d.gross_profit }))
    step('P&L net profit = gross profit − operating expenses + other income', Math.abs(Number(d.net_profit) - (Number(d.gross_profit) - Number(d.operating_expenses) + Number(d.other_income))) < 0.01,
      JSON.stringify({ gross: d.gross_profit, opex: d.operating_expenses, other: d.other_income, net: d.net_profit }))
    writeFileSync(join(S, 'pl.json'), JSON.stringify(d, null, 2))

    // --- the Call role -----------------------------------------------------------------------------------
    const caller = await staff('r3-caller@example.com', 'CALL')
    const cOrders = await caller.client.from('orders').select('id,order_number,status')
    const cCost = await caller.client.from('orders').select('cost_total')
    const cItemCost = await caller.client.from('order_items').select('unit_cost')
    const cPl = await caller.client.rpc('report_profit_loss', { p_from: today, p_to: today })
    const cProducts = await caller.client.from('product_variants').select('cost_price')
    step('Call role: sees the orders', !cOrders.error && (cOrders.data ?? []).length === 3, JSON.stringify(cOrders.error ?? cOrders.data?.length))
    step('Call role: cannot read order cost, item cost, product cost or the P&L',
      Boolean(cCost.error) && Boolean(cItemCost.error) && Boolean(cPl.error) && (Boolean(cProducts.error) || (cProducts.data ?? []).length === 0),
      JSON.stringify({ cost: cCost.error?.message ?? cCost.data, item: cItemCost.error?.message ?? cItemCost.data, pl: cPl.error?.message ?? 'returned data', products: cProducts.error?.message ?? cProducts.data }))
    const cMove = await caller.client.rpc('transition_order_status', { p_order_id: o1id, p_to: 'RETURN_REQUESTED' })
    step('Call role: cannot move a delivered order', Boolean(cMove.error), JSON.stringify(cMove.error))

    // --- a second store ----------------------------------------------------------------------------------
    const m2 = await call('POST', '/rest/v1/merchants', { merchant: null, body: { name: 'Audit Store Two', slug: 'audit-two' }, prefer: 'return=representation' })
    const M2 = m2.body?.[0]?.id
    await call('POST', '/rest/v1/rpc/_merchant_seed_defaults', { merchant: null, body: { p_merchant: M2 } })
    const other = await staff('r3-other@example.com', 'OWNER', M2)
    step('second store and its owner', Boolean(M2 && other.session), JSON.stringify([m2.body, other.error, other.setError]))
    const tok = other.session?.access_token
    const own = await call('GET', '/rest/v1/orders?select=id', { key: ANON, token: tok, merchant: M2 })
    const spoof = await call('GET', '/rest/v1/orders?select=id,customer_phone', { key: ANON, token: tok, merchant: M1 })
    const spoofCust = await call('GET', '/rest/v1/customers?select=id,phone', { key: ANON, token: tok, merchant: M1 })
    const spoofSet = await call('GET', '/rest/v1/settings?select=key', { key: ANON, token: tok, merchant: M1 })
    const spoofPl = await call('POST', '/rest/v1/rpc/report_profit_loss', { key: ANON, token: tok, merchant: M1, body: { p_from: today, p_to: today } })
    const spoofMove = await call('POST', '/rest/v1/rpc/transition_order_status', { key: ANON, token: tok, merchant: M1, body: { p_order_id: o1id, p_to: 'RETURN_REQUESTED' } })
    const leaked = [spoof, spoofCust].some((r) => Array.isArray(r.body) && r.body.length > 0)
    const plLeak = spoofPl.status < 300 && Number(spoofPl.body?.product_revenue) > 0
    step('second store sees none of store one: orders, customers, private settings, P&L, status changes',
      Array.isArray(own.body) && own.body.length === 0 && !leaked && !plLeak && spoofMove.status >= 400 && (await order(o1id))?.status === 'DELIVERED' &&
        !(Array.isArray(spoofSet.body) && spoofSet.body.some((s) => s.key === 'fraud' || s.key === 'checkout_risk')),
      JSON.stringify({ own: own.body?.length, spoof: [spoof.status, spoof.body?.length ?? spoof.body], cust: [spoofCust.status, spoofCust.body?.length ?? spoofCust.body],
        settings: spoofSet.body, pl: [spoofPl.status, spoofPl.body?.product_revenue], move: [spoofMove.status, spoofMove.body] }))

    // --- the admin in a browser ----------------------------------------------------------------------------
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    const o1n = o1d?.order_number
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      const errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => localStorage.setItem(k, s), [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])
      await page.goto(`${base}/admin/orders/${o1id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const shown = await settle(page, new RegExp(o1n), 40000)
      const t = await text(page)
      step(`[${width}] order page: number, Delivered, Karim, the two items`, shown && /Delivered/i.test(t) && /Karim Mia/.test(t) && /Audit Tee/.test(t), t.slice(0, 500))
      await page.screenshot({ path: join(S, `order-${width}.png`), fullPage: false })
      await page.reload({ waitUntil: 'domcontentloaded' })
      step(`[${width}] order page survives a reload (session kept)`, await settle(page, new RegExp(o1n), 40000), (await text(page)).slice(0, 300))
      const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      step(`[${width}] order page: no sideways scrolling`, overflow <= 1, `${overflow}px`)
      if (width === 1440) {
        await page.goto(`${base}/admin/finance`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(4000)
        const ft = await text(page)
        step('finance page opens and shows money figures', /৳|BDT|Tk/.test(ft) && !/Something went wrong/i.test(ft), ft.slice(0, 500))
        await page.screenshot({ path: join(S, 'finance-1440.png'), fullPage: false })
      }
      step(`[${width}] no page errors`, errs.length === 0, errs.join(' | '))
      await ctx.close()
    }
    // The Call user in a browser: no finance page.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.evaluate(([k, s]) => localStorage.setItem(k, s), [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(caller.session)])
    await page.goto(`${base}/admin/finance`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)
    const ct = await text(page)
    step('Call user opening /admin/finance sees no money figures', !/2,000|৳\s?2,?000/.test(ct), ct.slice(0, 400))
    await page.screenshot({ path: join(S, 'call-finance-1440.png'), fullPage: false })
    await ctx.close()
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'orders-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'orders-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()

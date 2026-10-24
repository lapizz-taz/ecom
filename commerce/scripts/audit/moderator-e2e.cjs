// Audit round 4, §4 #8: a Moderator picks products for a new order without seeing what they cost,
// against the real Worker (site + backend functions + Cloudflare database) on this machine.
// Never deployed; no outside service is called.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/moderator-e2e.cjs
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
const persist = mkdtempSync(join(tmpdir(), 'audit-r4-mod-'))

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
async function call(method, path, { body, key = SERVICE, token, merchant = M1 } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token ?? key}` }
  if (merchant) headers['x-merchant-id'] = merchant
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
const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
async function settle(page, re, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (re.test(await text(page))) return true
    await page.waitForTimeout(500)
  }
  return false
}

;(async () => {
  let browser
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const owner = await staff('r4-owner@example.com', 'OWNER')
    step('owner signed in', Boolean(owner.session), JSON.stringify(owner.error ?? owner.setError))

    // A product whose cost (437) appears nowhere else on the page.
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Picker Tee', slug: 'picker-tee', status: 'ACTIVE', price: 1290, cost_price: 437,
      track_inventory: true, requires_production: false, variants: [{ sku: 'PKT1', title: 'Default', initial_stock: 6 }] } })
    const vid = (await call('GET', `/rest/v1/product_variants?product_id=eq.${product.data?.id}&select=id`)).body?.[0]?.id
    step('product saved with 6 in stock', Boolean(vid), JSON.stringify(product.error))

    const mod = await staff('r4-moderator@example.com', 'MODERATOR')
    step('moderator signed in', Boolean(mod.session), JSON.stringify(mod.error ?? mod.setError))

    // --- the API ---------------------------------------------------------------------------------
    const tables = await Promise.all([mod.client.from('products').select('id, cost_price'), mod.client.from('product_variants').select('id, cost_price'), mod.client.from('inventory_overview').select('variant_id, unit_cost')])
    step('Moderator: the product tables and the stock view return nothing',
      tables.every((t) => (t.data ?? []).length === 0), JSON.stringify(tables.map((t) => t.error ?? t.data)))
    const modCat = await mod.client.rpc('order_catalog', { p_search: 'Picker' })
    const mRow = modCat.data?.[0]
    step('Moderator: order_catalog gives the product with price and "in stock", no cost and no count',
      !modCat.error && modCat.data?.length === 1 && Number(mRow.unit_price) === 1290 && mRow.unit_cost === null && mRow.available === null && mRow.in_stock === true && !JSON.stringify(modCat.data).includes('437'),
      JSON.stringify(modCat.error ?? modCat.data))
    const ownCat = await owner.client.rpc('order_catalog', { p_search: 'Picker' })
    step('Owner: order_catalog gives the cost and the count',
      !ownCat.error && Number(ownCat.data?.[0]?.unit_cost) === 437 && Number(ownCat.data?.[0]?.available) === 6, JSON.stringify(ownCat.error ?? ownCat.data))

    // --- the New Order page ------------------------------------------------------------------------
    browser = await chromium.launch()
    for (const [who, user] of [['Moderator', mod], ['Owner', owner]]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      const errs = []
      page.on('pageerror', (e) => errs.push(e.message))
      const calls = []
      page.on('request', (r) => { if (/\/rest\/v1\//.test(r.url())) calls.push(r.url().replace(base, '')) })
      const catalog = []
      page.on('response', async (r) => { if (/rpc\/order_catalog/.test(r.url())) catalog.push(`${r.status()} ${(await r.text().catch(() => '')).slice(0, 300)}`) })
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31'); localStorage.setItem('admin-major-update-seen', '9999-12-31|seen') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(user.session)])
      await page.goto(`${base}/admin/orders/new`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const search = page.getByLabel('Search products')
      await search.waitFor({ timeout: 60000 })
      await search.fill('Picker')
      const listed = await settle(page, /Picker Tee[\s\S]*PKT1/)
      const t = await text(page)
      const want = who === 'Moderator' ? /1,290[^]*in stock/ : /1,290[^]*6 in stock/
      step(`${who}: New Order finds the product with its price and stock`, listed && want.test(t), `${catalog.join(' | ')} :: ${t.slice(t.indexOf('Search') - 200, t.indexOf('Search') + 400)}`)
      if (who === 'Moderator') step('Moderator: the picker shows no cost and no stock count', !/437/.test(t) && !/\b6 in stock\b/.test(t), t.slice(0, 600))
      await page.screenshot({ path: join(S, `moderator-picker-${who.toLowerCase()}-1440.png`), fullPage: false })
      await page.getByRole('button', { name: /Picker Tee/ }).first().click()
      const added = await settle(page, /PKT1/)
      const after = await text(page)
      step(`${who}: picking adds the line`, added && /Picker Tee/.test(after) && /1,290/.test(after), after.slice(0, 600))
      if (who === 'Moderator') {
        step('Moderator: the order line shows no stock count', !/6 available/.test(after), after.slice(0, 600))
        step('Moderator: the page never asks the product tables', !calls.some((c) => /\/rest\/v1\/(products|product_variants|inventory_overview)\b/.test(c)), calls.join(' '))
      }
      step(`${who}: no page errors`, errs.length === 0, errs.join(' | '))
      await ctx.close()
    }
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'moderator-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'moderator-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()

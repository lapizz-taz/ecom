// Email and WhatsApp modules: the pages open at desktop and phone width without errors or sideways
// scrolling; an email is edited in code with a live preview of the store's latest order and saved;
// a template mistake is shown and blocks saving; WhatsApp shows Meta's rules and a phone preview;
// "Send on WhatsApp" on an order lists the store's messages for that order; the old Templates tab
// points to the modules. Same local Worker as admin-pages-e2e.cjs. Never deployed; no outside service.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/messaging-e2e.cjs
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
const persist = mkdtempSync(join(tmpdir(), 'audit-msg-'))

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

;(async () => {
  let browser
  let current
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const owner = await staff('msg-owner@example.com', 'OWNER')
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Cotton Panjabi', slug: 'cotton-panjabi', status: 'ACTIVE', price: 1250, cost_price: 600, track_inventory: true, requires_production: false,
      variants: [{ sku: 'CP1', title: 'Default', initial_stock: 10 }] } })
    const vid = (await call('GET', `/rest/v1/product_variants?product_id=eq.${product.data?.id}&select=id`)).body?.[0]?.id
    const placed = await place(vid, 'Karim Mia', '01812345678', 'msg-order-0000001', 1)
    const orderId = placed.body?.order?.id ?? placed.body?.order_id ?? placed.body?.id
    const order = (await call('GET', `/rest/v1/orders?id=eq.${orderId}&select=id,order_number`)).body?.[0]
    await call('PATCH', `/rest/v1/orders?id=eq.${orderId}`, { body: { customer_email: 'karim@example.com' } })
    step('owner, product and an order', Boolean(owner.session && order?.order_number),
      JSON.stringify({ owner: owner.error ?? owner.setError, product: product.error, placed: placed.body }).slice(0, 600))
    if (!order?.order_number) throw new Error('set-up failed')

    // ---- the database side, as the owner
    const settings = await owner.client.rpc('email_settings')
    step('email starts with nothing chosen', settings.data?.provider === 'none' && settings.data?.ready === false, JSON.stringify(settings))
    const on = await owner.client.rpc('email_settings_save', { p: { enabled: true } })
    step('email cannot be switched on before choosing how it is sent', /choose how emails are sent/.test(on.error?.message ?? ''), JSON.stringify(on.error))
    const preview = await owner.client.rpc('notification_preview_data', {})
    step('the preview uses the latest order', preview.data?.order?.name === order?.order_number && preview.data?.customer?.first_name === 'Karim', JSON.stringify(preview.data?.order ?? preview.error).slice(0, 300))
    const wa = await owner.client.rpc('whatsapp_order_messages', { p_order_id: orderId })
    const confirmed = (wa.data?.messages ?? []).find((m) => m.event === 'ORDER_CONFIRMED')
    // 14 since messages v2 ("Courier could not reach you" and the review request); never the cart reminder (about a cart, not this order).
    step('"Send on WhatsApp" gets the texts filled in for the order', wa.data?.messages?.length === 14 && !wa.data.messages.some((m) => m.event === 'CART_REMINDER')
      && /8801812345678|01812345678/.test(wa.data?.phone ?? '') && confirmed?.text.includes(order?.order_number) && /Karim/.test(confirmed?.text ?? ''),
      JSON.stringify(wa.data ?? wa.error).slice(0, 400))
    const direct = await owner.client.from('notifications').update({ wa_status: 'APPROVED' }).eq('channel', 'WHATSAPP').select('id')
    step('nobody writes Meta\'s review directly', !direct.error && (direct.data ?? []).length === 0, JSON.stringify(direct))

    const emails = (await call('GET', `/rest/v1/notifications?channel=eq.EMAIL&event=eq.ORDER_CREATED&select=id`)).body
    const whatsapps = (await call('GET', `/rest/v1/notifications?channel=eq.WHATSAPP&event=eq.ORDER_CONFIRMED&select=id`)).body
    const emailId = emails?.[0]?.id
    const waId = whatsapps?.[0]?.id

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      current = page
      let errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31'); localStorage.setItem('admin-major-update-seen', '9999-12-31|seen') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])
      const open = async (path, expect, shot) => {
        errs = []
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        const found = await settle(page, expect)
        await page.waitForTimeout(800)
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
        await page.screenshot({ path: join(S, `msg-${width}-${shot}.png`), fullPage: width > 500 })
        step(`[${width}] ${path}`, found && overflow <= 1 && errs.length === 0, JSON.stringify({ found, overflow, errs, text: (await text(page)).slice(0, 300) }))
      }

      await open('/admin/email', /Order processing.*Order confirmation.*Shipping confirmation.*Payments.*Order exceptions/, 'email')
      await open('/admin/email?tab=sender', /Your own mailbox.*Fullfilio email service/, 'email-sender')
      await open('/admin/email?tab=design', /Button colour/, 'email-design')
      await open('/admin/email?tab=activity', /Nothing sent yet/, 'email-activity')
      await open(`/admin/email/${emailId}`, /Order confirmation.*Subject/, 'email-editor')
      const srcdoc = await page.getAttribute('iframe[title="Email preview"]', 'srcdoc').catch(() => '')
      step(`[${width}] the email preview shows the latest order`, srcdoc.includes(order.order_number) && srcdoc.includes('Karim') && srcdoc.includes('Cotton Panjabi'), srcdoc.slice(0, 200))

      if (width === 1440) {
        await page.fill('#email_subject', 'Hi {{ customer.first_name }}, order {{ order.name }} is in')
        const subjectOk = await settle(page, new RegExp(`Subject: Hi Karim, order ${order.order_number} is in`), 8000)
        const code = await page.inputValue('#email_code')
        await page.fill('#email_code', `${code}{% if %}`)
        const mistake = await settle(page, /Line \d+:/, 8000)
        const saveBlocked = await page.isDisabled('button:has-text("Save")')
        await page.fill('#email_code', code.replace('Thank you for your order!', 'Thanks a lot for your order!'))
        await page.waitForTimeout(600)
        await page.click('button:has-text("Save")')
        const saved = await settle(page, /Email saved/, 10000)
        const row = (await call('GET', `/rest/v1/notifications?id=eq.${emailId}&select=subject,template`)).body?.[0]
        step('an email is edited in code, previewed live and saved; a mistake blocks saving',
          subjectOk && mistake && saveBlocked && saved && row?.subject === 'Hi {{ customer.first_name }}, order {{ order.name }} is in' && row?.template.includes('Thanks a lot for your order!'),
          JSON.stringify({ subjectOk, mistake, saveBlocked, saved, subject: row?.subject }))
        await page.screenshot({ path: join(S, `msg-${width}-email-saved.png`), fullPage: true })
      }

      await open('/admin/whatsapp', /Set up WhatsApp messages.*Connect your WhatsApp Business number.*Order approved.*Not submitted/, 'whatsapp')
      await open('/admin/whatsapp?tab=setup', /Sending number.*Message language.*How it works/, 'whatsapp-setup')
      await open(`/admin/whatsapp/${waId}`, /Order approved.*Meta review.*Business account/, 'whatsapp-editor')
      const bubble = await text(page)
      step(`[${width}] the WhatsApp preview fills in example values`, /Hi Rahim, your order ISO-1042 is confirmed/.test(bubble), bubble.slice(0, 300))
      if (width === 1440) {
        await page.fill('#wa_text', '{{customer_first_name}} your order {{order_number}}')
        const rules = await settle(page, /Start the message with words.*Too many placeholders|Start the message with words/, 8000)
        step('Meta\'s rules show while writing', rules && await page.isDisabled('button:has-text("Submit to Meta")'))
        await page.screenshot({ path: join(S, `msg-${width}-whatsapp-rules.png`), fullPage: true })
      }

      await open('/admin/settings?tab=notifications', /Customer messages.*SMS.*Email.*Not set up.*WhatsApp/, 'settings')
      await open(`/admin/orders/${orderId}`, new RegExp(order.order_number), 'order')
      await page.click('button[aria-label="Send on WhatsApp"]')
      const menu = await settle(page, /Opens WhatsApp with the message written.*Open chat.*Order approved/, 10000)
      await page.screenshot({ path: join(S, `msg-${width}-order-whatsapp.png`) })
      step(`[${width}] "Send on WhatsApp" lists the messages on the order`, menu, (await text(page)).slice(0, 300))
      await ctx.close()
    }

    // ---- round 4: the customer's unsubscribe page, a mail app's one-click unsubscribe, and a WhatsApp number that needs reconnecting
    const token = 'c'.repeat(40)
    const pref = await call('POST', '/rest/v1/email_preferences', { body: { merchant_id: M1, email: 'karim@example.com', token }, prefer: 'return=representation' })
    step('an unsubscribe token for karim@example.com', pref.status < 300, JSON.stringify(pref).slice(0, 300))
    const prefRow = async () => (await call('GET', `/rest/v1/email_preferences?token=eq.${token}&select=unsubscribed_at,unsubscribed_via`)).body?.[0]
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      const page = await ctx.newPage()
      current = page
      const errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
      await page.goto(`${base}/unsubscribe/${M1}/${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const asks = await settle(page, /Stop offer emails from .*k••••@example\.com.*still come/, 20000)
      const before = await prefRow()
      await page.screenshot({ path: join(S, 'msg-390-unsubscribe.png') })
      await page.click('button:has-text("Unsubscribe")')
      const done = await settle(page, /You are unsubscribed/, 10000)
      const after = await prefRow()
      step('[390] the unsubscribe page names the store and the half-hidden address, changes nothing until the tap, then unsubscribes',
        asks && before?.unsubscribed_at == null && done && !!after?.unsubscribed_at && after?.unsubscribed_via === 'LINK' && errs.length === 0,
        JSON.stringify({ asks, before, done, after, errs, text: (await text(page)).slice(0, 300) }))
      await page.click('button:has-text("Subscribe again")')
      const again = await settle(page, /You are subscribed again/, 10000)
      step('[390] "Subscribe again" turns the emails back on', again && (await prefRow())?.unsubscribed_at == null, (await text(page)).slice(0, 300))
      await ctx.close()
    }
    const oneClick = await fetch(`${base}/unsubscribe/${M1}/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    const clicked = await prefRow()
    step('a mail app\'s one-click unsubscribe (POST to the link) unsubscribes at once', oneClick.status === 200 && clicked?.unsubscribed_via === 'ONE_CLICK',
      JSON.stringify({ status: oneClick.status, clicked }))
    const unknown = await fetch(`${base}/unsubscribe/${M1}/${'d'.repeat(40)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    step('an unknown token unsubscribes nobody (404)', unknown.status === 404, String(unknown.status))

    const channel = await call('POST', '/rest/v1/rpc/inbox_channel_save', { body: { p: { platform: 'WHATSAPP', external_id: '109876543210', waba_id: '2233445566', display_phone: '+880 1711-000000', name: 'My Store' }, p_actor: null } })
    const channelId = channel.body?.id ?? (await call('GET', '/rest/v1/inbox_channels?platform=eq.WHATSAPP&select=id')).body?.[0]?.id
    const chosen = await owner.client.rpc('whatsapp_settings_save', { p: { channel_id: channelId } })
    await call('PATCH', `/rest/v1/inbox_channels?id=eq.${channelId}`, { body: { status: 'FAILED' } })
    step('a WhatsApp number, chosen for sending, whose token Meta refuses', Boolean(channelId) && !chosen.error, JSON.stringify({ channel: channel.body, chosen: chosen.error }).slice(0, 300))
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      current = page
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31'); localStorage.setItem('admin-major-update-seen', '9999-12-31|seen') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])
      await page.goto(`${base}/admin/whatsapp`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const warned = await settle(page, /needs reconnecting: Meta no longer accepts its access token.*Reconnect/, 20000)
      const notOn = !/On\. Messages Meta approved/.test(await text(page))
      await page.screenshot({ path: join(S, 'msg-1440-whatsapp-reconnect.png'), fullPage: true })
      step('[1440] the WhatsApp page says the number needs reconnecting and never "On"', warned && notOn, (await text(page)).slice(0, 400))
      // Dark mode: the warning must stay readable (the theme re-maps tints; a second flip made it dark on tan).
      await page.evaluate(() => localStorage.setItem('admin-theme', 'dark'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await settle(page, /needs reconnecting: Meta no longer accepts its access token/, 20000)
      const contrast = await page.evaluate(() => {
        const rgba = (c) => {
          const x = document.createElement('canvas').getContext('2d')
          x.fillStyle = c
          x.fillRect(0, 0, 1, 1)
          const d = x.getImageData(0, 0, 1, 1).data
          return [d[0], d[1], d[2], d[3] / 255]
        }
        const span = [...document.querySelectorAll('span')].find((s) => s.textContent.includes('needs reconnecting'))
        if (!span || !document.documentElement.classList.contains('dark')) return null
        // The colour behind the text: every background from the page down to the text, blended in order.
        const layers = []
        for (let el = span; el; el = el.parentElement) layers.unshift(rgba(getComputedStyle(el).backgroundColor))
        let bg = [255, 255, 255]
        for (const [r, g, b, a] of layers) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
        const fg = rgba(getComputedStyle(span).color)
        const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
        const [hi, lo] = [lum(fg), lum(bg)].sort((p, q) => q - p)
        return { ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fg: fg.slice(0, 3), bg: bg.map(Math.round) }
      })
      await page.screenshot({ path: join(S, 'msg-1440-whatsapp-reconnect-dark.png'), fullPage: false })
      step('[1440, dark] the reconnect warning is readable (text contrast at least 4.5:1)', !!contrast && contrast.ratio >= 4.5, JSON.stringify(contrast))
      await ctx.close()
    }
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
    await current?.screenshot({ path: join(S, 'msg-failure.png'), fullPage: true }).catch(() => undefined)
    console.log((await current?.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => ''))?.slice(0, 1500))
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'msg-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'msg-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()

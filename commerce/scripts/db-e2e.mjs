#!/usr/bin/env node
// Checks the Cloudflare database in the real Workers runtime (workerd, via
// `wrangler dev --local`): the full schema loads into a Durable Object, the API
// answers through the same gateway the site uses, store isolation and permissions
// hold, a failed multi-row write leaves nothing behind, and parallel writes stay
// consistent. Uses a throwaway local database; touches nothing live.
//
//   node scripts/db-e2e.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const root = resolve(import.meta.dirname, '..')
const port = 8000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const persist = mkdtempSync(join(tmpdir(), 'db-e2e-'))
const SERVICE = 'e2e-service-key-not-a-secret'
const M1 = '00000000-0000-4000-8000-000000000001'

const dev = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--config', 'worker/db/e2e/wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
})
let log = ''
dev.stdout.on('data', (d) => { log += d })
dev.stderr.on('data', (d) => { log += d })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
}

async function call(method, path, { body, key, merchant, prefer, accept, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) { headers.apikey = key; headers.Authorization = `Bearer ${key}` }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (merchant) headers['x-merchant-id'] = merchant
  if (prefer) headers.Prefer = prefer
  if (accept) headers.Accept = accept
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json, headers: res.headers }
}

try {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${base}/rest/v1/nothing`)
      if (r.status) break
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const started = Date.now()
  const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(root, 'worker/db/generated/seed.sql'), 'utf8') })
  const seedInfo = await seeded.json().catch(() => null)
  check('schema and reference data load into the Durable Object', seeded.status === 200 && seedInfo?.tables >= 170 && seedInfo?.roles >= 8,
    JSON.stringify(seedInfo) + log.slice(-2000))
  console.log(`     (${seedInfo?.tables} tables, first start + seed ${Date.now() - started} ms)`)

  const created = await call('POST', '/rest/v1/suppliers?select=id,name,merchant_id', { key: SERVICE, merchant: M1, body: { name: 'E2E Supplier' }, prefer: 'return=representation', accept: 'application/vnd.pgrst.object+json' })
  check('service role inserts for a store and gets the row back', created.status === 201 && created.body?.merchant_id === M1, JSON.stringify(created))

  const anon = await call('GET', '/rest/v1/suppliers?select=name', { merchant: M1 })
  check('a visitor sees no supplier rows', anon.status === 200 && Array.isArray(anon.body) && anon.body.length === 0, JSON.stringify(anon))

  const listed = await call('GET', '/rest/v1/suppliers?select=name&name=eq.E2E%20Supplier', { key: SERVICE, merchant: M1, prefer: 'count=exact' })
  check('service role reads it with a count', listed.body?.length === 1 && listed.headers.get('content-range') === '0-0/1', JSON.stringify(listed.body) + listed.headers.get('content-range'))

  const partial = await call('POST', '/rest/v1/categories', { key: SERVICE, merchant: M1, body: [{ name: 'Good one', slug: 'good-one' }, { name: 'Bad one', slug: 'Bad Slug' }] })
  const leftover = await call('GET', '/rest/v1/categories?select=slug&slug=eq.good-one', { key: SERVICE, merchant: M1 })
  check('a write that fails half-way leaves nothing behind', partial.status === 400 && leftover.body?.length === 0, JSON.stringify(partial.body) + JSON.stringify(leftover.body))

  const parallel = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    call('POST', '/rest/v1/suppliers', { key: SERVICE, merchant: M1, body: { name: `Parallel ${i}` } })))
  const counted = await call('HEAD', '/rest/v1/suppliers?name=like.Parallel*', { key: SERVICE, merchant: M1, prefer: 'count=exact' })
  check('40 parallel writes all land, none lost or doubled', parallel.every((r) => r.status === 201) && counted.headers.get('content-range') === '*/40',
    `${parallel.map((r) => r.status).join(',')} ${counted.headers.get('content-range')}`)

  const forged = await call('GET', '/rest/v1/suppliers?select=name', { bearer: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Imluc18xIn0.eyJzdWIiOiJ1c2VyXzEifQ.c2ln', merchant: M1 })
  check('a forged sign-in token is refused', forged.status === 401, JSON.stringify(forged))

  const user = await call('POST', '/auth/v1/admin/users', { key: SERVICE, body: { email: 'E2E@Example.com', email_confirm: true, user_metadata: { full_name: 'E2E' }, app_metadata: { clerk_user_id: 'user_e2e' } } })
  const fetched = await call('GET', `/auth/v1/admin/users/${user.body?.id}`, { key: SERVICE })
  check('account admin API creates and reads accounts', user.status === 200 && fetched.body?.email === 'e2e@example.com' && fetched.body?.app_metadata?.clerk_user_id === 'user_e2e', JSON.stringify(fetched))
  const banned = await call('PUT', `/auth/v1/admin/users/${user.body?.id}`, { key: SERVICE, body: { ban_duration: '876000h' } })
  check('accounts can be switched off', Boolean(banned.body?.banned_until), JSON.stringify(banned))
  const outsider = await call('GET', `/auth/v1/admin/users/${user.body?.id}`, { merchant: M1 })
  check('the account admin API is closed to visitors', outsider.status === 403, JSON.stringify(outsider))

  // auth.sessions: a Clerk session is recorded once; one that was signed out is not recorded again.
  const staff = await call('POST', '/auth/v1/admin/users', { key: SERVICE, body: { email: 'session@example.com', email_confirm: true, app_metadata: { clerk_user_id: 'user_session' } } })
  const as = (sessionId) => fetch(`${base}/__as`, { method: 'POST', body: JSON.stringify({ path: 'merchants', caller: { role: 'authenticated', clerkUserId: 'user_session', sessionId } }) })
  const S1 = '11111111-1111-4111-8111-111111111111'
  const S2 = '22222222-2222-4222-8222-222222222222'
  const sessions = async () => (await call('GET', `/rest/v1/sessions?select=id&user_id=eq.${staff.body?.id}&order=id`, { key: SERVICE })).body?.map((r) => r.id)
  await as(S1)
  await as(S1)
  const recorded = await sessions()
  await call('DELETE', `/rest/v1/sessions?id=eq.${S1}`, { key: SERVICE })
  await as(S1)
  await as(S2)
  const after = await sessions()
  const hidden = await fetch(`${base}/__as`, { method: 'POST', body: JSON.stringify({ path: 'sessions', caller: { role: 'authenticated', clerkUserId: 'user_session', sessionId: S2 } }) })
  check('sign-in sessions are recorded once, a signed-out one stays out, and only the server reads them',
    JSON.stringify(recorded) === JSON.stringify([S1]) && JSON.stringify(after) === JSON.stringify([S2]) && (hidden.status === 401 || hidden.status === 403),
    `${JSON.stringify(recorded)} ${JSON.stringify(after)} ${hidden.status}`)

  // Sign-in sessions with supabase-js itself, as the pages use it: the server makes a one-time
  // sign-in token (clerk-auth does, after checking Clerk), the page turns it into a session,
  // reads as that person, renews the session, and signs out.
  const server = createClient(base, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  await server.auth.admin.createUser({ email: 'page@example.com', email_confirm: true, user_metadata: { full_name: 'Page' }, app_metadata: { clerk_user_id: 'user_page' } })
  const link = await server.auth.admin.generateLink({ type: 'magiclink', email: 'page@example.com' })
  const page = createClient(base, 'sb_publishable_e2e', { auth: { persistSession: false, autoRefreshToken: false } })
  const opened = await page.auth.verifyOtp({ type: 'magiclink', token_hash: link.data?.properties?.hashed_token })
  const me = await page.auth.getUser()
  const asPerson = await page.rpc('find_auth_user_id', { p_email: 'page@example.com' })
  const reused = await createClient(base, 'sb_publishable_e2e', { auth: { persistSession: false } }).auth.verifyOtp({ type: 'magiclink', token_hash: link.data?.properties?.hashed_token })
  check('a sign-in token opens a session once; the person is known by it (supabase-js)',
    !link.error && Boolean(opened.data?.session?.access_token) && me.data?.user?.email === 'page@example.com' && asPerson.error?.code === '42501' && reused.error?.code === 'otp_expired',
    JSON.stringify({ link: link.error, opened: opened.error, me: me.error, asPerson: asPerson.error, reused: reused.error }))
  const renewed = await page.auth.refreshSession()
  const sessionId = JSON.parse(Buffer.from(renewed.data?.session?.access_token.split('.')[1] ?? 'e30', 'base64url').toString()).session_id
  const sessionRow = await call('GET', `/rest/v1/sessions?select=id&id=eq.${sessionId}`, { key: SERVICE })
  await page.auth.signOut()
  const afterOut = await page.auth.refreshSession({ refresh_token: renewed.data?.session?.refresh_token ?? '' })
  check('the session renews, is recorded for staff session limits, and ends on sign-out',
    !renewed.error && sessionRow.body?.length === 1 && Boolean(afterOut.error),
    JSON.stringify({ renewed: renewed.error, sessionRow: sessionRow.body, afterOut: afterOut.error }))

  const product = await call('POST', '/rest/v1/rpc/admin_save_product', { key: SERVICE, merchant: M1, body: { p_payload: {
    name: 'E2E Shirt', price: 500, status: 'ACTIVE', variants: [{ sku: 'E2E-SHIRT', title: 'Default', initial_stock: 10 }] } } })
  const variant = await call('GET', `/rest/v1/product_variants?select=id,inventory(on_hand,available)&product_id=eq.${product.body?.id}`, { key: SERVICE, merchant: M1 })
  const variantId = variant.body?.[0]?.id
  check('a product is saved with its opening stock', product.status === 200 && variant.body?.[0]?.inventory?.on_hand === 10, JSON.stringify(product.body) + JSON.stringify(variant.body))
  const grabs = await Promise.all(Array.from({ length: 20 }, () =>
    call('POST', '/rest/v1/rpc/adjust_stock', { key: SERVICE, merchant: M1, body: { p_variant_id: variantId, p_type: 'LOSS', p_quantity: 1, p_note: 'race' } })))
  const won = grabs.filter((r) => r.status === 200).length
  const refused = grabs.filter((r) => r.status === 400 && /INSUFFICIENT_STOCK/.test(r.body?.message ?? '')).length
  const left = await call('GET', `/rest/v1/inventory?select=on_hand,available&variant_id=eq.${variantId}`, { key: SERVICE, merchant: M1 })
  const moves = await call('HEAD', `/rest/v1/inventory_movements?variant_id=eq.${variantId}&movement_type=eq.LOSS`, { key: SERVICE, merchant: M1, prefer: 'count=exact' })
  check('20 people taking the last 10 at once: exactly 10 succeed, stock ends at 0, one movement each',
    won === 10 && refused === 10 && left.body?.[0]?.on_hand === 0 && moves.headers.get('content-range') === '*/10',
    `won ${won}, refused ${refused}, left ${JSON.stringify(left.body)}, moves ${moves.headers.get('content-range')}`)

  const rpc = await call('POST', '/rest/v1/rpc/find_auth_user_id', { key: SERVICE, body: { p_email: 'e2e@example.com' } })
  check('server functions run (rpc)', rpc.status === 200 && rpc.body === user.body?.id, JSON.stringify(rpc))
  const rpcDenied = await call('POST', '/rest/v1/rpc/find_auth_user_id', { body: { p_email: 'e2e@example.com' } })
  check('visitors cannot call internal functions', rpcDenied.status === 403, JSON.stringify(rpcDenied))
} catch (e) {
  check('run', false, `${e.stack}\n${log.slice(-3000)}`)
} finally {
  dev.kill('SIGINT')
  await new Promise((r) => setTimeout(r, 500))
  rmSync(persist, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)

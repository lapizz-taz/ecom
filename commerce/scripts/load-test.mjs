#!/usr/bin/env node
// Load test: how many orders, status changes and searches the order database sustains.
// Builds its own database (commerce_load) from supabase/migrations on the local Postgres and
// never touches production. Each operation runs the way a request does: its own transaction,
// with the caller's role and claims set, through the same database functions the app calls.
//
//   node scripts/load-test.mjs [--clients 16] [--seconds 20] [--reuse]
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const CLIENTS = Number(arg('clients', 16))
const SECONDS = Number(arg('seconds', 20))
const M1 = '00000000-0000-4000-8000-000000000001'
const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = '/commerce_load'; return u.toString() })()

async function build() {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query('drop database if exists commerce_load with (force)')
  await admin.query('create database commerce_load')
  await admin.end()
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  await c.query(readFileSync(join(ROOT, 'supabase/tests/support/supabase-stub.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await c.query(readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'))
  }
  await c.end()
}

const headers = (merchant) => JSON.stringify(merchant ? { 'x-merchant-id': merchant } : {})
async function asSystem(db, merchant = M1) {
  await db.query('reset role')
  await db.query(`select set_config('request.jwt.claims', '', true), set_config('app.merchant_id', $1, true), set_config('request.headers', $2, true)`, [merchant ?? '', headers(null)])
}
async function asService(db, merchant = M1) {
  await db.query(`set local role service_role`)
  await db.query(`select set_config('request.jwt.claims', $1, true), set_config('app.merchant_id', '', true), set_config('request.headers', $2, true)`, [JSON.stringify({ role: 'service_role' }), headers(merchant)])
}
async function asUser(db, user, merchant = M1) {
  await db.query(`set local role authenticated`)
  await db.query(`select set_config('request.jwt.claims', $1, true), set_config('app.merchant_id', '', true), set_config('request.headers', $2, true)`, [JSON.stringify({ sub: user, role: 'authenticated', email: `owner-${user.slice(0, 8)}@load.test` }), headers(merchant)])
}
async function tx(pool, fn) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const r = await fn(db)
    await db.query('commit')
    return r
  } catch (e) {
    await db.query('rollback').catch(() => undefined)
    throw e
  } finally {
    db.release()
  }
}

const DONE = Symbol('done')
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
async function run(label, seconds, clients, op) {
  const lat = []
  let ok = 0
  let errors = 0
  const firstErrors = []
  const started = performance.now()
  const until = Date.now() + seconds * 1000
  await Promise.all(Array.from({ length: clients }, async (_, worker) => {
    for (let i = 0; Date.now() < until; i++) {
      const t = performance.now()
      try {
        if (await op(worker, i) === DONE) break
        ok++; lat.push(performance.now() - t)
      } catch (e) { errors++; if (firstErrors.length < 3) firstErrors.push(String(e.message).slice(0, 160)) }
    }
  }))
  const elapsed = (performance.now() - started) / 1000
  const r = { label, ok, errors, seconds: Math.round(elapsed * 10) / 10, perSecond: Math.round(ok / elapsed), p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), firstErrors }
  console.log(`${label.padEnd(22)} ${String(r.perSecond).padStart(5)}/s  p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  ok ${ok}  errors ${errors}${firstErrors.length ? `  e.g. ${firstErrors[0]}` : ''}`)
  return r
}

async function main() {
  if (!process.argv.includes('--reuse')) { console.log('building commerce_load from the migrations…'); await build() }
  const pool = new pg.Pool({ connectionString: dbUrl, max: CLIENTS + 4 })
  // Setup: the store sells on its own site; 10 products with plenty of stock; an owner for searches.
  const setup = await tx(pool, async (db) => {
    await asSystem(db)
    await db.query(`update public.settings set value = value || '{"mode":"OWN"}' where merchant_id = $1 and key = 'storefront'`, [M1])
    const variants = []
    for (let i = 0; i < 10; i++) {
      const p = await db.query(`select id from public.admin_save_product($1)`, [JSON.stringify({ name: `Load ${i}`, slug: `load-${i}-${randomUUID().slice(0, 4)}`, status: 'ACTIVE', price: 500 + i * 50, cost_price: 200,
        track_inventory: true, requires_production: false, variants: [{ sku: `LOAD-${i}-${randomUUID().slice(0, 4)}`, title: 'Default', initial_stock: 1000000 }] })])
      variants.push((await db.query(`select id from public.product_variants where product_id = $1`, [p.rows[0].id])).rows[0].id)
    }
    const owner = randomUUID()
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [owner, `owner-${owner.slice(0, 8)}@load.test`])
    await db.query(`select public.admin_set_user_role($1, 'OWNER', true)`, [owner])
    return { variants, owner }
  })

  const phone = () => `01${3 + Math.floor(Math.random() * 7)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const placeOne = (pool) => tx(pool, async (db) => {
    await asService(db)
    const ph = phone()
    const check = await db.query(`select id from public.record_fraud_check($1)`, [JSON.stringify({ phone: ph, provider: 'internal', provider_counts: {} })])
    const n = 1 + Math.floor(Math.random() * 2)
    const items = Array.from({ length: n }, () => ({ variant_id: setup.variants[Math.floor(Math.random() * setup.variants.length)], quantity: 1 }))
    await db.query(`select public.place_storefront_order($1, $2)`, [JSON.stringify({
      customer: { full_name: `Load Customer ${ph.slice(-4)}`, phone: ph, email: null }, shipping: { address: 'House 1, Road 2, Dhanmondi', district: 'Dhaka', area: null },
      items, payment_method: 'COD', coupon_code: null, delivery_method: 'standard', idempotency_key: randomUUID() }), check.rows[0].id])
  })

  const results = {}
  results.orders = await run('place orders', SECONDS, CLIENTS, () => placeOne(pool))

  // Status changes: each worker takes its own web orders through the owner's real calls —
  // approve (approve_orders), then Processing → Packing → Ready to ship (transition_order_status).
  const ids = (await tx(pool, async (db) => { await asSystem(db); return (await db.query(`select id from public.orders where confirmed_at is null and status = 'CONFIRMATION_REQUIRED' order by created_at`)).rows.map((r) => r.id) }))
  const steps = ['APPROVE', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
  const perWorker = Array.from({ length: CLIENTS }, () => [])
  ids.forEach((id, k) => { for (const s of steps) perWorker[k % CLIENTS].push({ id, s }) })
  results.status = await run('status changes', SECONDS, CLIENTS, async (w, i) => {
    const job = perWorker[w][i]
    if (!job) return DONE
    await tx(pool, async (db) => {
      await asUser(db, setup.owner)
      if (job.s === 'APPROVE') {
        const r = (await db.query(`select public.approve_orders($1::uuid[], 'load test') as r`, [[job.id]])).rows[0].r
        if (r.approved !== 1) throw new Error(`approve failed: ${JSON.stringify(r.failed)}`)
      } else {
        await db.query(`select public.transition_order_status($1, $2::public.order_status, 'load test')`, [job.id, job.s])
      }
    })
  })

  // Search while orders keep coming in: half the clients place orders, half search like the Search page.
  const total = (await tx(pool, async (db) => { await asSystem(db); return Number((await db.query('select count(*) from public.orders')).rows[0].count) }))
  const half = Math.max(1, Math.floor(CLIENTS / 2))
  const [search] = await Promise.all([
    run('search under load', SECONDS, half, () => tx(pool, async (db) => {
      await asUser(db, setup.owner)
      const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0').slice(0, 5)
      await db.query(`select o.id, o.order_number, o.customer_name, o.status, (select json_agg(s) from public.shipments s where s.order_id = o.id) as shipments
        from public.orders o where o.customer_phone like $1 and o.merged_into is null order by o.created_at desc limit 50`, [`%${digits}%`])
    })),
    run('orders during search', SECONDS, CLIENTS - half, () => placeOne(pool)),
  ])
  results.search = search
  const inDb = (await tx(pool, async (db) => { await asSystem(db); return Number((await db.query('select count(*) from public.orders')).rows[0].count) }))
  await pool.end()

  const summary = {
    measuredAt: new Date().toISOString().slice(0, 10),
    environment: `local PostgreSQL ${(await (async () => { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); const v = (await c.query('show server_version')).rows[0].server_version; await c.end(); return v })())}, ${cpus().length} CPU cores, same machine as the load generator`,
    concurrency: CLIENTS,
    ordersPerSecond: results.orders.perSecond,
    statusChangesPerSecond: results.status.perSecond,
    searchP95Ms: results.search.p95,
    ordersInDatabase: inDb,
    ordersBeforeSearch: total,
    errors: results.orders.errors + results.status.errors + results.search.errors,
    details: results,
  }
  writeFileSync(join(ROOT, 'docs/load-test-results.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary, details: undefined }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })

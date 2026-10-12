#!/usr/bin/env node
// Checks the switch-over copy (worker/copy.ts) in the real Workers runtime: a Postgres with
// the Supabase migrations (COPY_SOURCE_URL, e.g. the copy test's commerce_copy) is read by
// the Worker over TCP and loaded into the Database Durable Object; both sides must match,
// a copy runs once per request, and never over a live Cloudflare database.
//
//   COPY_SOURCE_URL=postgres://… node scripts/copy-e2e.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = process.env.COPY_SOURCE_URL
if (!source) {
  console.error('COPY_SOURCE_URL is required')
  process.exit(1)
}
const root = resolve(import.meta.dirname, '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
}

async function withWorker(backend, fn) {
  const port = 8000 + Math.floor(Math.random() * 900)
  const persist = mkdtempSync(join(tmpdir(), 'copy-e2e-'))
  const dev = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--local', '--config', 'worker/db/e2e/wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1',
    '--persist-to', persist, '--var', `DATABASE_BACKEND:${backend}`, '--var', `SUPABASE_DB_URL:${source}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let log = ''
  dev.stdout.on('data', (d) => { log += d })
  dev.stderr.on('data', (d) => { log += d })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${base}/__count?table=roles`)).status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    await fn(base)
  } catch (e) {
    check('run', false, `${e.stack}\n${log.slice(-3000)}`)
  } finally {
    dev.kill('SIGINT')
    await new Promise((r) => setTimeout(r, 500))
    rmSync(persist, { recursive: true, force: true })
  }
}

const json = async (res) => res.json()

await withWorker('supabase', async (base) => {
  const report = await json(await fetch(`${base}/__copy?token=trial-1`))
  const again = await json(await fetch(`${base}/__copy?token=trial-1`))
  const orders = await json(await fetch(`${base}/__count?table=orders`))
  const secrets = await json(await fetch(`${base}/__count?table=_vault_secrets`))
  check('the copy reads Postgres over TCP and loads every row and Vault secret; both sides match',
    report?.ok === true && report.rows > 1000 && report.secrets > 0 && orders > 0 && secrets === report.secrets && report.issues.length === 0,
    JSON.stringify({ report, orders, secrets }))
  check('a copy runs once per request', again === null, JSON.stringify(again))
  const second = await json(await fetch(`${base}/__copy?token=trial-2`))
  check('a new request copies again, replacing (not adding to) the first copy', second?.ok === true && (await json(await fetch(`${base}/__count?table=orders`))) === orders,
    JSON.stringify(second))
})

await withWorker('cloudflare', async (base) => {
  const refused = await json(await fetch(`${base}/__copy?token=live-1`))
  check('never over a live Cloudflare database', refused === null, JSON.stringify(refused))
})

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)

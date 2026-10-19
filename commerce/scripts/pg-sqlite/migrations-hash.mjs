// The fingerprint of supabase/migrations a Cloudflare schema snapshot was made from
// (worker/db/generated/source.json). worker/db/snapshot.test.ts fails when they differ,
// so a migration cannot land without `npm run db:convert` (the snapshot carries the
// grants, row-security rules and function bodies the Cloudflare database enforces).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function migrationsHash(dir = resolve(import.meta.dirname, '..', '..', 'supabase', 'migrations')) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const h = createHash('sha256')
  for (const f of files) h.update(f).update('\0').update(readFileSync(resolve(dir, f), 'utf8').replace(/\r\n/g, '\n')).update('\0')
  return { migrations: files.length, last: files.at(-1) ?? null, sha256: h.digest('hex') }
}

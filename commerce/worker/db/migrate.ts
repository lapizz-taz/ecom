// Schema versions of the Cloudflare database. 0001 is the schema converted from the
// Supabase migrations; later changes are added here as new numbered entries and run
// once, in order, inside a transaction.
import schema from './generated/schema.ts'
import type { Sql } from './sql.ts'

const UUID = "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))"

export const migrations: Array<{ name: string; sql: readonly string[] }> = [
  { name: '0001_initial', sql: schema },
  // supabase/migrations/20261007000200_cron_secret.sql: the shared secret scheduled calls present,
  // made once per database (one copied from Supabase at the switch-over is kept).
  { name: '0002_cron_secret', sql: [`INSERT INTO _vault_secrets (id, name, description, secret)
    SELECT ${UUID}, 'cron_secret', 'Authenticates scheduled calls to the backend', lower(hex(randomblob(32)))
    WHERE NOT EXISTS (SELECT 1 FROM _vault_secrets WHERE name = 'cron_secret')`] },
]

export function migrate(sql: Sql): string[] {
  sql.script('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  const done = new Set(sql.all('SELECT name FROM _migrations').map((r) => String(r.name)))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    sql.transaction(() => {
      sql.script(m.sql)
      sql.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [m.name, new Date().toISOString()])
    })
    applied.push(m.name)
  }
  return applied
}

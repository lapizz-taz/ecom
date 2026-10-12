// Schema versions of the Cloudflare database. 0001 is the schema converted from the
// Supabase migrations; later changes are added here as new numbered entries and run
// once, in order, inside a transaction.
import schema from './generated/schema.ts'
import type { Sql } from './sql.ts'

export const migrations: Array<{ name: string; sql: readonly string[] }> = [
  { name: '0001_initial', sql: schema },
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

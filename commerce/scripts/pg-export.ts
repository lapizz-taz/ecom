// Copies every row of a Postgres database (with the Supabase migrations applied) into
// SQL for the Cloudflare database, converting each value the way the Worker's data
// layer stores it. Used for the reference data new databases start with, and for
// the one-time copy of the live data at the switch-over.
//
//   npx jiti scripts/pg-export.ts <postgres-url> <out.sql>          all rows
//   npx jiti scripts/pg-export.ts --seed <out.sql>                    reference data of a fresh migrated database
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { encode, type SqlValue } from '../worker/db/codec.ts'
import { schema } from '../worker/db/meta.ts'
import { createTestDatabase } from '../supabase/tests/support/db.ts'

// Dates, times and timestamps as Postgres prints them (the codec parses them, in UTC).
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v: string) => v)
pg.types.setTypeParser(20, (v: string) => v) // int8: keep exact, the codec makes it a number
pg.types.setTypeParser(1700, (v: string) => v) // numeric

const literal = (v: SqlValue): string => {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `X'${Buffer.from(v as Uint8Array).toString('hex')}'`
  return `'${String(v).replaceAll("'", "''")}'`
}

export async function exportDatabase(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  const out: string[] = [
    '-- Rows copied from Postgres by scripts/pg-export.ts.',
    'PRAGMA defer_foreign_keys = ON;',
  ]
  try {
    // Sign-in accounts (auth.users → users).
    const have = new Set((await client.query(`select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'users'`)).rows
      .map((r) => r.column_name as string))
    const pick = (c: string) => (have.has(c) ? c : `null as ${c}`)
    const users = (await client.query(`select id, email, ${pick('phone')}, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, ${pick('banned_until')},
      last_sign_in_at, created_at, updated_at from auth.users order by created_at`)).rows
    for (const u of users) {
      const app = (u.raw_app_meta_data ?? {}) as Record<string, unknown>
      const cols = schema.tables.users.columns
      const row: Record<string, unknown> = {
        id: u.id, email: u.email ? String(u.email).toLowerCase() : null, phone: u.phone || null,
        clerk_user_id: typeof app.clerk_user_id === 'string' ? app.clerk_user_id : null,
        user_metadata: u.raw_user_meta_data ?? {}, app_metadata: app,
        email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until, last_sign_in_at: u.last_sign_in_at,
        created_at: u.created_at ?? new Date(), updated_at: u.updated_at ?? u.created_at ?? new Date(),
      }
      const names = Object.keys(row)
      out.push(`INSERT INTO users (${names.join(', ')}) VALUES (${names.map((c) => literal(encode(row[c], cols[c]))).join(', ')});`)
    }
    for (const [name, t] of Object.entries(schema.tables)) {
      if (name === 'users') continue
      const cols = Object.entries(t.columns).filter(([, c]) => !c.generated).map(([c]) => c)
      const { rows } = await client.query(`select ${cols.map((c) => `"${c}"`).join(', ')} from public."${name}"`)
      for (const r of rows) {
        const values = cols.map((c) => {
          try {
            return literal(encode(r[c], t.columns[c]))
          } catch (e) {
            throw new Error(`${name}.${c}: ${(e as Error).message}`)
          }
        })
        out.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`)
      }
    }
    // Counters continue where Postgres stopped.
    for (const s of (await client.query(`select sequencename as name, last_value from pg_sequences where schemaname = 'public'`)).rows) {
      if (s.last_value !== null) out.push(`UPDATE _sequences SET value = ${Number(s.last_value)} WHERE name = '${s.name}';`)
    }
  } finally {
    await client.end()
  }
  return `${out.join('\n')}\n`
}

const args = process.argv.slice(2)
if (args[0] === '--seed') {
  const url = await createTestDatabase('commerce_seed')
  writeFileSync(args[1], await exportDatabase(url))
  console.log(`reference data written to ${args[1]}`)
} else if (args.length === 2) {
  writeFileSync(args[1], await exportDatabase(args[0]))
  console.log(`rows written to ${args[1]}`)
} else {
  console.error('usage: pg-export.ts <postgres-url> <out.sql> | --seed <out.sql>')
  process.exit(1)
}

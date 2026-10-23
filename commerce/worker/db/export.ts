// Rows of a Postgres database with the Supabase migrations applied, as SQL for the
// Cloudflare database: every value converted the way the data layer stores it. Used for
// the reference data new databases start with (scripts/pg-export.ts) and for the copy of
// the live data at the switch-over (worker/copy.ts, Supabase → Worker → Database, so the
// data passes through nobody's computer).
//
// With each copy goes a summary of both sides (rows per table and money totals) so a
// copy is only trusted when they match.
import { encode, type SqlValue } from './codec.ts'
import { schema } from './meta.ts'
import type { Sql } from './sql.ts'

export interface PgQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Postgres types read as text, so nothing is rounded or shifted on the way: dates, times, bigint, numeric. */
export const TEXT_TYPE_OIDS: ReadonlySet<number> = new Set([1082, 1083, 1114, 1184, 1266, 20, 1700])

export const sqlLiteral = (v: SqlValue): string => {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    return `X'${Array.from(new Uint8Array(v as ArrayBuffer), (b) => b.toString(16).padStart(2, '0')).join('')}'`
  }
  const text = String(v).replaceAll("'", "''")
  if (!/[\r\n]/.test(text)) return `'${text}'`
  // Line breaks travel as a marker the text doesn't contain, put back by replace(): each statement
  // stays on one line (the seed file is read line by line) and the expression stays shallow.
  // One character absent from the text, so it can't match anything but a line break.
  const [nl, cr] = [...'⏎␍↵¶␤§', ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).filter((c) => !/[\t\n\r]/.test(c))]
    .filter((c) => !text.includes(c))
  let out = `replace('${text.replaceAll('\r', cr).replaceAll('\n', nl)}', '${nl}', char(10))`
  if (text.includes('\r')) out = `replace(${out}, '${cr}', char(13))`
  return out
}

export interface ExportOptions {
  /** Also copy Vault's secrets (the live copy; never the reference data). */
  vault?: boolean
}

/** One INSERT per row (users first, then every table), and the counters where Postgres left them. */
export async function exportStatements(client: PgQuery, opts: ExportOptions = {}): Promise<string[]> {
  const out: string[] = ['PRAGMA defer_foreign_keys = ON;']
  // Sign-in accounts (auth.users → users).
  const have = new Set((await client.query(`select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'users'`)).rows
    .map((r) => r.column_name as string))
  const pick = (c: string) => (have.has(c) ? c : `null as ${c}`)
  const users = (await client.query(`select id, email, ${pick('phone')}, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, ${pick('banned_until')},
    last_sign_in_at, created_at, updated_at from auth.users order by created_at`)).rows
  const userCols = schema.tables.users.columns
  for (const u of users) {
    const app = (u.raw_app_meta_data ?? {}) as Record<string, unknown>
    const row: Record<string, unknown> = {
      id: u.id, email: u.email ? String(u.email).toLowerCase() : null, phone: u.phone || null,
      clerk_user_id: typeof app.clerk_user_id === 'string' ? app.clerk_user_id : null,
      user_metadata: u.raw_user_meta_data ?? {}, app_metadata: app,
      email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until, last_sign_in_at: u.last_sign_in_at,
      created_at: u.created_at ?? new Date(), updated_at: u.updated_at ?? u.created_at ?? new Date(),
    }
    const names = Object.keys(row)
    out.push(`INSERT INTO users (${names.join(', ')}) VALUES (${names.map((c) => sqlLiteral(encode(row[c], userCols[c]))).join(', ')});`)
  }
  for (const [name, t] of Object.entries(schema.tables)) {
    if (name === 'users' || name === 'sessions') continue
    const cols = Object.entries(t.columns).filter(([, c]) => !c.generated).map(([c]) => c)
    const { rows } = await client.query(`select ${cols.map((c) => `"${c}"`).join(', ')} from public."${name}"`)
    for (const r of rows) {
      const values = cols.map((c) => {
        try {
          return sqlLiteral(encode(r[c], t.columns[c]))
        } catch (e) {
          throw new Error(`${name}.${c}: ${(e as Error).message}`)
        }
      })
      out.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`)
    }
  }
  // Counters continue where Postgres stopped.
  for (const s of (await client.query(`select sequencename as name, last_value from pg_sequences where schemaname = 'public'`)).rows) {
    if (s.last_value !== null) out.push(`UPDATE _sequences SET value = ${Number(s.last_value)} WHERE name = ${sqlLiteral(String(s.name))};`)
  }
  if (opts.vault) {
    out.push('DELETE FROM _vault_secrets;')
    for (const v of (await client.query('select id, name, description, decrypted_secret, created_at, updated_at from vault.decrypted_secrets order by created_at')).rows) {
      if (v.decrypted_secret === null) continue
      const at = (x: unknown) => sqlLiteral(x ? new Date(String(x)).toISOString() : new Date().toISOString())
      out.push(`INSERT INTO _vault_secrets (id, name, description, secret, created_at, updated_at) VALUES (${sqlLiteral(String(v.id))}, ${v.name === null ? 'NULL' : sqlLiteral(String(v.name))}, ${sqlLiteral(String(v.description ?? ''))}, ${sqlLiteral(String(v.decrypted_secret))}, ${at(v.created_at)}, ${at(v.updated_at)});`)
    }
  }
  return out
}

// --- Checking a copy --------------------------------------------------------------

/** Rows per table and the total of every money column (as text, at the column's scale). */
export type Summary = Record<string, { rows: number; sums: Record<string, string> }>

const moneyColumns = (name: string) => Object.entries(schema.tables[name].columns)
  .filter(([, c]) => c.type === 'numeric' && !c.generated).map(([c, m]) => ({ name: c, scale: m.scale ?? 4 }))

const fixed = (v: unknown, scale: number) => (Number(v ?? 0) || 0).toFixed(scale)

/** The source side of a copy: Postgres (auth.users and Vault counted as users and _vault_secrets). */
export async function sourceSummary(client: PgQuery, opts: ExportOptions = {}): Promise<Summary> {
  const out: Summary = {}
  for (const name of Object.keys(schema.tables)) {
    if (name === 'sessions') continue
    const money = moneyColumns(name)
    const from = name === 'users' ? 'auth.users' : `public."${name}"`
    const sql = `select count(*)::text as n${money.map((m, i) => `, coalesce(sum("${m.name}"), 0)::text as s${i}`).join('')} from ${from}`
    const r = (await client.query(sql)).rows[0]
    out[name] = { rows: Number(r.n), sums: Object.fromEntries(money.map((m, i) => [m.name, fixed(r[`s${i}`], m.scale)])) }
  }
  if (opts.vault) out._vault_secrets = { rows: Number((await client.query('select count(*)::text as n from vault.decrypted_secrets where decrypted_secret is not null')).rows[0].n), sums: {} }
  return out
}

/** The same summary of the Cloudflare database. */
export function targetSummary(sql: Sql, opts: ExportOptions = {}): Summary {
  const out: Summary = {}
  for (const name of Object.keys(schema.tables)) {
    if (name === 'sessions') continue
    const money = moneyColumns(name)
    const r = sql.all(`SELECT count(*) AS n${money.map((m, i) => `, total("${m.name}") AS s${i}`).join('')} FROM "${name}"`)[0]
    out[name] = { rows: Number(r.n), sums: Object.fromEntries(money.map((m, i) => [m.name, fixed(r[`s${i}`], m.scale)])) }
  }
  if (opts.vault) out._vault_secrets = { rows: Number(sql.all('SELECT count(*) AS n FROM _vault_secrets')[0].n), sums: {} }
  return out
}

/** Every difference between the two sides, in words; empty when the copy is complete. */
export function compareSummaries(source: Summary, target: Summary): string[] {
  const issues: string[] = []
  for (const [name, s] of Object.entries(source)) {
    const t = target[name]
    if (!t) {
      issues.push(`${name}: missing on Cloudflare`)
      continue
    }
    if (s.rows !== t.rows) issues.push(`${name}: ${s.rows} rows in Supabase, ${t.rows} on Cloudflare`)
    for (const [col, total] of Object.entries(s.sums)) {
      if (t.sums[col] !== total) issues.push(`${name}.${col}: total ${total} in Supabase, ${t.sums[col]} on Cloudflare`)
    }
  }
  return issues
}

/** Loads a copy into an empty, migrated database in one transaction, then checks every reference. */
export function loadStatements(sql: Sql, statements: string[]): void {
  sql.transaction(() => {
    for (const s of statements) sql.script(s)
    const broken = sql.all('PRAGMA foreign_key_check')
    if (broken.length) throw new Error(`references to missing rows after the copy: ${broken.slice(0, 5).map((b) => `${b.table} → ${b.parent}`).join(', ')}`)
  })
}

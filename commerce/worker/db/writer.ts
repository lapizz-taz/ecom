// Inserts, updates and deletes with everything Postgres did around them: table
// privileges, row security (USING and WITH CHECK), defaults filled in by the server
// (store, signed-in user, numbered sequences), the checks SQLite cannot hold,
// updated_at, the audit trail and the business triggers' TypeScript ports.
import { enforceChecks } from './checks.ts'
import { decode, encode, type SqlValue } from './codec.ts'
import type { Context } from './context.ts'
import { DbError } from './errors.ts'
import { quoteId } from './ident.ts'
import { table as tableMeta, type ColumnMeta, type TableMeta, type TriggerMeta } from './meta.ts'
import { condition, requireGrant, secure, type DbRole } from './policy.ts'
import type { Row, Sql } from './sql.ts'
import { triggers as registry } from './triggers/index.ts'

export interface WriteEnv {
  sql: Sql
  ctx: Context
  /** anon/authenticated: API caller (grants + policies); app_owner: definer code (store isolation); service_role: no policies. */
  role: DbRole
}

export type Values = Record<string, unknown>
export type Key = SqlValue[]

export interface TriggerEvent {
  env: WriteEnv
  table: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  /** Decoded rows, as the Postgres trigger saw NEW and OLD. */
  new: Values | null
  old: Values | null
  trigger: TriggerMeta
}

export interface TriggerImpl {
  /** BEFORE: return a changed NEW, null to skip the row, or nothing to keep it. */
  before?(e: TriggerEvent): Values | null | void
  after?(e: TriggerEvent): void
}

export interface InsertOptions {
  /** The `columns` parameter: listed columns missing from a row are NULL (unless missingDefault). */
  columns?: string[]
  missingDefault?: boolean
  onConflict?: string[]
  resolution?: 'merge' | 'ignore'
}

/** Rows chosen by a condition on the table (aliased by its own name), or by primary keys. */
export type Where = { sql: string; params: SqlValue[] } | { keys: Key[] }

const isApi = (role: DbRole) => role === 'anon' || role === 'authenticated'

export function mustTable(name: string): TableMeta {
  const t = tableMeta(name)
  if (!t) throw new DbError('42P01', `relation "public.${name}" does not exist`)
  return t
}

function columnOf(name: string, t: TableMeta, c: string): ColumnMeta {
  const col = Object.hasOwn(t.columns, c) ? t.columns[c] : undefined
  if (!col) throw new DbError('PGRST204', `Could not find the '${c}' column of '${name}' in the schema cache`)
  return col
}

export function decodeRow(t: TableMeta, raw: Row): Values {
  const out: Values = {}
  for (const [c, col] of Object.entries(t.columns)) out[c] = decode(raw[c], col)
  return out
}

export function keyWhere(t: TableMeta, alias: string, keys: Key[]): { sql: string; params: SqlValue[] } {
  const cols = t.pk.map((c) => `${alias}.${quoteId(c)}`)
  const sql = cols.length === 1
    ? `${cols[0]} IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`
    : `(${cols.join(', ')}) IN (SELECT ${cols.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(?))`
  return { sql, params: [JSON.stringify(keys)] }
}

const keyOf = (t: TableMeta, raw: Row): Key => t.pk.map((c) => raw[c] as SqlValue)

function readRaw(env: WriteEnv, name: string, t: TableMeta, keys: Key[]): Row[] {
  const w = keyWhere(t, quoteId(name), keys)
  return env.sql.all(`SELECT * FROM main.${quoteId(name)} AS ${quoteId(name)} WHERE ${w.sql}`, w.params)
}

let fallback: ((fn: string) => TriggerImpl | undefined) | null = null

/** Runs triggers without a TypeScript port through the PL/pgSQL interpreter (pg/engine.ts). */
export function setTriggerFallback(fn: (fn: string) => TriggerImpl | undefined): void {
  fallback = fn
}

/** Business triggers of a table for an event, failing when one has no port yet. */
function rowTriggers(name: string, t: TableMeta, op: 'INSERT' | 'UPDATE' | 'DELETE', setColumns?: string[]): Array<{ meta: TriggerMeta; impl: TriggerImpl }> {
  const out: Array<{ meta: TriggerMeta; impl: TriggerImpl }> = []
  for (const tg of t.triggers ?? []) {
    if (!tg.events.includes(op)) continue
    if (op === 'UPDATE' && tg.columns && setColumns && !tg.columns.some((c) => setColumns.includes(c))) continue
    const impl = registry[tg.function] ?? fallback?.(tg.function)
    if (!impl) throw new DbError('0A000', `NOT_PORTED: ${name} ${op.toLowerCase()} needs ${tg.function}() in TypeScript`)
    out.push({ meta: tg, impl })
  }
  return out
}

function runBefore(env: WriteEnv, name: string, list: ReturnType<typeof rowTriggers>, op: TriggerEvent['op'], newRow: Values | null, oldRow: Values | null): Values | null {
  let current = newRow
  for (const { meta, impl } of list) {
    if (meta.timing !== 'BEFORE' || !impl.before) continue
    const r = impl.before({ env, table: name, op, new: current, old: oldRow, trigger: meta })
    if (r === null) return null
    if (r !== undefined) current = r
  }
  return op === 'DELETE' ? oldRow : current
}

function runAfter(env: WriteEnv, name: string, list: ReturnType<typeof rowTriggers>, op: TriggerEvent['op'], newRow: Values | null, oldRow: Values | null): void {
  for (const { meta, impl } of list) {
    if (meta.timing === 'AFTER' && impl.after) impl.after({ env, table: name, op, new: newRow, old: oldRow, trigger: meta })
  }
}

/** Next value of a former Postgres sequence. */
export function nextval(sql: Sql, seq: string): number {
  const r = sql.all('UPDATE _sequences SET value = value + 1 WHERE name = ? RETURNING value', [seq])[0]
  if (!r) throw new DbError('42P01', `relation "${seq}" does not exist`)
  return Number(r.value)
}

function fillValue(env: WriteEnv, col: ColumnMeta): unknown {
  const f = col.fill!
  if ('seq' in f) {
    const n = nextval(env.sql, f.seq)
    if (f.prefix === undefined && f.pad === undefined) return n
    return `${f.prefix ?? ''}${f.pad ? String(n).padStart(f.pad, '0') : n}`
  }
  if ('ctx' in f) return f.ctx === 'merchant' ? env.ctx.merchantId() : env.ctx.uid
  throw new DbError('0A000', `NOT_PORTED: default ${f.expr}`)
}

/** A DEFAULT expression with now() as the request's transaction time (Postgres: every now() in a transaction is the same). */
const atNow = (env: WriteEnv, expr: string) => expr.replaceAll("'now'", `'${env.ctx.now}'`)

/** Evaluates SQLite DEFAULT expressions for columns a BEFORE trigger needs to see. */
function defaults(env: WriteEnv, t: TableMeta, missing: string[]): Values {
  const withDefault = missing.filter((c) => t.columns[c].default !== undefined)
  if (!withDefault.length) return {}
  const raw = env.sql.all(`SELECT ${withDefault.map((c, i) => `${atNow(env, t.columns[c].default!)} AS d${i}`).join(', ')}`)[0]
  return Object.fromEntries(withDefault.map((c, i) => [c, decode(raw[`d${i}`], t.columns[c])]))
}

/** Defaults that read the clock, filled with the transaction time. */
function nowDefaults(env: WriteEnv, t: TableMeta, given: Values): Values {
  const cols = Object.keys(t.columns).filter((c) => !Object.hasOwn(given, c) && t.columns[c].default?.includes("'now'"))
  return cols.length ? defaults(env, t, cols) : {}
}

/** WITH CHECK policies and application checks on rows just written. */
function verify(env: WriteEnv, name: string, t: TableMeta, keys: Key[], cmd: 'INSERT' | 'UPDATE', rows?: Row[]): Row[] {
  const raw = rows ?? readRaw(env, name, t, keys)
  if (t.rls && env.role !== 'service_role') {
    const check = condition(name, env.ctx, cmd, 'check', env.role)
    if (check !== '1') {
      const w = keyWhere(t, quoteId(name), keys)
      const bad = env.sql.all(secure(`SELECT 1 FROM main.${quoteId(name)} AS ${quoteId(name)} WHERE ${w.sql} AND NOT coalesce((${check}), 0) LIMIT 1`, env.ctx, env.role), w.params)
      if (bad.length) throw new DbError('42501', `new row violates row-level security policy for table "${name}"`)
    }
  }
  if (t.checks.length) for (const r of raw) enforceChecks(name, t, decodeRow(t, r))
  return raw
}

// ---------------------------------------------------------------- audit trail

function storeResetActive(sql: Sql, merchant: unknown): boolean {
  return typeof merchant === 'string' && sql.all("SELECT 1 FROM _flags WHERE name = 'store_reset' AND value = ?", [merchant]).length > 0
}

/** public.log_audit */
export function logAudit(env: WriteEnv, action: string, entityType: string, entityId: string | null, oldValues: unknown = null, newValues: unknown = null, metadata: Values = {}): void {
  const uid = env.ctx.uid
  const email = (uid ? env.sql.all('SELECT email FROM profiles WHERE id = ?', [uid])[0]?.email as string | undefined : undefined) ??
    env.ctx.identity.email ?? (env.ctx.isSystem() ? 'system' : null)
  insert({ ...env, role: 'service_role' }, 'audit_logs', [{
    actor_id: uid, actor_email: email, action, entity_type: entityType, entity_id: entityId,
    old_values: oldValues, new_values: newValues, metadata,
  }])
}

function audit(env: WriteEnv, name: string, t: TableMeta, op: 'INSERT' | 'UPDATE' | 'DELETE', oldRow: Values | null, newRow: Values | null): void {
  if (!t.audit || !t.audit.events.includes(op)) return
  if (op === 'DELETE' && storeResetActive(env.sql, oldRow?.merchant_id)) return
  const key = t.audit.key
  if (op === 'INSERT') return logAudit(env, `${name}.insert`, name, newRow![key] == null ? null : String(newRow![key]), null, newRow)
  if (op === 'DELETE') return logAudit(env, `${name}.delete`, name, oldRow![key] == null ? null : String(oldRow![key]), oldRow, null)
  const before: Values = {}
  const after: Values = {}
  for (const c of Object.keys(newRow!)) {
    if (c === 'updated_at') continue
    if (JSON.stringify(newRow![c]) !== JSON.stringify(oldRow![c])) {
      before[c] = oldRow![c]
      after[c] = newRow![c]
    }
  }
  if (!Object.keys(after).length) return
  logAudit(env, `${name}.update`, name, newRow![key] == null ? null : String(newRow![key]), before, after)
}

// ---------------------------------------------------------------- insert

export function insert(env: WriteEnv, name: string, rows: Values[], opts: InsertOptions = {}): Key[] {
  const t = mustTable(name)
  if (isApi(env.role)) {
    requireGrant(name, env.ctx, 'insert', env.role)
    if (opts.resolution === 'merge') requireGrant(name, env.ctx, 'update', env.role)
  }
  const hooks = rowTriggers(name, t, 'INSERT')
  const keys: Key[] = []
  for (const input of rows) {
    for (const c of Object.keys(input)) {
      const col = columnOf(name, t, c)
      if (col.generated) throw new DbError('428C9', `cannot insert a non-DEFAULT value into column "${c}"`)
    }
    // Upsert: an existing row with the same conflict key is updated or left alone.
    if (opts.resolution) {
      const conflict = opts.onConflict ?? t.pk
      const present = conflict.every((c) => Object.hasOwn(input, c) || t.columns[c]?.fill)
      if (present) {
        const probe = conflict.map((c) => encode(Object.hasOwn(input, c) ? input[c] : fillValue(env, t.columns[c]), t.columns[c]))
        const found = env.sql.all(`SELECT * FROM main.${quoteId(name)} WHERE ${conflict.map((c) => `${quoteId(c)} IS ?`).join(' AND ')} LIMIT 1`, probe)[0]
        if (found) {
          if (opts.resolution === 'ignore') continue
          const set: Values = {}
          for (const c of opts.columns ?? Object.keys(input)) if (!conflict.includes(c)) set[c] = Object.hasOwn(input, c) ? input[c] : null
          const key = keyOf(t, found)
          if (Object.keys(set).length) {
            const updated = update(env, name, set, { keys: [key] })
            if (!updated.length) throw new DbError('42501', `new row violates row-level security policy (USING expression) for table "${name}"`)
          }
          keys.push(key)
          continue
        }
      }
    }
    // The values to write: given ones, NULL for listed-but-missing, server-filled ones.
    const given: Values = { ...input }
    for (const c of opts.columns ?? []) if (!Object.hasOwn(given, c) && !opts.missingDefault) given[c] = null
    for (const [c, col] of Object.entries(t.columns)) {
      if (!Object.hasOwn(given, c) && col.fill) given[c] = fillValue(env, col)
    }
    Object.assign(given, nowDefaults(env, t, given))
    let newRow: Values = given
    if (hooks.some((h) => h.meta.timing === 'BEFORE')) {
      const missing = Object.keys(t.columns).filter((c) => !Object.hasOwn(given, c) && !t.columns[c].generated && !t.columns[c].identity)
      const full = { ...defaults(env, t, missing), ...given }
      const changed = runBefore(env, name, hooks, 'INSERT', full, null)
      if (changed === null) continue
      newRow = changed
    }
    const cols = Object.keys(newRow).filter((c) => !t.columns[c].generated && !(t.columns[c].identity && newRow[c] == null))
    const params = cols.map((c) => encode(newRow[c], t.columns[c]))
    const sql = cols.length
      ? `INSERT INTO main.${quoteId(name)} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`
      : `INSERT INTO main.${quoteId(name)} DEFAULT VALUES RETURNING *`
    const raw = env.sql.all(sql, params)
    const key = keyOf(t, raw[0])
    verify(env, name, t, [key], 'INSERT', raw)
    const decoded = decodeRow(t, raw[0])
    audit(env, name, t, 'INSERT', null, decoded)
    runAfter(env, name, hooks, 'INSERT', decoded, null)
    keys.push(key)
  }
  return keys
}

// ---------------------------------------------------------------- update

function target(env: WriteEnv, name: string, t: TableMeta, where: Where, cmd: 'UPDATE' | 'DELETE'): Row[] {
  const alias = quoteId(name)
  const w = 'keys' in where ? keyWhere(t, alias, where.keys) : where
  const using = t.rls ? condition(name, env.ctx, cmd, 'using', env.role) : '1'
  const visible = t.rls ? condition(name, env.ctx, 'SELECT', 'using', env.role) : '1'
  return env.sql.all(secure(`SELECT * FROM main.${alias} AS ${alias} WHERE (${w.sql}) AND (${using}) AND (${visible})`, env.ctx, env.role), w.params)
}

export function update(env: WriteEnv, name: string, set: Values, where: Where): Key[] {
  const t = mustTable(name)
  if (isApi(env.role)) requireGrant(name, env.ctx, 'update', env.role)
  const changes: Values = {}
  for (const [c, v] of Object.entries(set)) {
    const col = columnOf(name, t, c)
    if (col.generated) throw new DbError('428C9', `column "${c}" can only be updated to DEFAULT`)
    changes[c] = v
  }
  if (t.updatedAt) changes.updated_at = env.ctx.now
  const rows = target(env, name, t, where, 'UPDATE')
  if (!rows.length) return []
  const hooks = rowTriggers(name, t, 'UPDATE', Object.keys(set))
  const perRow = hooks.length > 0 || Boolean(t.audit)
  const keys = rows.map((r) => keyOf(t, r))
  if (!perRow) {
    const cols = Object.keys(changes)
    if (cols.length) {
      const w = keyWhere(t, quoteId(name), keys)
      env.sql.run(`UPDATE main.${quoteId(name)} AS ${quoteId(name)} SET ${cols.map((c) => `${quoteId(c)} = ?`).join(', ')} WHERE ${w.sql}`,
        [...cols.map((c) => encode(changes[c], t.columns[c])), ...w.params])
    }
    verify(env, name, t, keys, 'UPDATE')
    return keys
  }
  const done: Key[] = []
  for (const row of rows) {
    const oldRow = decodeRow(t, row)
    let newRow: Values | null = { ...oldRow, ...changes }
    newRow = runBefore(env, name, hooks, 'UPDATE', newRow, oldRow)
    if (newRow === null) continue
    const cols = Object.keys(newRow).filter((c) => !t.columns[c].generated && JSON.stringify(newRow![c]) !== JSON.stringify(oldRow[c]) || Object.hasOwn(changes, c))
      .filter((c) => !t.columns[c].generated)
    const key = keyOf(t, row)
    if (cols.length) {
      const w = keyWhere(t, quoteId(name), [key])
      env.sql.run(`UPDATE main.${quoteId(name)} AS ${quoteId(name)} SET ${cols.map((c) => `${quoteId(c)} = ?`).join(', ')} WHERE ${w.sql}`,
        [...cols.map((c) => encode(newRow![c], t.columns[c])), ...w.params])
    }
    const raw = verify(env, name, t, [key], 'UPDATE')
    const written = decodeRow(t, raw[0])
    audit(env, name, t, 'UPDATE', oldRow, written)
    runAfter(env, name, hooks, 'UPDATE', written, oldRow)
    done.push(key)
  }
  return done
}

// ---------------------------------------------------------------- delete

export function remove(env: WriteEnv, name: string, where: Where): Values[] {
  const t = mustTable(name)
  if (isApi(env.role)) requireGrant(name, env.ctx, 'delete', env.role)
  const rows = target(env, name, t, where, 'DELETE')
  if (!rows.length) return []
  const hooks = rowTriggers(name, t, 'DELETE')
  const removed: Values[] = []
  const keys: Key[] = []
  for (const row of rows) {
    const oldRow = decodeRow(t, row)
    if (runBefore(env, name, hooks, 'DELETE', null, oldRow) === null) continue
    removed.push(oldRow)
    keys.push(keyOf(t, row))
  }
  if (!keys.length) return []
  const w = keyWhere(t, quoteId(name), keys)
  env.sql.run(`DELETE FROM main.${quoteId(name)} AS ${quoteId(name)} WHERE ${w.sql}`, w.params)
  for (const oldRow of removed) {
    audit(env, name, t, 'DELETE', oldRow, null)
    runAfter(env, name, hooks, 'DELETE', null, oldRow)
  }
  return removed
}

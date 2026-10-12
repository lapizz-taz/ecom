// Runs one SQL statement: SELECT through the compiler; INSERT / UPDATE / DELETE pick
// their rows with SQL and write them through the data layer (writer.ts), so table
// privileges, row security, checks, the audit trail and triggers apply exactly as for
// any other write. RETURNING is computed from the rows as written.
import { randomUUID } from 'node:crypto'
import type { SqlValue } from '../codec.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import { table as tableMeta, type TableMeta } from '../meta.ts'
import type { Row } from '../sql.ts'
import { decodeRow, insert, keyWhere, mustTable, remove, update, type Key, type Values, type WriteEnv } from '../writer.ts'
import type { Delete, Expr, Insert, Select, SelItem, Statement, Update } from './ast.ts'
import { columnType, decodeSql, encodeSql } from './bridge.ts'
import { Compiler, columnName, SRF, walk, type OutCol } from './compile.ts'
import { Evaluator } from './evaluate.ts'
import { runSql } from './run.ts'
import { NotSupported, type Engine, type Typed, type Vars } from './runtime.ts'
import { cast, JNULL, PgRow, plainValue } from './values.ts'

export interface ResultSet {
  cols: OutCol[]
  rows: unknown[][]
  /** Rows returned, or rows written for INSERT / UPDATE / DELETE. */
  count: number
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
}

const qi = quoteId

export function execStatement(engine: Engine, st0: Statement, vars: Vars, params: Typed[] = []): ResultSet {
  const st = materializeWith(engine, st0, vars, params)
  switch (st.k) {
    case 'insert': return execInsert(engine, st, vars, params)
    case 'update': return execUpdate(engine, st, vars, params)
    case 'delete': return execDelete(engine, st, vars, params)
    default: return execQuery(engine, st, vars, params)
  }
}

/**
 * WITH x AS (INSERT/UPDATE/DELETE … RETURNING …): those statements run first, in
 * order, and the main statement reads their RETURNING rows as constants.
 */
function materializeWith(engine: Engine, st: Statement, vars: Vars, params: Typed[]): Statement {
  const w = (st as Select).with
  if (!w || !w.ctes.some((c) => c.q.k === 'insert' || c.q.k === 'update' || c.q.k === 'delete')) return st
  const ctes: NonNullable<Select['with']>['ctes'] = []
  for (const c of w.ctes) {
    if (c.q.k !== 'insert' && c.q.k !== 'update' && c.q.k !== 'delete') {
      ctes.push(c)
      continue
    }
    const inner = ctes.length ? { ...c.q, with: { recursive: w.recursive, ctes: [...ctes] } } : c.q
    const res = execStatement(engine, inner, vars, params)
    const names = res.cols.map((col, i) => c.cols?.[i] ?? col.name)
    const q: Select = res.rows.length
      ? { k: 'select', items: [{ e: { k: 'star' } }], from: [{ k: 'subq', alias: '_dml', cols: names, lateral: false,
        q: { k: 'values', rows: res.rows.map((r) => r.map((v, i) => ({ k: 'value', v, type: res.cols[i].t }) as Expr)), orderBy: [] } }], groupBy: [], orderBy: [] }
      : { k: 'select', items: res.cols.map((col, i) => ({ e: { k: 'value', v: null, type: col.t } as Expr, alias: names[i] })), from: [], where: { k: 'lit', v: false, type: 'bool' }, groupBy: [], orderBy: [] }
    ctes.push({ name: c.name, cols: names, q })
  }
  return { ...st, with: { recursive: w.recursive, ctes } } as Statement
}

/** A query without FROM computed in JavaScript (the usual `SELECT f(x)` / `SELECT a, b INTO …`). */
function simpleSelect(st: Statement): st is Select {
  return st.k === 'select' && !st.from.length && !st.groupBy.length && !st.having && !st.orderBy.length && !st.distinct && !st.with &&
    st.items.every((it) => it.e.k !== 'star' && !hasSrf(it.e)) && st.limit === undefined && st.offset === undefined
}

function hasSrf(e: Expr): boolean {
  let found = false
  walk(e, (x) => {
    if (x.k === 'call' && !x.schema && SRF.has(x.name)) found = true
    return x.k !== 'sub' && x.k !== 'exists' && x.k !== 'arraysub'
  })
  return found
}

export function execQuery(engine: Engine, q: Statement, vars: Vars, params: Typed[] = []): ResultSet {
  if (simpleSelect(q)) {
    const ev = new Evaluator(engine, vars, params)
    if (q.where && !ev.truth(ev.eval(q.where))) {
      return { cols: q.items.map((it) => ({ name: it.alias ?? columnName(it.e), t: 'unknown' })), rows: [], count: 0, command: 'SELECT' }
    }
    const values = q.items.map((it) => ev.eval(it.e))
    return {
      cols: q.items.map((it, i) => ({ name: it.alias ?? columnName(it.e), t: values[i].t === 'unknown' ? 'text' : values[i].t, s: values[i].s })),
      rows: [values.map((v) => v.v)],
      count: 1,
      command: 'SELECT',
    }
  }
  if (q.k === 'insert' || q.k === 'update' || q.k === 'delete') throw new NotSupported('a write inside a query')
  const c = new Compiler(engine, vars, params)
  const compiled = c.query(q, null, true)
  const raw = runSql(engine, compiled.sql, c.params)
  const rows = raw.map((r) => compiled.cols.map((col, i) => decodeSql(r[`c${i}`], col.t)))
  return { cols: compiled.cols, rows, count: rows.length, command: 'SELECT' }
}

// ---------------------------------------------------------------- writes

function env(engine: Engine): WriteEnv {
  return { sql: engine.sql, ctx: engine.ctx, role: engine.role }
}

function rowTypes(t: TableMeta): Record<string, string> {
  return Object.fromEntries(Object.entries(t.columns).map(([c, m]) => [c, columnType(m)]))
}

/** A table row (as the writer returns it) as a typed row value. */
export function tableRow(name: string, values: Values): PgRow {
  const t = tableMeta(name)!
  const types = rowTypes(t)
  const out: Record<string, unknown> = {}
  for (const c of Object.keys(t.columns)) {
    const v = values[c]
    out[c] = v === undefined ? null : types[c] === 'jsonb' && v === null && Object.hasOwn(values, c) ? null : v
  }
  return new PgRow(out, types)
}

/** A typed value as the writer expects it for a column. */
function forColumn(v: Typed, colType: string): unknown {
  if (v.v === null) return null
  const t = v.t === 'unknown' ? 'text' : v.t
  const value = t === colType ? v.v : cast(v.v, t, colType)
  return plainForWriter(value)
}

function plainForWriter(v: unknown): unknown {
  if (v === JNULL) return JNULL
  if (v instanceof PgRow) return v.plain()
  if (Array.isArray(v)) return v.map((x) => (x instanceof PgRow ? x.plain() : x))
  return v
}

/** Variables for RETURNING / ON CONFLICT: the row's columns by name and by alias, then the outer ones. */
class RowVars implements Vars {
  constructor(private readonly rows: Map<string, PgRow>, private readonly outer: Vars, private readonly bare: PgRow | null) {}

  lookup(parts: string[]): Typed | null {
    if (parts.length === 3 && parts[0] === 'public') parts = parts.slice(1)
    if (parts.length === 1 && this.bare && Object.hasOwn(this.bare.values, parts[0])) {
      return { t: this.bare.types[parts[0]], v: this.bare.values[parts[0]] }
    }
    if (parts.length === 2) {
      const r = this.rows.get(parts[0])
      if (r) {
        if (!Object.hasOwn(r.values, parts[1])) throw new DbError('42703', `column ${parts[0]}.${parts[1]} does not exist`)
        return { t: r.types[parts[1]], v: r.values[parts[1]] }
      }
    }
    if (parts.length === 1) {
      const r = this.rows.get(parts[0])
      if (r) return { t: 'record', v: r }
    }
    return this.outer.lookup(parts)
  }
}

function returning(engine: Engine, items: SelItem[], alias: string, rows: PgRow[], vars: Vars, params: Typed[]): { cols: OutCol[]; rows: unknown[][] } {
  const out: unknown[][] = []
  let cols: OutCol[] = []
  for (const row of rows) {
    const rv = new RowVars(new Map([[alias, row]]), vars, row)
    const ev = new Evaluator(engine, rv, params)
    const values: Typed[] = []
    const names: string[] = []
    for (const it of items) {
      if (it.e.k === 'star') {
        for (const [c, v] of Object.entries(row.values)) {
          values.push({ t: row.types[c], v })
          names.push(c)
        }
      } else {
        values.push(ev.eval(it.e))
        names.push(it.alias ?? columnName(it.e))
      }
    }
    cols = names.map((n, i) => ({ name: n, t: values[i].t }))
    out.push(values.map((v) => v.v))
  }
  if (!rows.length) {
    cols = items.flatMap((it) => (it.e.k === 'star' ? [] : [{ name: it.alias ?? columnName(it.e), t: 'unknown' }]))
  }
  return { cols, rows: out }
}

function readRows(engine: Engine, name: string, keys: Key[]): PgRow[] {
  if (!keys.length) return []
  const t = tableMeta(name)!
  const w = keyWhere(t, qi(name), keys)
  const raw = engine.sql.all(`SELECT * FROM main.${qi(name)} AS ${qi(name)} WHERE ${w.sql}`, w.params)
  const byKey = new Map(raw.map((r) => [JSON.stringify(t.pk.map((c) => r[c])), r]))
  return keys.map((k) => byKey.get(JSON.stringify(k))).filter((r): r is Row => Boolean(r)).map((r) => tableRow(name, decodeRow(t, r)))
}

function execInsert(engine: Engine, st: Insert, vars: Vars, params: Typed[]): ResultSet {
  if (st.schema === 'auth' && st.table === 'users') return insertUsers(engine, st, vars, params)
  if (st.schema === 'vault') throw new NotSupported('INSERT into vault (use vault.create_secret)')
  if (st.with) {
    if (st.source === 'default' || st.source.k === 'values') throw new NotSupported('INSERT … VALUES with WITH')
    st = { ...st, source: { ...st.source, with: st.with } as Select, with: undefined }
  }
  const t = mustTable(st.table)
  const colTypes = rowTypes(t)
  const cols = st.cols ?? Object.keys(t.columns).filter((c) => !t.columns[c].generated)
  for (const c of cols) if (!Object.hasOwn(t.columns, c)) throw new DbError('42703', `column "${c}" of relation "${st.table}" does not exist`)
  // the rows to insert (undefined = DEFAULT)
  let rows: Array<Array<Typed | undefined>>
  if (st.source === 'default') rows = [[]]
  else if (st.source.k === 'values' && !st.source.orderBy.length && st.source.limit === undefined) {
    const ev = new Evaluator(engine, vars, params)
    rows = st.source.rows.map((r) => r.map((e) => (e.k === 'default' ? undefined : ev.eval(e))))
  } else {
    const res = execQuery(engine, st.source, vars, params)
    rows = res.rows.map((r) => r.map((v, i) => ({ t: res.cols[i]?.t ?? 'unknown', v })))
  }
  const w = env(engine)
  const alias = st.alias ?? st.table
  const written: PgRow[] = []
  let count = 0
  for (const r of rows) {
    if (r.length > cols.length) throw new DbError('42601', 'INSERT has more expressions than target columns')
    const values: Values = {}
    cols.forEach((c, i) => {
      const v = r[i]
      if (v !== undefined) values[c] = forColumn(v, colTypes[c])
    })
    let key: Key | null = null
    let updatedKey: Key | null = null
    if (st.conflict) {
      const existing = findConflict(engine, st, t, values)
      if (existing) {
        const action = st.conflict.action
        if (action === 'nothing') continue
        const current = tableRow(st.table, decodeRow(t, existing))
        const excluded = tableRow(st.table, values)
        const rv = new RowVars(new Map([[alias, current], ['excluded', excluded]]), vars, current)
        const ev = new Evaluator(engine, rv, params)
        if (action.where && !ev.truth(ev.eval(action.where))) continue
        const set: Values = {}
        for (const item of action.set) assign(item.cols, ev.eval(item.e), set, colTypes, st.table)
        const k = t.pk.map((c) => existing[c] as SqlValue)
        const done = Object.keys(set).length ? update(w, st.table, set, { keys: [k] }) : [k]
        if (!done.length) throw new DbError('42501', `new row violates row-level security policy (USING expression) for table "${st.table}"`)
        key = k
        updatedKey = k
      }
    }
    if (!key) {
      const keys = insert(w, st.table, [values])
      if (!keys.length) continue
      key = keys[0]
    }
    count++
    if (st.returning) {
      // xmax = 0 tells an inserted row from an updated one (… RETURNING (xmax = 0) AS inserted)
      for (const r of readRows(engine, st.table, [key])) {
        r.values.xmax = updatedKey === key ? 1 : 0
        r.types.xmax = 'int'
        written.push(r)
      }
    }
  }
  engine.ctx.reset()
  if (!st.returning) return { cols: [], rows: [], count, command: 'INSERT' }
  const ret = returning(engine, st.returning, alias, written, vars, params)
  return { ...ret, count, command: 'INSERT' }
}

function assign(cols: string[], v: Typed, set: Values, colTypes: Record<string, string>, tableName: string): void {
  if (cols.length === 1) {
    if (!Object.hasOwn(colTypes, cols[0])) throw new DbError('42703', `column "${cols[0]}" of relation "${tableName}" does not exist`)
    set[cols[0]] = forColumn(v, colTypes[cols[0]])
    return
  }
  const row = v.v as PgRow | null
  if (!(row instanceof PgRow)) throw new NotSupported('multi-column SET from a non-row value')
  const vals = Object.values(row.values)
  const types = Object.values(row.types)
  cols.forEach((c, i) => {
    set[c] = forColumn({ t: types[i], v: vals[i] }, colTypes[c])
  })
}

/** The existing row an INSERT … ON CONFLICT collides with, if any. */
function findConflict(engine: Engine, st: Insert, t: TableMeta, values: Values): Row | null {
  const c = st.conflict!
  let candidates: Array<{ cols: string[]; where?: string }>
  if (c.target && c.target.some((e) => e.k !== 'ref')) return findConflictByExpr(engine, st, t, values)
  if (c.target) {
    const cols = c.target.map((e) => (e as { parts: string[] }).parts[(e as { parts: string[] }).parts.length - 1])
    const partial = t.partialUnique?.find((p) => p.columns.join(',') === cols.join(','))
    candidates = [{ cols, where: partial && c.where ? partial.where : partial?.where }]
  } else if (c.constraint) {
    const entry = Object.entries(t.uniqueNames ?? {}).find(([, n]) => n === c.constraint)
    if (!entry) throw new DbError('42704', `constraint "${c.constraint}" for table "${st.table}" does not exist`)
    candidates = [{ cols: entry[0].split(',') }]
  } else {
    candidates = [{ cols: t.pk }, ...t.unique.map((u) => ({ cols: u })), ...(t.partialUnique ?? []).map((p) => ({ cols: p.columns, where: p.where }))]
  }
  for (const cand of candidates) {
    const probe: SqlValue[] = []
    let complete = true
    for (const col of cand.cols) {
      const meta = t.columns[col]
      let v = Object.hasOwn(values, col) ? values[col] : undefined
      if (v === undefined && meta?.fill && 'ctx' in meta.fill) v = meta.fill.ctx === 'merchant' ? engine.ctx.merchantId() : engine.ctx.uid
      if (v === undefined || v === null) {
        complete = false
        break
      }
      probe.push(encodeSql(v, columnType(meta)))
    }
    if (!complete) continue
    const where = cand.cols.map((col) => `${qi(col)} = ?`).join(' AND ')
    const found = engine.sql.all(`SELECT * FROM main.${qi(st.table)} WHERE ${where}${cand.where ? ` AND (${cand.where})` : ''} LIMIT 1`, probe)[0]
    if (found) return found
  }
  return null
}

/** ON CONFLICT (a, lower(b)): the existing row whose target expressions equal the new row's. */
function findConflictByExpr(engine: Engine, st: Insert, t: TableMeta, values: Values): Row | null {
  const newRow = tableRow(st.table, values)
  const ev = new Evaluator(engine, new RowVars(new Map([[st.table, newRow]]), NO_ROW_VARS, newRow))
  const conds: Expr[] = []
  for (const e of st.conflict!.target!) {
    const v = ev.eval(e)
    if (v.v === null) return null
    conds.push({ k: 'bin', op: '=', l: e, r: { k: 'value', v: v.v, type: v.t } })
  }
  const where = conds.reduce((a, b) => ({ k: 'bin', op: 'and', l: a, r: b }) as Expr)
  const saved = engine.role
  engine.role = 'service_role'
  try {
    const c = new Compiler(engine, NO_ROW_VARS)
    const q: Select = { k: 'select', items: t.pk.map((p) => ({ e: { k: 'ref', parts: [st.table, p] } as Expr })), from: [{ k: 'table', name: st.table }], where, groupBy: [], orderBy: [], limit: { k: 'lit', v: 1, type: 'int' } }
    const compiled = c.select(q, null, true)
    const hit = runSql(engine, compiled.sql, c.params)[0]
    if (!hit) return null
    const key = t.pk.map((_, i) => hit[`c${i}`] as SqlValue)
    return engine.sql.all(`SELECT * FROM main.${qi(st.table)} WHERE ${t.pk.map((p) => `${qi(p)} = ?`).join(' AND ')}`, key)[0] ?? null
  } finally {
    engine.role = saved
  }
}

const NO_ROW_VARS: Vars = { lookup: () => null }

function pickRows(engine: Engine, name: string, alias: string, from: Select['from'], where: Expr | undefined, extra: Expr[], vars: Vars, params: Typed[], withClause?: Select['with']): { keys: Key[]; values: Typed[][] } {
  const t = mustTable(name)
  const items: SelItem[] = [
    ...t.pk.map((c) => ({ e: { k: 'ref', parts: [alias, c] } as Expr, alias: `__k_${c}` })),
    ...extra.map((e, i) => ({ e, alias: `__v${i}` })),
  ]
  const q: Select = { k: 'select', with: withClause, items, from: [{ k: 'table', name, alias }, ...from], where, groupBy: [], orderBy: [] }
  const c = new Compiler(engine, vars, params)
  const compiled = c.select(q, null, true)
  const raw = runSql(engine, compiled.sql, c.params)
  const seen = new Set<string>()
  const keys: Key[] = []
  const values: Typed[][] = []
  for (const r of raw) {
    const key = t.pk.map((_, i) => r[`c${i}`] as SqlValue)
    const id = JSON.stringify(key)
    if (seen.has(id)) continue
    seen.add(id)
    keys.push(key)
    values.push(extra.map((_, i) => {
      const col = compiled.cols[t.pk.length + i]
      return { t: col.t, v: decodeSql(r[`c${t.pk.length + i}`], col.t) }
    }))
  }
  return { keys, values }
}

function execUpdate(engine: Engine, st: Update, vars: Vars, params: Typed[]): ResultSet {
  if (st.schema === 'auth' && st.table === 'users') return updateUsers(engine, st, vars, params)
  if (st.schema === 'vault') throw new NotSupported('UPDATE vault (use vault.update_secret)')
  const t = mustTable(st.table)
  const colTypes = rowTypes(t)
  const alias = st.alias ?? st.table
  const exprs: Expr[] = []
  const targets: string[][] = []
  for (const item of st.set) {
    if (item.e.k === 'default') throw new NotSupported('SET column = DEFAULT')
    if (item.cols.length > 1) {
      if (item.e.k !== 'row') throw new NotSupported('SET (a, b) = (SELECT …)')
      item.e.items.forEach((e, i) => {
        exprs.push(e)
        targets.push([item.cols[i]])
      })
    } else {
      exprs.push(item.e)
      targets.push(item.cols)
    }
  }
  for (const [c] of targets) if (!Object.hasOwn(colTypes, c)) throw new DbError('42703', `column "${c}" of relation "${st.table}" does not exist`)
  const w = env(engine)
  const done: Key[] = []
  if (!st.from.length) {
    // New values per row in JavaScript, from the row as it was (Postgres semantics, any function).
    const cols = Object.keys(t.columns)
    const picked = pickRows(engine, st.table, alias, [], st.where, cols.map((c) => ({ k: 'ref', parts: [alias, c] }) as Expr), vars, params, st.with)
    picked.keys.forEach((key, i) => {
      const row = new PgRow(Object.fromEntries(cols.map((c, j) => [c, picked.values[i][j].v])), Object.fromEntries(cols.map((c, j) => [c, picked.values[i][j].t])))
      const ev = new Evaluator(engine, new RowVars(new Map([[alias, row]]), vars, row), params)
      const set: Values = {}
      targets.forEach(([c], j) => {
        set[c] = forColumn(ev.eval(exprs[j]), colTypes[c])
      })
      done.push(...update(w, st.table, set, { keys: [key] }))
    })
  } else {
    const picked = pickRows(engine, st.table, alias, st.from, st.where, exprs, vars, params, st.with)
    picked.keys.forEach((key, i) => {
      const set: Values = {}
      targets.forEach(([c], j) => {
        set[c] = forColumn(picked.values[i][j], colTypes[c])
      })
      done.push(...update(w, st.table, set, { keys: [key] }))
    })
  }
  engine.ctx.reset()
  if (!st.returning) return { cols: [], rows: [], count: done.length, command: 'UPDATE' }
  const ret = returning(engine, st.returning, alias, readRows(engine, st.table, done), vars, params)
  return { ...ret, count: done.length, command: 'UPDATE' }
}

function execDelete(engine: Engine, st: Delete, vars: Vars, params: Typed[]): ResultSet {
  if (st.schema === 'auth' && st.table === 'users') return deleteRaw(engine, 'users', st, vars, params)
  if (st.schema === 'vault') return deleteRaw(engine, '_vault_secrets', st, vars, params)
  const alias = st.alias ?? st.table
  const picked = pickRows(engine, st.table, alias, st.using, st.where, [], vars, params, st.with)
  const removed = picked.keys.length ? remove(env(engine), st.table, { keys: picked.keys }) : []
  engine.ctx.reset()
  if (!st.returning) return { cols: [], rows: [], count: removed.length, command: 'DELETE' }
  const ret = returning(engine, st.returning, alias, removed.map((r) => tableRow(st.table, r)), vars, params)
  return { ...ret, count: removed.length, command: 'DELETE' }
}

// ---------------------------------------------------------------- auth.users and vault

function requireSystem(engine: Engine, what: string): void {
  if (engine.role === 'anon' || engine.role === 'authenticated') throw new DbError('42501', `permission denied for ${what}`)
}

const USER_COLUMNS: Record<string, string> = { raw_user_meta_data: 'user_metadata', raw_app_meta_data: 'app_metadata' }

function insertUsers(engine: Engine, st: Insert, vars: Vars, params: Typed[]): ResultSet {
  requireSystem(engine, 'table users')
  if (st.source === 'default' || st.source.k !== 'values') throw new NotSupported('INSERT INTO auth.users … SELECT')
  const ev = new Evaluator(engine, vars, params)
  const cols = st.cols ?? []
  let count = 0
  for (const r of st.source.rows) {
    const v: Record<string, unknown> = {}
    cols.forEach((c, i) => {
      const x = r[i]
      if (x && x.k !== 'default') v[c] = ev.eval(x).v
    })
    const json = (x: unknown) => (x === null || x === undefined ? {} : typeof x === 'string' ? JSON.parse(x) : x)
    const app = json(v.raw_app_meta_data) as Record<string, unknown>
    engine.sql.run(`INSERT INTO users (id, email, phone, clerk_user_id, user_metadata, app_metadata, email_confirmed_at, banned_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`, [
      String(v.id ?? randomUUID()).toLowerCase(), v.email ? String(v.email).toLowerCase() : null, (v.phone as string | undefined) ?? null,
      typeof app.clerk_user_id === 'string' ? app.clerk_user_id : null, JSON.stringify(json(v.raw_user_meta_data)), JSON.stringify(app),
      v.email_confirmed_at ? String(cast(v.email_confirmed_at, 'text', 'timestamptz')) : null,
      v.banned_until ? String(cast(v.banned_until, 'text', 'timestamptz')) : null,
      v.created_at ? String(cast(v.created_at, 'text', 'timestamptz')) : null,
    ])
    count++
  }
  return { cols: [], rows: [], count, command: 'INSERT' }
}

function updateUsers(engine: Engine, st: Update, vars: Vars, params: Typed[]): ResultSet {
  requireSystem(engine, 'table users')
  const alias = st.alias ?? 'users'
  const c = new Compiler(engine, vars, params)
  const items: SelItem[] = [{ e: { k: 'ref', parts: [alias, 'id'] }, alias: 'id' }, ...st.set.map((s, i) => ({ e: s.e, alias: `v${i}` }))]
  const compiled = c.select({ k: 'select', items, from: [{ k: 'table', schema: 'auth', name: 'users', alias }, ...st.from], where: st.where, groupBy: [], orderBy: [] }, null, true)
  const rows = runSql(engine, compiled.sql, c.params)
  for (const r of rows) {
    const sets: string[] = []
    const vals: SqlValue[] = []
    st.set.forEach((s, i) => {
      const col = USER_COLUMNS[s.cols[0]] ?? s.cols[0]
      sets.push(`${qi(col)} = ?`)
      const v = decodeSql(r[`c${i + 1}`], compiled.cols[i + 1].t)
      vals.push(encodeSql(plainValue(v), compiled.cols[i + 1].t))
    })
    engine.sql.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, r.c0 as string])
  }
  return { cols: [], rows: [], count: rows.length, command: 'UPDATE' }
}

function deleteRaw(engine: Engine, internal: string, st: Delete, vars: Vars, params: Typed[]): ResultSet {
  requireSystem(engine, `table ${st.table}`)
  const alias = st.alias ?? st.table
  const c = new Compiler(engine, vars, params)
  const compiled = c.select({
    k: 'select', items: [{ e: { k: 'ref', parts: [alias, 'id'] }, alias: 'id' }],
    from: [{ k: 'table', schema: st.schema, name: st.table, alias }, ...st.using], where: st.where, groupBy: [], orderBy: [],
  }, null, true)
  const ids = runSql(engine, compiled.sql, c.params).map((r) => r.c0 as string)
  for (const id of ids) engine.sql.run(`DELETE FROM ${qi(internal)} WHERE id = ?`, [id])
  return { cols: [], rows: [], count: ids.length, command: 'DELETE' }
}

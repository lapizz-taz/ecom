// Compiles Postgres queries to SQLite. Sub-expressions that do not depend on table
// columns are computed in JavaScript (evaluate.ts) with Postgres' own semantics and
// bound as parameters; the rest is translated with the types Postgres would give
// them, so JSON, booleans, numeric division and date arithmetic come out the same.
import type { SqlValue } from '../codec.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import { schema as dbSchema, table as tableMeta, view as viewMeta } from '../meta.ts'
import { requireGrant } from '../policy.ts'
import type { CallExpr, Expr, FromItem, OrderItem, Query, Select, SelItem, Values } from './ast.ts'
import { columnDisplay, columnType, decodeSql, encodeSql } from './bridge.ts'
import { aggregates, aggregateType, builtins, numericTextSql, textSql, windowFunctions, windowType, type SqlArg, type SqlHelp } from './builtins.ts'
import type { Row } from '../sql.ts'
import { Evaluator } from './evaluate.ts'
import { runSql } from './run.ts'
import { BIGINT, NotSupported, type Engine, type Typed, type Vars } from './runtime.ts'
import { catalogTable } from './catalog.ts'
import { tempRowsJson, tempTable } from './temp.ts'
import { elemType, isArrayType } from './types.ts'
import { addInterval as addIv, arithScale, cast, castScale, castTyped, Interval, isEnum, isTableType, PgRow, scaleOf, zoneOffset } from './values.ts'

/** An enum value's position among its type's values (declaration order), for sorting. */
const enumValues = (t: string): string[] => dbSchema.enums[t] ?? []

function enumRankSql(x: string, t: string): string {
  return `instr(${str(`,${enumValues(t).join(',')},`)}, ',' || ${x} || ',')`
}

/** The widest display scale among numeric values (a CASE or VALUES column takes it). */
function widestScale(xs: Array<{ t?: string; s?: number }>): number | undefined {
  const known = xs.map((x) => (x.t === 'int' ? 0 : x.s)).filter((s): s is number => s !== undefined)
  return known.length ? Math.max(...known) : undefined
}

export interface OutCol {
  name: string
  t: string
  /** A numeric's display scale (see Typed.s). */
  s?: number
}

export interface Compiled {
  sql: string
  cols: OutCol[]
}

interface Col {
  name: string
  t: string
  sql: string
  s?: number
}

interface Source {
  alias: string
  cols: Col[]
  /** The whole row as one value (t alone, to_jsonb(t), jsonb_agg(t)). */
  whole?: { sql: string; t: string }
}

interface Cte {
  sqlName: string
  cols: OutCol[]
}

export class QScope {
  sources: Source[] = []
  ctes = new Map<string, Cte>()
  /** Conditions added by rewrites (CROSS JOIN LATERAL … LIMIT 1). */
  extraWhere: string[] = []
  /** The FROM items as compiled so far (for per-row lookups computed in JavaScript). */
  fromSql: string[] = []
  /** This level's WITH definitions as SQL (for those lookups). */
  cteSql: string[] = []
  whereSql: string | null = null
  /** GROUP BY of plain expressions (null when it names output columns). */
  groupSql: string | null = ''
  recursive = false
  constructor(readonly parent: QScope | null) {}

  cte(name: string): Cte | undefined {
    for (let s: QScope | null = this; s; s = s.parent) {
      const c = s.ctes.get(name)
      if (c) return c
    }
    return undefined
  }

  hasSources(): boolean {
    for (let s: QScope | null = this; s; s = s.parent) if (s.sources.length) return true
    return false
  }
}

export const SRF = new Set(['jsonb_array_elements', 'json_array_elements', 'jsonb_array_elements_text', 'json_array_elements_text', 'jsonb_each', 'json_each',
  'jsonb_each_text', 'json_each_text', 'jsonb_object_keys', 'json_object_keys', 'unnest', 'generate_series', 'jsonb_to_recordset', 'json_to_recordset',
  'jsonb_populate_recordset', 'jsonb_to_record', 'json_to_record', 'jsonb_populate_record', 'regexp_matches'])

const str = (s: string) => `'${s.replaceAll("'", "''")}'`
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Postgres' name for an unnamed select item. */
export function columnName(e: Expr): string {
  switch (e.k) {
    case 'ref': return e.parts[e.parts.length - 1]
    case 'call': return e.name
    case 'cast': {
      const inner = columnName(e.e)
      return inner === '?column?' ? (e.type.array ? e.type.name : e.type.name === 'int' ? 'int4' : e.type.name === 'bool' ? 'bool' : e.type.name) : inner
    }
    case 'case': return 'case'
    case 'exists': return 'exists'
    case 'array': case 'arraysub': return 'array'
    case 'field': return e.name
    case 'sub': {
      const q = e.q
      if (q.k === 'select' && q.items.length === 1) return q.items[0].alias ?? columnName(q.items[0].e)
      return '?column?'
    }
    case 'value': return '?column?'
    case 'row': return 'row'
    case 'index': return columnName(e.e)
    default: return '?column?'
  }
}

/** Whether an expression contains an aggregate call at this query level. */
export function hasAggregate(e: Expr | undefined): boolean {
  if (!e) return false
  let found = false
  walk(e, (x) => {
    if (x.k === 'call' && !x.over && aggregates.has(x.name) && !x.schema) found = true
    return x.k !== 'sub' && x.k !== 'exists' && x.k !== 'arraysub' && !(x.k === 'in' && x.q) && !(x.k === 'quant' && x.q)
  })
  return found
}

/** A copy of an expression with its direct children mapped (not into sub-queries). */
export function mapExpr(e: Expr, f: (x: Expr) => Expr): Expr {
  const m = (x: Expr | undefined) => (x ? f(x) : x)
  switch (e.k) {
    case 'call': return { ...e, args: e.args.map(f), filter: m(e.filter) }
    case 'bin': return { ...e, l: f(e.l), r: f(e.r) }
    case 'un': case 'is': case 'cast': case 'field': return { ...e, e: f(e.e) } as Expr
    case 'isdistinct': return { ...e, l: f(e.l), r: f(e.r) }
    case 'between': return { ...e, e: f(e.e), lo: f(e.lo), hi: f(e.hi) }
    case 'in': return { ...e, e: f(e.e), list: e.list?.map(f) }
    case 'quant': return { ...e, l: f(e.l), r: m(e.r) }
    case 'like': return { ...e, e: f(e.e), p: f(e.p), escape: m(e.escape) }
    case 'case': return { ...e, subject: m(e.subject), whens: e.whens.map((w) => ({ when: f(w.when), then: f(w.then) })), else: m(e.else) }
    case 'array': case 'row': return { ...e, items: e.items.map(f) }
    case 'index': return { ...e, e: f(e.e), idx: m(e.idx), upper: m(e.upper) }
    case 'attz': return { ...e, e: f(e.e), zone: f(e.zone) }
    default: return e
  }
}

/** Visits an expression tree (not into sub-queries); `fn` returns false to skip children. */
/**
 * An inlined SQL function body with its table aliases made unique (s → s__i7). Its
 * arguments are the caller's compiled SQL ("s"."user_id"); a table of the same alias inside
 * the body would otherwise capture them (s.user_id = p_user becoming always true).
 */
export function uniqueAliases<T>(q: T, suffix: string): T {
  const names = new Set<string>()
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(collect)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (o.k === 'value') return
    if (o.k === 'table' && typeof o.name === 'string') names.add((o.alias as string | undefined) ?? o.name)
    if (o.k === 'subq' && typeof o.alias === 'string') names.add(o.alias)
    for (const v of Object.values(o)) collect(v)
  }
  collect(q)
  const rename = (n: string) => (names.has(n) ? `${n}${suffix}` : n)
  const map = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(map)
    if (!x || typeof x !== 'object') return x
    const o = x as Record<string, unknown>
    if (o.k === 'value' || o.constructor !== Object) return x
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(o)) out[key] = map(v)
    if (out.k === 'table' && typeof out.name === 'string') out.alias = rename((out.alias as string | undefined) ?? out.name)
    else if (out.k === 'subq' && typeof out.alias === 'string') out.alias = rename(out.alias)
    else if (out.k === 'star' && typeof out.table === 'string') out.table = rename(out.table)
    else if (out.k === 'ref') {
      const parts = out.parts as string[]
      if (parts.length >= 2 && names.has(parts[0])) out.parts = [rename(parts[0]), ...parts.slice(1)]
      else if (parts.length === 3 && parts[0] === 'public' && names.has(parts[1])) out.parts = [rename(parts[1]), parts[2]]
    }
    return out
  }
  return map(q) as T
}

export function walk(e: Expr, fn: (x: Expr) => boolean | void): void {
  if (fn(e) === false) return
  const kids: Array<Expr | undefined> = []
  switch (e.k) {
    case 'call': kids.push(...e.args, e.filter, ...(e.order ?? []).map((o) => o.e), ...(e.over?.partition ?? []), ...(e.over?.order ?? []).map((o) => o.e)); break
    case 'bin': kids.push(e.l, e.r); break
    case 'un': kids.push(e.e); break
    case 'is': kids.push(e.e); break
    case 'isdistinct': kids.push(e.l, e.r); break
    case 'between': kids.push(e.e, e.lo, e.hi); break
    case 'in': kids.push(e.e, ...(e.list ?? [])); break
    case 'quant': kids.push(e.l, e.r); break
    case 'like': kids.push(e.e, e.p, e.escape); break
    case 'case': kids.push(e.subject, ...e.whens.flatMap((w) => [w.when, w.then]), e.else); break
    case 'cast': kids.push(e.e); break
    case 'array': case 'row': kids.push(...e.items); break
    case 'field': kids.push(e.e); break
    case 'index': kids.push(e.e, e.idx, e.upper); break
    case 'attz': kids.push(e.e, e.zone); break
    case 'quantarg': kids.push(e.e); break
  }
  for (const k of kids) if (k) walk(k, fn)
}

export class Compiler implements SqlHelp {
  readonly params: SqlValue[] = []
  private cteCount = 0
  private readonly evaluator: Evaluator
  /** Names inside an inlined SQL function body that stand for SQL fragments (its arguments). */
  private fragments: Array<Map<string, SqlArg>> = []
  /** Inside an inlined SECURITY DEFINER function owned by postgres: tables without row security. */
  private bypass = 0

  constructor(readonly engine: Engine, readonly vars: Vars, readonly stmtParams: Typed[] = [], readonly opts: { literal?: boolean } = {}) {
    this.evaluator = new Evaluator(engine, vars, stmtParams)
  }

  bind(v: unknown, t: string): string {
    const raw = encodeSql(v, t)
    // Views are inlined into other statements as text: constants are written out. So are the
    // constants past the 90th: the Durable Object's SQLite stops at ?100, and a statement with
    // several inlined functions (the order lists) binds more than that.
    if (this.opts.literal || this.params.length >= MAX_BOUND_PARAMS) return sqlLiteral(raw)
    this.params.push(raw)
    return `?${this.params.length}`
  }

  // ---------------------------------------------------------------- queries

  /** A query; `top` uses positional output names (c0, c1 …) so duplicate names survive. */
  query(q: Query, parent: QScope | null, top = false): Compiled {
    if (q.k === 'values') return this.values(q, parent, top)
    if (q.k === 'setop') {
      const scope = new QScope(parent)
      const withSql = q.with ? this.withClause(q.with, scope) : ''
      const l = this.member(q.l, scope, top)
      const r = this.member(q.r, scope, top)
      const cols = l.cols.map((c, i) => ({ name: c.name, t: c.t === 'unknown' ? r.cols[i]?.t ?? 'text' : c.t, s: widestScale([c, r.cols[i] ?? {}]) }))
      let sql = `${l.sql} ${q.op.toUpperCase()}${q.all ? ' ALL' : ''} ${r.sql}`
      if (q.orderBy.length) {
        sql += ` ORDER BY ${q.orderBy.map((o) => {
          let target: string | null = null
          if (o.e.k === 'ref' && o.e.parts.length === 1) {
            const i = cols.findIndex((c) => c.name === (o.e as { parts: string[] }).parts[0])
            if (i >= 0) target = String(i + 1)
          } else if (o.e.k === 'lit' && typeof o.e.v === 'number') target = String(o.e.v)
          if (!target) throw new NotSupported('ORDER BY an expression after UNION')
          return `${target}${o.desc ? ' DESC NULLS FIRST' : ' NULLS LAST'}`
        }).join(', ')}`
      }
      sql += this.limitSql(q.limit, q.offset, scope)
      return { sql: withSql + sql, cols }
    }
    return this.select(q, parent, top)
  }

  private member(q: Query, scope: QScope, top: boolean): Compiled {
    this.members++
    let c: Compiled
    try {
      c = this.query(q, scope, top)
    } finally {
      this.members--
    }
    const own = q.k !== 'values' && (q.orderBy.length > 0 || q.limit !== undefined || q.offset !== undefined)
    return own || q.k === 'setop' ? { sql: `SELECT * FROM (${c.sql})`, cols: c.cols } : c
  }

  private values(q: Values, parent: QScope | null, top: boolean): Compiled {
    const scope = new QScope(parent)
    const rows = q.rows.map((r) => r.map((e) => this.expr(e, scope)))
    const cols = rows[0].map((_a, i) => ({ name: `column${i + 1}`, t: rows.map((r) => r[i].t).find((t) => t !== 'unknown') ?? 'text', s: widestScale(rows.map((r) => r[i])) }))
    const body = `SELECT ${rows[0].map((a, i) => `${a.sql} AS ${top ? qi(`c${i}`) : qi(cols[i].name)}`).join(', ')}${
      rows.slice(1).map((r) => ` UNION ALL SELECT ${r.map((a) => a.sql).join(', ')}`).join('')}`
    return { sql: body + this.limitSql(q.limit, q.offset, scope), cols }
  }

  private withClause(w: NonNullable<Select['with']>, scope: QScope): string {
    const parts: string[] = []
    for (const c of w.ctes) {
      if (c.q.k !== 'select' && c.q.k !== 'setop' && c.q.k !== 'values') throw new NotSupported('a data-modifying WITH query')
      const sqlName = `_cte${++this.cteCount}_${c.name}`
      this.cteNames.add(c.name)
      if (w.recursive && c.q.k === 'setop') {
        // The non-recursive term fixes the columns; then the whole may refer to itself.
        const first = this.query(c.q.l, scope)
        const cols = first.cols.map((col, i) => ({ name: c.cols?.[i] ?? col.name, t: col.t, s: col.s }))
        scope.ctes.set(c.name, { sqlName, cols })
        const all = this.query(c.q, scope)
        parts.push(`${qi(sqlName)}(${cols.map((x) => qi(x.name)).join(', ')}) AS (${all.sql})`)
        scope.cteSql = [...parts]
        continue
      }
      const compiled = this.query(c.q, scope)
      const cols = compiled.cols.map((col, i) => ({ name: c.cols?.[i] ?? col.name, t: col.t, s: col.s }))
      scope.ctes.set(c.name, { sqlName, cols })
      parts.push(`${qi(sqlName)}(${cols.map((x) => qi(x.name)).join(', ')}) AS ${c.materialized === false ? 'NOT MATERIALIZED ' : ''}(${compiled.sql})`)
      // later WITH queries (and their per-row lookups) see this one
      scope.cteSql = [...parts]
    }
    scope.cteSql = [...parts]
    scope.recursive = w.recursive
    return `WITH ${w.recursive ? 'RECURSIVE ' : ''}${parts.join(', ')} `
  }

  private limitSql(limit: Expr | undefined, offset: Expr | undefined, scope: QScope): string {
    let s = ''
    if (limit) s += ` LIMIT ${this.expr(limit, scope).sql}`
    if (offset) s += `${limit ? '' : ' LIMIT -1'} OFFSET ${this.expr(offset, scope).sql}`
    return s
  }

  /** SELECT srf(x) …: the set-returning call becomes a FROM item, as Postgres expands it into rows. */
  private expandSrf(q: Select): Select {
    let found = false
    const from = [...q.from]
    const rewrite = (e: Expr): Expr => {
      if (e.k === 'call' && !e.over && (!e.schema || e.schema === 'pg_catalog') && SRF.has(e.name)) {
        found = true
        const alias = `_srf${++this.cteCount}`
        from.push({ k: 'func', call: e, alias, lateral: true, ordinality: false })
        const col = ['jsonb_array_elements', 'json_array_elements', 'jsonb_array_elements_text', 'json_array_elements_text'].includes(e.name) ? 'value' : alias
        return { k: 'ref', parts: [alias, col] }
      }
      // a user function returning SETOF a scalar gives one row per value too (m.id in (select ids()))
      if (e.k === 'call' && !e.over && (!e.schema || e.schema === 'public') && !builtins[e.name] && this.scalarSetOf(e)) {
        found = true
        const alias = `_srf${++this.cteCount}`
        from.push({ k: 'func', call: e, alias, lateral: true, ordinality: false })
        return { k: 'ref', parts: [alias, alias] }
      }
      return mapExpr(e, rewrite)
    }
    const items = q.items.map((it) => (it.e.k === 'star' ? it : { ...it, e: rewrite(it.e), alias: it.alias ?? columnName(it.e) }))
    return found ? { ...q, items, from } : q
  }

  /** Whether a user function call returns SETOF a scalar type. */
  private scalarSetOf(e: CallExpr): boolean {
    const rt = this.engine.returnType(e.name, e.args.map(() => 'unknown'), e.schema)
    if (!rt?.startsWith('setof ')) return false
    const t = rt.slice(6)
    return t !== 'record' && !isTableType(t)
  }

  select(q0: Select, parent: QScope | null, top = false): Compiled {
    const q = this.expandSrf(q0)
    const scope = new QScope(parent)
    const withSql = q.with ? this.withClause(q.with, scope) : ''
    const from: string[] = []
    for (const f of q.from) {
      from.push(this.fromItem(f, scope))
      scope.fromSql = [...from]
    }
    const where = q.where ? this.cond(q.where, scope) : null
    scope.whereSql = where
    if (q.groupBy.length) {
      const plain = q.groupBy.every((g) => !(g.k === 'lit' && typeof g.v === 'number') && !(g.k === 'ref' && g.parts.length === 1 && !this.findColumn(g.parts, scope)))
      scope.groupSql = plain ? q.groupBy.map((g) => this.expr(g, scope).sql).join(', ') : null
    }
    // select list, with * expanded
    const items: Array<{ sql: string; t: string; name: string; s?: number }> = []
    for (const it of q.items) {
      if (it.e.k === 'star') {
        const star = it.e
        const srcs = star.table ? scope.sources.filter((s) => s.alias === star.table!.split('.').pop()) : scope.sources
        if (star.table && !srcs.length) throw new DbError('42P01', `missing FROM-clause entry for table "${star.table}"`)
        for (const s of srcs) for (const c of s.cols) items.push({ sql: c.sql, t: c.t, name: c.name, s: c.s })
        continue
      }
      const a = this.expr(it.e, scope)
      items.push({ sql: a.sql, t: a.t === 'unknown' ? 'text' : a.t, name: it.alias ?? columnName(it.e), s: a.t === 'numeric' || a.t === 'int' ? a.s : undefined })
    }
    const outName = (i: number) => (top ? qi(`c${i}`) : qi(items[i].name))
    const groupBy = q.groupBy.map((g) => this.groupItem(g, scope, q.items, items))
    const having = q.having ? this.cond(q.having, scope) : null
    const orderBy = q.orderBy.map((o) => this.orderItem(o, scope, items, outName))
    // Rows that tie on ORDER BY, or a query without one, come back in insertion order, as
    // Postgres returns them from a table scan in practice (SQLite would follow whichever index it picks).
    const tie = top && (orderBy.length || !this.members) && !q.groupBy.length && !q.distinct && !q.items.some((it) => hasAggregate(it.e)) ? this.firstTable(q.from[0]) : null
    if (tie) orderBy.push({ expr: `${qi(tie)}.rowid`, ref: `${qi(tie)}.rowid`, dir: '' })
    const conds = [where, ...scope.extraWhere].filter(Boolean)
    const tail = `${from.length ? ` FROM ${from.join(', ')}` : ''}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}${
      groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}${having ? ` HAVING ${having}` : ''}`
    let sql: string
    if (Array.isArray(q.distinct)) {
      // DISTINCT ON (…): the first row of each group in ORDER BY order.
      const on = q.distinct.map((e) => this.expr(e, scope).sql)
      const inner = `SELECT ${items.map((it, i) => `${it.sql} AS ${outName(i)}`).join(', ')}, ${
        orderBy.map((o, i) => `${o.expr} AS "__o${i}"`).concat(['0 AS "__z"']).join(', ')}, row_number() OVER (PARTITION BY ${on.join(', ')}${
        orderBy.length ? ` ORDER BY ${orderBy.map((o) => `${o.expr}${o.dir}`).join(', ')}` : ''}) AS "__rn"${tail}`
      sql = `SELECT ${items.map((_, i) => outName(i)).join(', ')} FROM (${inner}) WHERE "__rn" = 1${
        orderBy.length ? ` ORDER BY ${orderBy.map((o, i) => `"__o${i}"${o.dir}`).join(', ')}` : ''}`
    } else if (parent && orderBy.some((o) => !o.ref)) {
      // SQLite cannot see outer columns in a sub-query's ORDER BY; order an inner select's extra columns instead.
      const inner = `SELECT ${q.distinct ? 'DISTINCT ' : ''}${items.map((it, i) => `${it.sql} AS ${outName(i)}`).concat(
        orderBy.map((o, i) => `${o.expr} AS "__o${i}"`)).join(', ')}${tail}`
      sql = `SELECT ${items.map((_, i) => outName(i)).join(', ')} FROM (${inner}) ORDER BY ${orderBy.map((o, i) => `${o.ref ?? `"__o${i}"`}${o.dir}`).join(', ')}`
    } else {
      sql = `SELECT ${q.distinct ? 'DISTINCT ' : ''}${items.length ? items.map((it, i) => `${it.sql} AS ${outName(i)}`).join(', ') : 'NULL AS "?column?"'}${tail}${
        orderBy.length ? ` ORDER BY ${orderBy.map((o) => `${o.ref ?? o.expr}${o.dir}`).join(', ')}` : ''}`
    }
    sql += this.limitSql(q.limit, q.offset, scope)
    return { sql: withSql + sql, cols: items.map((it) => ({ name: it.name, t: it.t, s: it.s })) }
  }

  /** The alias of the leftmost base table of a FROM item (for ORDER BY tie-breaks). */
  private firstTable(f: FromItem | undefined): string | null {
    if (!f) return null
    if (f.k === 'join') return this.firstTable(f.l)
    if (f.k === 'table' && (!f.schema || f.schema === 'public') && tableMeta(f.name) && !this.cteNames.has(f.name)) return f.alias ?? f.name
    return null
  }

  private cteNames = new Set<string>()
  /** Depth inside UNION/INTERSECT/EXCEPT members, which cannot carry their own ORDER BY. */
  private members = 0
  private containsN = 0

  private groupItem(g: Expr, scope: QScope, raw: SelItem[], items: Array<{ sql: string; name: string }>): string {
    if (g.k === 'lit' && typeof g.v === 'number') return items[g.v - 1]?.sql ?? String(g.v)
    if (g.k === 'ref' && g.parts.length === 1 && !this.findColumn(g.parts, scope)) {
      const i = raw.findIndex((it) => it.alias === g.parts[0])
      if (i >= 0) return items[i].sql
    }
    return this.expr(g, scope).sql
  }

  private orderItem(o: OrderItem, scope: QScope, items: Array<{ sql: string; name: string; t?: string }>, outName: (i: number) => string): { expr: string; ref?: string; dir: string } {
    const dir = o.desc ? (o.nulls === 'last' ? ' DESC NULLS LAST' : ' DESC NULLS FIRST') : o.nulls === 'first' ? ' NULLS FIRST' : ' NULLS LAST'
    // enums sort in the order their values were declared, not alphabetically
    const item = (i: number) => (items[i].t && isEnum(items[i].t!) ? { expr: enumRankSql(items[i].sql, items[i].t!), dir } : { expr: items[i].sql, ref: outName(i), dir })
    if (o.e.k === 'lit' && typeof o.e.v === 'number' && o.e.type === 'int') return item(o.e.v - 1)
    if (o.e.k === 'ref' && o.e.parts.length === 1) {
      const i = items.findIndex((it) => it.name === (o.e as { parts: string[] }).parts[0])
      if (i >= 0) return item(i)
    }
    const x = this.expr(o.e, scope)
    return { expr: isEnum(x.t) ? enumRankSql(x.sql, x.t) : x.sql, dir }
  }

  // ---------------------------------------------------------------- FROM

  private fromItem(f: FromItem, scope: QScope): string {
    switch (f.k) {
      case 'table': return this.tableSource(f, scope)
      case 'subq': {
        if (f.lateral && this.singleRow(f.q)) return this.lateralColumns(f.q, f.alias ?? '_lateral', f.cols, scope, false)
        if (f.lateral) return this.lateralRows(f.q, f.alias ?? '_lateral', f.cols, scope)
        // (a plain sub-query cannot use its siblings' columns, but it sees the WITH queries)
        const c = this.query(f.q, scope)
        const alias = f.alias ?? `_sub${++this.cteCount}`
        const names = c.cols.map((col, i) => f.cols?.[i] ?? col.name)
        // rename through a wrapper when the alias gives column names
        const sql = f.cols ? `(SELECT * FROM (${c.sql})) AS ${qi(alias)}` : `(${c.sql}) AS ${qi(alias)}`
        const inner = f.cols ? `(SELECT ${c.cols.map((col, i) => `${qi(col.name)} AS ${qi(names[i])}`).join(', ')} FROM (${c.sql})) AS ${qi(alias)}` : sql
        this.addSource(scope, alias, c.cols.map((col, i) => ({ name: names[i], t: col.t, s: col.s })))
        return inner
      }
      case 'func': return this.funcSource(f, scope)
      case 'join': {
        const l = this.fromItem(f.l, scope)
        const r = this.fromItem(f.r, scope)
        if (f.type === 'cross') return `${l} CROSS JOIN ${r}`
        const kind = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN' }[f.type]
        if (f.using) return `${l} ${kind} ${r} USING (${f.using.map(qi).join(', ')})`
        return `${l} ${kind} ${r} ON ${f.on ? this.cond(f.on, scope) : '1'}`
      }
    }
  }

  private addSource(scope: QScope, alias: string, cols: OutCol[], table?: string): void {
    const a = qi(alias)
    const columns = cols.map((c) => ({ name: c.name, t: c.t, sql: `${a}.${qi(c.name)}`, s: c.s }))
    scope.sources.push({ alias, cols: columns, whole: this.wholeRow(columns, table) })
  }

  private wholeRow(cols: Col[], table?: string): { sql: string; t: string } {
    return { sql: `json_object(${cols.map((c) => `${str(c.name)}, ${this.json({ sql: c.sql, t: c.t })}`).join(', ')})`, t: table ?? 'record' }
  }

  private tableSource(f: Extract<FromItem, { k: 'table' }>, scope: QScope): string {
    const alias = f.alias ?? f.name
    const cte = !f.schema ? scope.cte(f.name) : undefined
    if (cte) {
      this.addSource(scope, alias, cte.cols.map((c, i) => ({ name: f.cols?.[i] ?? c.name, t: c.t, s: c.s })))
      if (f.cols) {
        const src = scope.sources[scope.sources.length - 1]
        src.cols = src.cols.map((c, i) => ({ ...c, sql: `${qi(alias)}.${qi(cte.cols[i].name)}` }))
      }
      return `${qi(cte.sqlName)} AS ${qi(alias)}`
    }
    const temp = tempTable(this.engine.ctx, f.name, f.schema) ?? catalogTable(f.name, f.schema)
    if (temp) {
      const names = temp.cols.map((c, i) => f.cols?.[i] ?? c.name)
      this.addSource(scope, alias, temp.cols.map((c, i) => ({ name: names[i], t: c.t, s: c.s })))
      const cells = temp.cols.map((_c, i) => `json_extract("_t".value, '$[${i}]') AS ${qi(names[i])}`)
      return `(SELECT ${cells.join(', ')} FROM json_each(${this.bind(tempRowsJson(temp), 'text')}) AS "_t") AS ${qi(alias)}`
    }
    if (f.schema === 'auth' && f.name === 'users') {
      const t = tableMeta('users')!
      const a = qi(alias)
      const cols: Col[] = Object.entries(t.columns).map(([name, c]) => ({ name, t: columnType(c), sql: `${a}.${qi(name)}` }))
      cols.push({ name: 'raw_user_meta_data', t: 'jsonb', sql: `${a}."user_metadata"` }, { name: 'raw_app_meta_data', t: 'jsonb', sql: `${a}."app_metadata"` },
        { name: 'deleted_at', t: 'timestamptz', sql: 'NULL' }, { name: 'is_anonymous', t: 'bool', sql: '0' })
      scope.sources.push({ alias, cols, whole: this.wholeRow(cols) })
      return `main."users" AS ${a}`
    }
    if (f.schema === 'vault') {
      if (f.name !== 'decrypted_secrets' && f.name !== 'secrets') throw new NotSupported(`vault.${f.name}`)
      const a = qi(alias)
      const cols: Col[] = [['id', 'uuid'], ['name', 'text'], ['description', 'text'], ['secret', 'text'], ['decrypted_secret', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']]
        .map(([name, t]) => ({ name, t, sql: name === 'decrypted_secret' ? `${a}."secret"` : `${a}.${qi(name)}` }))
      scope.sources.push({ alias, cols })
      return `main."_vault_secrets" AS ${a}`
    }
    if (f.schema && f.schema !== 'public' && !(f.schema === 'auth' && f.name === 'sessions')) throw new NotSupported(`${f.schema}.${f.name}`)
    const meta = tableMeta(f.name) ?? viewMeta(f.name)
    if (!meta) throw new DbError('42P01', `relation "${f.name}" does not exist`)
    if (this.engine.role === 'anon' || this.engine.role === 'authenticated') requireGrant(f.name, this.engine.ctx, 'select', this.engine.role)
    const names = Object.keys(meta.columns)
    this.addSource(scope, alias, names.map((n, i) => ({ name: f.cols?.[i] ?? n, t: columnType(meta.columns[n]), s: columnDisplay(meta.columns[n]) })), f.name)
    if (f.cols) {
      const src = scope.sources[scope.sources.length - 1]
      src.cols = src.cols.map((c, i) => ({ ...c, sql: `${qi(alias)}.${qi(names[i])}` }))
    }
    const bypass = this.bypass > 0 && tableMeta(f.name)
    return `${bypass ? 'main.' : ''}${qi(f.name)} AS ${qi(alias)}`
  }

  /** A sub-query that returns at most one row (aggregate without GROUP BY, LIMIT 1, no FROM). */
  private singleRow(q: Query): boolean {
    if (q.k !== 'select' || q.groupBy.length || q.distinct) return false
    if (!q.from.length) return true
    if (q.limit?.k === 'lit' && q.limit.v === 1) return true
    return q.items.length > 0 && q.items.every((it) => hasAggregate(it.e)) && !q.having
  }

  /** LATERAL (single-row query) as one correlated scalar sub-query per column. */
  private lateralColumns(q: Query, alias: string, names: string[] | undefined, scope: QScope, cross: boolean): string {
    const s = q as Select
    // positional names inside, so unnamed or repeated items (two "?column?") stay apart
    const positional = q.k === 'select' && s.items.every((it) => it.e.k !== 'star')
    const own = positional ? s.items.map((it) => it.alias ?? columnName(it.e)) : null
    const sub = this.query(positional ? { ...s, items: s.items.map((it, i) => ({ ...it, alias: `__l${i}` })) } : q, scope)
    const cols: Col[] = sub.cols.map((c, i) => ({ name: names?.[i] ?? own?.[i] ?? c.name, t: c.t, s: c.s, sql: `(SELECT "_l".${qi(c.name)} FROM (${sub.sql}) AS "_l" LIMIT 1)` }))
    if (cross && s.from.length && !(s.items.every((it) => hasAggregate(it.e)))) scope.extraWhere.push(`EXISTS (${sub.sql})`)
    scope.sources.push({ alias, cols, whole: this.wholeRow(cols) })
    return `(SELECT 1) AS ${qi(alias)}`
  }

  /**
   * LATERAL (query returning several rows): SQLite cannot correlate a FROM sub-query,
   * but a table-valued function's argument may use the columns to its left, so the
   * rows travel as a JSON array built by a correlated scalar sub-query.
   */
  private lateralRows(q: Query, alias: string, names: string[] | undefined, scope: QScope): string {
    const s = q as Select
    const positional = q.k === 'select' && s.items.every((it) => it.e.k !== 'star')
    const own = positional ? s.items.map((it) => it.alias ?? columnName(it.e)) : null
    const sub = this.query(positional ? { ...s, items: s.items.map((it, i) => ({ ...it, alias: `__l${i}` })) } : q, scope)
    const a = qi(alias)
    const obj = `json_object(${sub.cols.map((c) => `${str(c.name)}, ${this.json({ sql: `"_lr".${qi(c.name)}`, t: c.t })}`).join(', ')})`
    const cols: Col[] = sub.cols.map((c, i) => ({ name: names?.[i] ?? own?.[i] ?? c.name, t: c.t, s: c.s, sql: jsonCell(`${a}.value`, c.name, c.t, false) }))
    scope.sources.push({ alias, cols, whole: this.wholeRow(cols) })
    return `json_each((SELECT json_group_array(${obj}) FROM (${sub.sql}) AS "_lr")) AS ${a}`
  }

  /**
   * A PL/pgSQL function in FROM whose arguments use columns to its left: called once per
   * distinct argument tuple (a lookup, see lookup()). One-row results become columns of
   * the row; SETOF results travel as a JSON array that json_each() expands.
   */
  private perRowFunction(f: Extract<FromItem, { k: 'func' }>, args: SqlArg[], scope: QScope): string {
    const call = f.call
    const alias = f.alias ?? call.name
    const a = qi(alias)
    const types = args.map((x) => x.t)
    const rt = this.engine.returnType(call.name, types, call.schema)
    if (!rt) throw new DbError('42883', `function ${call.name}(${types.join(', ')}) does not exist`)
    const set = rt.startsWith('setof ')
    const declared = this.engine.resultColumns(call.name, types)
    const grouped = call.args.some((x) => hasAggregate(x))
    const asJson = (v: unknown): unknown => (v instanceof PgRow ? v.plain() : v)
    if (!set && !declared) {
      // one value: the column is the value itself
      const value = this.lookup(scope, args, rt, (vals) => this.engine.call(call.name, vals, call.names, call.schema), grouped)
      const cols: Col[] = [{ name: f.cols?.[0] ?? alias, t: rt, sql: value.sql }]
      scope.sources.push({ alias, cols, whole: { sql: value.sql, t: rt } })
      return `(SELECT 1) AS ${a}`
    }
    const json = this.lookup(scope, args, 'jsonb', (vals) => {
      const r = this.engine.call(call.name, vals, call.names, call.schema)
      const v = set ? ((r.v as unknown[] | null) ?? []).map(asJson) : asJson(r.v)
      return { t: 'jsonb', v }
    }, grouped)
    const fields = declared ?? [{ name: alias, type: rt.replace(/^setof /, '') }]
    if (!set) {
      const cols: Col[] = fields.map((c, i) => ({ name: f.cols?.[i] ?? c.name, t: c.type, sql: jsonCell(json.sql, c.name, c.type, false) }))
      scope.sources.push({ alias, cols, whole: this.wholeRow(cols) })
      return `(SELECT 1) AS ${a}`
    }
    const cols: Col[] = declared
      ? fields.map((c, i) => ({ name: f.cols?.[i] ?? c.name, t: c.type, sql: jsonCell(`${a}.value`, c.name, c.type, false) }))
      : [{ name: f.cols?.[0] ?? alias, t: fields[0].type, sql: `${a}.value` }]
    scope.sources.push({ alias, cols, whole: declared ? this.wholeRow(cols) : { sql: cols[0].sql, t: cols[0].t } })
    return `json_each(${json.sql}) AS ${a}`
  }

  private funcSource(f: Extract<FromItem, { k: 'func' }>, scope: QScope): string {
    const call = f.call
    const name = call.name
    const alias = f.alias ?? name
    const a = qi(alias)
    const isPublic = call.schema === 'public' || (!call.schema && !SRF.has(name))
    if (!isPublic && SRF.has(name)) return this.builtinSrf(f, scope)
    // A user function: computed here when its arguments are constant, else inlined.
    const args = call.args.map((e) => this.expr(e, scope))
    if (args.every((x) => x.c)) {
      const result = this.engine.call(name, args.map((x) => x.c!), call.names, call.schema)
      const types = args.map((x) => x.t)
      const declared = this.engine.resultColumns(name, types)
      let rows: Array<Record<string, unknown>>
      let cols: OutCol[]
      const value = result.v
      if (declared) {
        cols = declared.map((c, i) => ({ name: f.cols?.[i] ?? c.name, t: c.type }))
        // a function returning one row gives a row of NULLs when it found nothing; SETOF gives none
        const list = Array.isArray(value) && !isArrayType(result.t) ? value : value === null && result.t.startsWith('setof ') ? [] : [value]
        rows = (list as unknown[]).map((r) => (r === null ? {} : rowObject(r, declared.map((c) => c.name))))
      } else {
        cols = [{ name: f.cols?.[0] ?? alias, t: result.t.replace(/^setof /, '') }]
        const list = result.t.startsWith('setof ') ? (value as unknown[]) ?? [] : [value]
        rows = list.map((v) => ({ [cols[0].name]: v }))
      }
      const src = this.bind(rows.map((r) => Object.fromEntries(cols.map((c, i) => [`c${i}`, encodeJsonCell(r[declared ? declared[i].name : c.name], c.t)]))), 'jsonb')
      const columns = cols.map((c, i) => ({ name: c.name, t: c.t, sql: jsonCell(`${a}.value`, `c${i}`, c.t) }))
      scope.sources.push({ alias, cols: columns, whole: columns.length === 1 && !declared ? { sql: columns[0].sql, t: columns[0].t } : this.wholeRow(columns) })
      return `json_each(${src}) AS ${a}`
    }
    const inline = this.engine.inline(name, args.map((x) => x.t))
    if (!inline) return this.perRowFunction(f, args, scope)
    const frag = new Map<string, SqlArg>()
    inline.params.forEach((p, i) => {
      frag.set(p, args[i] ?? { sql: 'NULL', t: inline.types[i] })
      frag.set(`$${i + 1}`, args[i] ?? { sql: 'NULL', t: inline.types[i] })
    })
    this.fragments.push(frag)
    if (inline.bypass) this.bypass++
    try {
      const body = uniqueAliases(inline.q, `__i${++this.cteCount}`)
      if (this.singleRow(body)) {
        const names = f.cols ?? this.engine.resultColumns(name, args.map((x) => x.t))?.map((c) => c.name)
        return this.lateralColumns(body, alias, names, scope, true)
      }
      const c = this.query(body, scope)
      this.addSource(scope, alias, c.cols.map((col, i) => ({ name: f.cols?.[i] ?? col.name, t: col.t, s: col.s })))
      return `(${c.sql}) AS ${a}`
    } finally {
      this.fragments.pop()
      if (inline.bypass) this.bypass--
    }
  }

  private builtinSrf(f: Extract<FromItem, { k: 'func' }>, scope: QScope): string {
    const call = f.call
    const name = call.name
    const alias = f.alias ?? name
    const a = qi(alias)
    const args = call.args.map((e) => this.expr(e, scope))
    const ord = (cols: Col[]) => (f.ordinality ? [...cols, { name: f.cols?.[cols.length] ?? 'ordinality', t: 'int', sql: `(${a}.key + 1)` }] : cols)
    const push = (cols: Col[], whole?: { sql: string; t: string }) => scope.sources.push({ alias, cols: ord(cols), whole: whole ?? (cols.length === 1 ? { sql: cols[0].sql, t: cols[0].t } : this.wholeRow(cols)) })
    const jsonValue = `(CASE ${a}.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' WHEN 'text' THEN json_quote(${a}.value) WHEN 'object' THEN ${a}.value WHEN 'array' THEN ${a}.value ELSE CAST(${a}.value AS TEXT) END)`
    const textValue = `(CASE ${a}.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL ELSE CAST(${a}.value AS TEXT) END)`
    switch (name) {
      case 'jsonb_array_elements': case 'json_array_elements':
        push([{ name: f.cols?.[0] ?? 'value', t: 'jsonb', sql: jsonValue }])
        return `json_each(${args[0].sql}) AS ${a}`
      case 'jsonb_array_elements_text': case 'json_array_elements_text':
        push([{ name: f.cols?.[0] ?? 'value', t: 'text', sql: textValue }])
        return `json_each(${args[0].sql}) AS ${a}`
      case 'jsonb_each': case 'json_each':
        push([{ name: f.cols?.[0] ?? 'key', t: 'text', sql: `${a}.key` }, { name: f.cols?.[1] ?? 'value', t: 'jsonb', sql: jsonValue }])
        return `json_each(${args[0].sql}) AS ${a}`
      case 'jsonb_each_text': case 'json_each_text':
        push([{ name: f.cols?.[0] ?? 'key', t: 'text', sql: `${a}.key` }, { name: f.cols?.[1] ?? 'value', t: 'text', sql: textValue }])
        return `json_each(${args[0].sql}) AS ${a}`
      case 'jsonb_object_keys': case 'json_object_keys':
        push([{ name: f.cols?.[0] ?? alias, t: 'text', sql: `${a}.key` }])
        return `json_each(${args[0].sql}) AS ${a}`
      case 'unnest': {
        if (args.length !== 1) throw new NotSupported('unnest with several arrays')
        const et = isArrayType(args[0].t) ? elemType(args[0].t) : 'text'
        push([{ name: f.cols?.[0] ?? alias, t: et, sql: et === 'bool' ? `${a}.value` : `${a}.value` }])
        return `json_each(${args[0].sql}) AS ${a}`
      }
      case 'generate_series': {
        if (!args.every((x) => x.c)) throw new NotSupported('generate_series with per-row bounds')
        const [lo, hi, step] = args.map((x) => x.c!)
        const values: unknown[] = []
        const t = lo.t === 'unknown' ? 'int' : lo.t
        if (t === 'int' || t === 'numeric') {
          const s = step ? Number(step.v) : 1
          if (s === 0) throw new DbError('22023', 'step size cannot equal zero')
          for (let v = Number(lo.v); s > 0 ? v <= Number(hi.v) : v >= Number(hi.v); v += s) {
            values.push(v)
            if (values.length > 100_000) throw new DbError('54000', 'generate_series is too long')
          }
        } else {
          const kind = t === 'date' ? 'timestamptz' : t
          const iv = step ? (step.v as Interval) : null
          if (!iv) throw new DbError('42883', 'function generate_series needs a step for timestamps')
          let cur = Date.parse(String(cast(lo.v, lo.t, kind === 'timestamp' ? 'timestamp' : 'timestamptz')) + (kind === 'timestamp' ? 'Z' : ''))
          const end = Date.parse(String(cast(hi.v, hi.t, kind === 'timestamp' ? 'timestamp' : 'timestamptz')) + (kind === 'timestamp' ? 'Z' : ''))
          const { addInterval } = builtinsInternals
          while (cur <= end) {
            values.push(kind === 'timestamp' ? new Date(cur).toISOString().slice(0, 23) : new Date(cur).toISOString())
            cur = addInterval(cur, iv)
            if (values.length > 100_000) throw new DbError('54000', 'generate_series is too long')
          }
        }
        const vt = t === 'date' ? 'timestamptz' : t
        push([{ name: f.cols?.[0] ?? alias, t: vt, sql: `${a}.value` }])
        return `json_each(${this.bind(values, 'jsonb')}) AS ${a}`
      }
      case 'jsonb_to_recordset': case 'json_to_recordset': case 'jsonb_to_record': case 'json_to_record': {
        if (!f.coldefs) throw new DbError('42601', 'a column definition list is required for functions returning "record"')
        push(f.coldefs.map((c) => ({ name: c.name, t: c.type.array ? `${c.type.name}[]` : c.type.name, sql: jsonCell(`${a}.value`, c.name, c.type.array ? `${c.type.name}[]` : c.type.name) })))
        return name.endsWith('recordset') ? `json_each(${args[0].sql}) AS ${a}` : `json_each(json_array(json(${args[0].sql}))) AS ${a}`
      }
      case 'jsonb_populate_recordset': case 'jsonb_populate_record': {
        const t = args[0].t
        const meta = tableMeta(t) ?? viewMeta(t)
        if (!meta) throw new NotSupported(`${name} of ${t}`)
        const cols = Object.entries(meta.columns).map(([n, c]) => ({ name: n, t: columnType(c), sql: jsonCell(`${a}.value`, n, columnType(c)), s: c.scale }))
        scope.sources.push({ alias, cols, whole: { sql: `${a}.value`, t } })
        return name.endsWith('recordset') ? `json_each(${args[1].sql}) AS ${a}` : `json_each(json_array(json(${args[1].sql}))) AS ${a}`
      }
      default:
        throw new NotSupported(`${name} in FROM`)
    }
  }

  // ---------------------------------------------------------------- expressions

  /** A condition (WHERE, ON, HAVING). */
  cond(e: Expr, scope: QScope): string {
    return this.expr(e, scope).sql
  }

  /** Whether an expression can be computed once, in JavaScript, before the query runs. */
  private independent(e: Expr, scope: QScope): boolean {
    let ok = true
    walk(e, (x) => {
      if (!ok) return false
      switch (x.k) {
        case 'ref':
          // columns win over an inlined function's parameters, as in Postgres
          if (this.findColumn(x.parts, scope) || this.wholeSource(x.parts, scope)) ok = false
          else if (x.parts.length <= 2 && this.fragment(x.parts.slice(0, 1))) ok = false
          return false
        case 'param':
          if (this.fragment([`$${x.n}`])) ok = false
          return false
        case 'star': case 'sub': case 'exists': case 'arraysub': case 'default':
          ok = false
          return false
        case 'in':
          if (x.q) ok = false
          return
        case 'quant':
          if (x.q) ok = false
          return
        case 'call': {
          if (x.over || (!x.schema && (aggregates.has(x.name) || windowFunctions.has(x.name) || SRF.has(x.name)))) {
            ok = false
            return false
          }
          const b = !x.schema || x.schema === 'pg_catalog' ? builtins[x.name] : undefined
          if (b?.volatile && scope.hasSources()) ok = false
          return
        }
      }
    })
    return ok
  }

  private fold(e: Expr, scope: QScope): SqlArg | null {
    if (e.k === 'lit' || e.k === 'default' || e.k === 'star') return null
    if (!this.independent(e, scope)) return null
    let v: Typed
    try {
      v = this.evaluator.eval(e)
    } catch (err) {
      if (err instanceof DbError && err.code === '22012') return null
      if (err instanceof NotSupported) return null
      throw err
    }
    return { sql: this.bind(v.v, v.t), t: v.t, c: v, s: v.s }
  }

  private findColumn(parts: string[], scope: QScope): Col | null {
    for (let s: QScope | null = scope; s; s = s.parent) {
      if (parts.length === 1) {
        let found: Col | null = null
        for (const src of s.sources) {
          for (const c of src.cols) {
            if (c.name !== parts[0]) continue
            if (found) throw new DbError('42702', `column reference "${parts[0]}" is ambiguous`)
            found = c
          }
        }
        if (found) return found
      } else {
        const aliasName = parts[parts.length - 2]
        const src = s.sources.find((x) => x.alias === aliasName)
        if (src) {
          const col = src.cols.find((c) => c.name === parts[parts.length - 1])
          if (!col) {
            if (src.whole?.t === 'jsonb' || (src.cols.length === 1 && src.whole && isTableType(src.whole.t) === false)) {
              // a field of a composite column: unsupported
            }
            throw new DbError('42703', `column ${aliasName}.${parts[parts.length - 1]} does not exist`)
          }
          return col
        }
      }
    }
    return null
  }

  private wholeSource(parts: string[], scope: QScope): Source | null {
    if (parts.length !== 1) return null
    for (let s: QScope | null = scope; s; s = s.parent) {
      const src = s.sources.find((x) => x.alias === parts[0])
      if (src) return src
    }
    return null
  }

  private fragment(parts: string[]): SqlArg | null {
    if (parts.length !== 1) return null
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i].get(parts[0])
      if (f) return f
      // a parameter qualified with the function name is not used in the bodies we inline
    }
    return null
  }

  /** p.col where p is a composite parameter of an inlined SQL function. */
  private fragmentField(parts: string[]): SqlArg | null {
    if (parts.length !== 2) return null
    const frag = this.fragment([parts[0]])
    if (!frag) return null
    const name = parts[1]
    if (frag.c) {
      const row = frag.c.v
      if (row === null) return { sql: 'NULL', t: 'unknown', c: { t: 'unknown', v: null } }
      if (row instanceof PgRow) {
        const t = row.types[name] ?? 'unknown'
        const v = row.values[name] ?? null
        return { sql: this.bind(v, t), t, c: { t, v } }
      }
    }
    if (frag.cols?.[name]) return { ...frag.cols[name] }
    const meta = isTableType(frag.t) ? tableMeta(frag.t) ?? viewMeta(frag.t) : undefined
    const col = meta?.columns[name]
    if (meta && !col) throw new DbError('42703', `column ${parts.join('.')} does not exist`)
    const t = col ? columnType(col) : 'unknown'
    const path = `'$."${name.replaceAll("'", "''")}"'`
    return { sql: t === 'jsonb' || isArrayType(t) ? `(${frag.sql} -> ${path})` : `json_extract(${frag.sql}, ${path})`, t }
  }

  expr(e: Expr, scope: QScope): SqlArg {
    const folded = this.fold(e, scope)
    if (folded) return folded
    return this.translate(e, scope)
  }

  private translate(e: Expr, scope: QScope): SqlArg {
    this.currentScope = scope
    switch (e.k) {
      case 'lit':
        if (e.v === null) return { sql: 'NULL', t: 'unknown', c: { t: 'unknown', v: null } }
        if (typeof e.v === 'boolean') return { sql: e.v ? '1' : '0', t: 'bool', c: { t: 'bool', v: e.v } }
        if (typeof e.v === 'number') return e.type === 'int' ? { sql: String(e.v), t: 'int', c: { t: 'int', v: e.v } } : { sql: String(e.v), t: 'numeric', c: { t: 'numeric', v: e.v, s: e.s }, s: e.s }
        return { sql: str(e.v), t: 'unknown', c: { t: 'unknown', v: e.v } }
      case 'value':
        return { sql: this.bind(e.v, e.type), t: e.type, c: { t: e.type, v: e.v } }
      case 'param': {
        const frag = this.fragment([`$${e.n}`])
        if (frag) return frag
        // a statement's own parameters (EXECUTE … USING) come first; else the function's $n
        const v = this.stmtParams.length ? this.stmtParams[e.n - 1] : this.vars.lookup([`$${e.n}`])
        if (!v) throw new DbError('42P02', `there is no parameter $${e.n}`)
        return { sql: this.bind(v.v, v.t), t: v.t, c: v, s: v.s }
      }
      case 'ref': {
        const col = this.findColumn(e.parts, scope)
        if (col) return { sql: col.sql, t: col.t, s: col.s }
        const frag = this.fragment(e.parts)
        if (frag) return frag
        const field = this.fragmentField(e.parts)
        if (field) return field
        const whole = this.wholeSource(e.parts, scope)
        if (whole?.whole) return { sql: whole.whole.sql, t: whole.whole.t, cols: Object.fromEntries(whole.cols.map((c) => [c.name, { sql: c.sql, t: c.t }])) }
        const v = this.vars.lookup(e.parts)
        if (v) return { sql: this.bind(v.v, v.t), t: v.t, c: v, s: v.s }
        throw new DbError('42703', `column "${e.parts.join('.')}" does not exist`)
      }
      case 'star':
        throw new DbError('42601', 'a star is only allowed in a select list or count(*)')
      case 'call': return this.call(e, scope)
      case 'bin': return this.binary(e.op, e.l, e.r, scope)
      case 'un': {
        const x = this.expr(e.e, scope)
        if (e.op === 'not') return { sql: `(NOT ${x.sql})`, t: 'bool' }
        if (e.op === '-') {
          if (x.t === 'interval') throw new NotSupported('negating an interval from a column')
          return { sql: `(-${x.sql})`, t: x.t, s: x.s }
        }
        return x
      }
      case 'is': {
        const x = this.expr(e.e, scope)
        const sql = e.what === 'null' || e.what === 'unknown' ? `(${x.sql} IS ${e.not ? 'NOT ' : ''}NULL)`
          : `(${x.sql} IS ${e.not ? 'NOT ' : ''}${e.what === 'true' ? '1' : '0'})`
        return { sql, t: 'bool' }
      }
      case 'isdistinct': {
        const [l, r] = this.pair(e.l, e.r, scope)
        return { sql: `(${l.sql} IS ${e.not ? '' : 'NOT '}${r.sql})`, t: 'bool' }
      }
      case 'between': {
        const x = this.expr(e.e, scope)
        const lo = this.coerceTo(this.expr(e.lo, scope), x.t)
        const hi = this.coerceTo(this.expr(e.hi, scope), x.t)
        return { sql: `(${x.sql} ${e.not ? 'NOT ' : ''}BETWEEN ${lo.sql} AND ${hi.sql})`, t: 'bool' }
      }
      case 'in': {
        const x = this.expr(e.e, scope)
        if (e.q) {
          const sub = this.query(e.q, scope)
          return { sql: `(${x.sql} ${e.not ? 'NOT ' : ''}IN (${sub.sql}))`, t: 'bool' }
        }
        if (e.e.k === 'row') {
          // (a, b) IN ((1, 2), (3, 4)): SQLite compares row values only against VALUES
          const left = e.e.items.map((it) => this.expr(it, scope))
          const rows = e.list!.map((it) => {
            const items = it.k === 'row' ? it.items : null
            if (!items || items.length !== left.length) throw new DbError('42601', 'IN list rows must have as many values as the left row')
            return `(${items.map((v, i) => this.coerceTo(this.expr(v, scope), left[i].t).sql).join(', ')})`
          })
          return { sql: `(${x.sql} ${e.not ? 'NOT ' : ''}IN (VALUES ${rows.join(', ')}))`, t: 'bool' }
        }
        const list = e.list!.map((it) => this.coerceTo(this.expr(it, scope), x.t).sql)
        return { sql: `(${x.sql} ${e.not ? 'NOT ' : ''}IN (${list.join(', ')}))`, t: 'bool' }
      }
      case 'quant': return this.quant(e, scope)
      case 'like': {
        const x = this.expr(e.e, scope)
        if (e.similar) throw new NotSupported('SIMILAR TO')
        const p = this.expr(e.p, scope)
        return { sql: this.like(textSql(x), p, e.ci, e.not), t: 'bool' }
      }
      case 'case': {
        const subject = e.subject ? this.expr(e.subject, scope) : null
        const whens = e.whens.map((w) => ({ when: subject ? this.coerceTo(this.expr(w.when, scope), subject.t) : this.expr(w.when, scope), then: this.expr(w.then, scope) }))
        const els = e.else ? this.expr(e.else, scope) : null
        const t = [...whens.map((w) => w.then.t), els?.t].find((x) => x && x !== 'unknown') ?? 'text'
        const conv = (a: SqlArg) => (a.c && a.t === 'unknown' && t !== 'unknown' && t !== 'text' ? this.coerceTo(a, t) : a)
        return {
          sql: `(CASE${subject ? ` ${subject.sql}` : ''} ${whens.map((w) => `WHEN ${w.when.sql} THEN ${conv(w.then).sql}`).join(' ')}${els ? ` ELSE ${conv(els).sql}` : ''} END)`,
          t,
          s: t === 'numeric' ? widestScale([...whens.map((w) => w.then), ...(els ? [els] : [])]) : undefined,
        }
      }
      case 'cast': return this.castSql(this.expr(e.e, scope), e.type.array ? `${e.type.name}[]` : e.type.name, e.type.scale)
      case 'exists': {
        const sub = this.query(e.q, scope)
        return { sql: `EXISTS (${sub.sql})`, t: 'bool' }
      }
      case 'sub': {
        const sub = this.query(e.q, scope)
        return { sql: `(${sub.sql})`, t: sub.cols[0]?.t ?? 'unknown', s: sub.cols[0]?.s }
      }
      case 'arraysub': {
        const sub = this.query(e.q, scope)
        const t = sub.cols[0]?.t ?? 'text'
        const col = `"_a".${qi(sub.cols[0]?.name ?? '?column?')}`
        return { sql: `(SELECT json_group_array(${this.json({ sql: col, t })}) FROM (${sub.sql}) AS "_a")`, t: isArrayType(t) ? t : `${t}[]` }
      }
      case 'array': {
        const items = e.items.map((it) => this.expr(it, scope))
        const et = items.find((x) => x.t !== 'unknown')?.t ?? 'text'
        return { sql: `json_array(${items.map((x) => this.json(this.coerceTo(x, et))).join(', ')})`, t: isArrayType(et) ? et : `${et}[]` }
      }
      case 'row': {
        const items = e.items.map((it) => this.expr(it, scope))
        return { sql: `(${items.map((x) => x.sql).join(', ')})`, t: 'record' }
      }
      case 'field': {
        // (r.o).created_at: a field of a row value, which SQLite holds as a JSON object
        const x = this.expr(e.e, scope)
        if (e.name === '*') return x
        const own = x.cols?.[e.name]
        if (own) return own
        const meta = isTableType(x.t) ? tableMeta(x.t) ?? viewMeta(x.t) : undefined
        if (meta && !meta.columns[e.name]) throw new DbError('42703', `column "${e.name}" not found in data type ${x.t}`)
        const col = meta?.columns[e.name]
        const t = col ? columnType(col) : 'text'
        return { sql: jsonCell(x.sql, e.name, t, false), t, s: col?.scale }
      }
      case 'index': {
        const x = this.expr(e.e, scope)
        if (e.slice) {
          const lo = e.idx ? this.expr(e.idx, scope) : { sql: '1', t: 'int', c: { t: 'int', v: 1 } }
          const hi = e.upper ? this.expr(e.upper, scope) : { sql: 'NULL', t: 'int', c: { t: 'int', v: null } }
          return this.lookup(scope, [x, lo, hi], x.t, (v) => this.evaluator.eval({ k: 'index', slice: true, e: { k: 'value', v: v[0].v, type: v[0].t },
            idx: { k: 'value', v: v[1].v ?? 1, type: 'int' }, upper: v[2].v === null ? undefined : { k: 'value', v: v[2].v, type: 'int' } }))
        }
        const i = this.expr(e.idx!, scope)
        const et = isArrayType(x.t) ? elemType(x.t) : 'jsonb'
        return { sql: `json_extract(${x.sql}, '$[' || ((${i.sql}) - 1) || ']')`, t: et }
      }
      case 'attz': {
        const x = this.expr(e.e, scope)
        const z = this.expr(e.zone, scope)
        if (!z.c) throw new NotSupported('AT TIME ZONE with a zone from a column')
        const mins = zoneOffset(String(z.c.v), Date.parse(this.engine.ctx.now))
        if (x.t === 'timestamp') return { sql: `strftime('%Y-%m-%dT%H:%M:%fZ', ${x.sql}, '${-mins >= 0 ? '+' : ''}${-mins} minutes')`, t: 'timestamptz' }
        const ts = x.t === 'date' ? `(${x.sql} || 'T00:00:00.000Z')` : x.sql
        return { sql: `strftime('%Y-%m-%dT%H:%M:%f', ${ts}, '${mins >= 0 ? '+' : ''}${mins} minutes')`, t: 'timestamp' }
      }
      case 'default': throw new DbError('42601', 'DEFAULT is not allowed here')
      case 'quantarg': throw new DbError('42601', 'ANY/ALL needs an operator')
    }
  }

  /** Both sides of a comparison, constants converted to the other side's type. */
  private pair(l: Expr, r: Expr, scope: QScope): [SqlArg, SqlArg] {
    let a = this.expr(l, scope)
    let b = this.expr(r, scope)
    if (a.c && !b.c) a = this.coerceTo(a, b.t)
    else if (b.c && !a.c) b = this.coerceTo(b, a.t)
    else if (a.t !== b.t) {
      // date vs timestamp columns: compare as timestamps
      if (a.t === 'date' && (b.t === 'timestamptz' || b.t === 'timestamp')) a = this.castSql(a, b.t)
      else if (b.t === 'date' && (a.t === 'timestamptz' || a.t === 'timestamp')) b = this.castSql(b, a.t)
    }
    return [a, b]
  }

  /** A constant re-bound as another type ('2026-10-12' compared with a timestamptz column). */
  private coerceTo(a: SqlArg, t: string): SqlArg {
    if (!a.c || a.c.v === null || a.t === t || t === 'unknown' || t === 'record') return a
    if ((a.t === 'int' || a.t === 'numeric') && (t === 'int' || t === 'numeric')) return a
    if (isTableType(t)) return a
    try {
      const v = cast(a.c.v, a.t, t)
      return { sql: this.bind(v, t), t, c: { t, v } }
    } catch {
      return a
    }
  }

  private like(x: string, p: SqlArg, ci: boolean, not: boolean): string {
    const n = not ? 'NOT ' : ''
    if (p.c && typeof p.c.v === 'string') {
      const pat = p.c.v
      const plain = (s: string) => !/[%_\\]/.test(s)
      const subject = ci ? `lower(${x})` : x
      const lit = (s: string) => this.bind(ci ? s.toLowerCase() : s, 'text')
      if (plain(pat)) return `(${n}coalesce(${subject} = ${lit(pat)}, NULL))`
      if (pat.startsWith('%') && pat.endsWith('%') && plain(pat.slice(1, -1)) && pat.length > 1) return `(${n}(instr(${subject}, ${lit(pat.slice(1, -1))}) > 0))`
      if (pat.endsWith('%') && plain(pat.slice(0, -1))) {
        const s = pat.slice(0, -1)
        return `(${n}(substr(${subject}, 1, ${[...s].length}) = ${lit(s)}))`
      }
      if (pat.startsWith('%') && plain(pat.slice(1))) {
        const s = pat.slice(1)
        return `(${n}(substr(${subject}, -${[...s].length}) = ${lit(s)}))`
      }
      // LIKE in SQLite ignores ASCII case; GLOB is exact. Patterns stay short (50 bytes in a Durable Object).
      if (ci) return `(${x} ${n}LIKE ${this.bind(pat, 'text')} ESCAPE '\\')`
      const glob = pat.replace(/\\(.)|([*?[\]])|%|_/g, (m, esc: string, special: string) => (esc ? (/[*?[\]]/.test(esc) ? `[${esc}]` : esc) : special ? `[${special}]` : m === '%' ? '*' : '?'))
      return `(${x} ${n}GLOB ${this.bind(glob, 'text')})`
    }
    return `(${x} ${n}LIKE ${p.sql} ESCAPE '\\')`
  }

  private quant(e: Extract<Expr, { k: 'quant' }>, scope: QScope): SqlArg {
    const l = this.expr(e.l, scope)
    const op = e.op
    let source: string
    let elemT = l.t
    if (e.q) {
      const sub = this.query(e.q, scope)
      source = `SELECT "_s".${qi(sub.cols[0]?.name ?? '?column?')} AS value FROM (${sub.sql}) AS "_s"`
      elemT = sub.cols[0]?.t ?? l.t
    } else {
      const r = this.expr(e.r!, scope)
      if (r.c && Array.isArray(r.c.v)) {
        const et = isArrayType(r.t) ? elemType(r.t) : l.t
        const converted = (r.c.v as unknown[]).map((v) => (v === null ? null : this.safeCast(v, et, l.t)))
        source = `SELECT value FROM json_each(${this.bind(converted, 'jsonb')})`
      } else source = `SELECT value FROM json_each(${r.sql})`
      elemT = isArrayType(r.t) ? elemType(r.t) : l.t
    }
    void elemT
    if (op === '=' && e.quant === 'any') return { sql: `(${l.sql} IN (${source}))`, t: 'bool' }
    if ((op === '<>') && e.quant === 'all') return { sql: `(${l.sql} NOT IN (${source}))`, t: 'bool' }
    const v = '"_q"."value"'
    const wrapped = `SELECT * FROM (${source}) AS "_q"`
    let test: string
    if (op === 'like' || op === 'ilike' || op === 'not like' || op === 'not ilike') {
      test = `${l.sql} ${op.startsWith('not') ? 'NOT ' : ''}LIKE ${v} ESCAPE '\\'`
    } else test = `${l.sql} ${op} ${v}`
    if (e.quant === 'any') return { sql: `EXISTS (${wrapped} WHERE ${test})`, t: 'bool' }
    return { sql: `NOT EXISTS (${wrapped} WHERE NOT (${test}))`, t: 'bool' }
  }

  private safeCast(v: unknown, from: string, to: string): unknown {
    try {
      return cast(v, from, to)
    } catch {
      return v
    }
  }

  /** Comparisons, arithmetic, concatenation and JSON operators. */
  private binary(op: string, le: Expr, re: Expr, scope: QScope): SqlArg {
    if (op === 'and' || op === 'or') {
      const l = this.expr(le, scope)
      const r = this.expr(re, scope)
      return { sql: `(${l.sql} ${op.toUpperCase()} ${r.sql})`, t: 'bool' }
    }
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      const [l, r] = this.pair(le, re, scope)
      if (l.t === 'interval' || r.t === 'interval') return { sql: `(${this.intervalEpoch(l)} ${op} ${this.intervalEpoch(r)})`, t: 'bool' }
      return { sql: `(${l.sql} ${op} ${r.sql})`, t: 'bool' }
    }
    let l = this.expr(le, scope)
    let r = this.expr(re, scope)
    switch (op) {
      case '||': {
        if (l.t === 'jsonb' || r.t === 'jsonb') {
          if (l.t !== 'jsonb') l = this.coerceTo(l, 'jsonb')
          if (r.t !== 'jsonb') r = this.coerceTo(r, 'jsonb')
          return { sql: jsonConcatSql(l.sql, r.sql), t: 'jsonb' }
        }
        if (isArrayType(l.t) || isArrayType(r.t)) {
          const at = isArrayType(l.t) ? l.t : r.t
          const left = isArrayType(l.t) ? l.sql : `json_array(${this.json(l)})`
          const right = isArrayType(r.t) ? r.sql : `json_array(${this.json(r)})`
          return { sql: `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(${left}) UNION ALL SELECT value FROM json_each(${right})))`, t: at }
        }
        return { sql: `(${textSql(l)} || ${textSql(r)})`, t: 'text' }
      }
      case '->': {
        if (l.t !== 'jsonb') l = this.coerceTo(l, 'jsonb')
        return { sql: `(${l.sql} -> ${r.sql})`, t: 'jsonb' }
      }
      case '->>': {
        if (l.t !== 'jsonb') l = this.coerceTo(l, 'jsonb')
        return { sql: jsonTextSql(l.sql, r.sql), t: 'text' }
      }
      case '#>': case '#>>': {
        if (!r.c) return this.lookup(scope, [l, r], op === '#>' ? 'jsonb' : 'text', (v) => this.evaluator.eval({ k: 'bin', op, l: { k: 'value', v: v[0].v, type: v[0].t }, r: { k: 'value', v: v[1].v, type: v[1].t } }))
        const inner = String(r.c.v).trim().replace(/^\{|\}$/g, '')
        const keys = Array.isArray(r.c.v) ? (r.c.v as unknown[]).map(String) : inner.trim() === '' ? [] : inner.split(',').map((k) => k.trim().replace(/^"|"$/g, ''))
        const path = `$${keys.map((k) => (/^\d+$/.test(k) ? `[${k}]` : `."${k.replaceAll('"', '\\"')}"`)).join('')}`
        return op === '#>' ? { sql: `(${l.sql} -> ${str(path)})`, t: 'jsonb' } : { sql: jsonTextSql(l.sql, str(path)), t: 'text' }
      }
      case '?': {
        if (isArrayType(l.t)) throw new NotSupported('? on an array')
        return { sql: `(json_type(${l.sql}, '$."' || ${r.sql} || '"') IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(${l.sql}) WHERE json_type(${l.sql}) = 'array' AND type = 'text' AND value = ${r.sql}))`, t: 'bool' }
      }
      case '?|': case '?&': {
        const test = `(json_type(${l.sql}, '$."' || "_k"."value" || '"') IS NOT NULL)`
        const keys = `SELECT * FROM json_each(${r.sql}) AS "_k"`
        return { sql: op === '?|' ? `EXISTS (${keys} WHERE ${test})` : `NOT EXISTS (${keys} WHERE NOT ${test})`, t: 'bool' }
      }
      case '@>': case '<@': {
        const [big, small] = op === '@>' ? [l, r] : [r, l]
        return { sql: this.contains(big, small), t: 'bool' }
      }
      case '&&':
        return { sql: `EXISTS (SELECT 1 FROM json_each(${l.sql}) AS "_x" WHERE "_x"."value" IN (SELECT value FROM json_each(${r.sql})))`, t: 'bool' }
      case '~': case '~*': case '!~': case '!~*': {
        const tl = l.t === 'unknown' ? { ...l, t: 'text' } : l
        return this.lookup(scope, [tl, r], 'bool', (vals) => this.evaluator.eval({ k: 'bin', op, l: { k: 'value', v: vals[0].v, type: vals[0].t }, r: { k: 'value', v: vals[1].v, type: vals[1].t } }), hasAggregate(le) || hasAggregate(re))
      }
      case 'like':
        return { sql: this.like(textSql(l), r, false, false), t: 'bool' }
      case '-':
        if (l.t === 'jsonb') {
          if (r.t === 'int' || (r.c && typeof r.c.v === 'number')) return { sql: `json_remove(${l.sql}, '$[' || (${r.sql}) || ']')`, t: 'jsonb' }
          if (isArrayType(r.t)) return { sql: `(SELECT coalesce(json_group_object(key, value), '{}') FROM json_each(${l.sql}) WHERE key NOT IN (SELECT value FROM json_each(${r.sql})))`, t: 'jsonb' }
          return { sql: `json_remove(${l.sql}, '$."' || ${r.sql} || '"')`, t: 'jsonb' }
        }
        return this.arith(op, l, r)
      default:
        return this.arith(op, l, r)
    }
  }

  /** big @> small, for JSON and arrays. */
  private contains(big: SqlArg, small: SqlArg): string {
    if (small.c) {
      const v = small.c.v
      if (Array.isArray(v)) {
        if (!v.length) return '1'
        return `(${v.map((x) => {
          // An object or array element matches an element that contains it, as in Postgres
          // ('[{"kind":"fee","amount":5}]' @> '[{"kind":"fee"}]').
          if (x !== null && typeof x === 'object') {
            const e = `"_ce${this.containsN++}"`
            const kind = Array.isArray(x) ? 'array' : 'object'
            return `EXISTS (SELECT 1 FROM json_each(${big.sql}) AS ${e} WHERE ${e}."type" = '${kind}' AND ${this.contains({ sql: `${e}."value"`, t: 'jsonb' }, { sql: '', t: 'jsonb', c: { t: 'jsonb', v: x } })})`
          }
          return `EXISTS (SELECT 1 FROM json_each(${big.sql}) WHERE value = ${this.bind(x, guessScalar(x))})`
        }).join(' AND ')})`
      }
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>)
        if (!entries.length) return `(json_type(${big.sql}) = 'object')`
        return `(${entries.map(([k, x]) => {
          const path = this.bind(`$."${k.replaceAll('"', '\\"')}"`, 'text')
          if (x !== null && typeof x === 'object') {
            // nested: containment again ({"sessions":["A","B"]} @> {"sessions":["A"]})
            const inner = `(${big.sql} -> ${path})`
            const kind = Array.isArray(x) ? 'array' : 'object'
            return `(json_type(${inner}) = '${kind}' AND ${this.contains({ sql: inner, t: 'jsonb' }, { sql: '', t: 'jsonb', c: { t: 'jsonb', v: x } })})`
          }
          if (typeof x === 'boolean') return `json_type(${big.sql}, ${path}) = '${x}'`
          if (x === null) return `json_type(${big.sql}, ${path}) = 'null'`
          return `json_extract(${big.sql}, ${path}) = ${this.bind(x, guessScalar(x))}`
        }).join(' AND ')})`
      }
    }
    return `NOT EXISTS (SELECT 1 FROM json_each(${small.sql}) AS "_s" WHERE "_s"."value" NOT IN (SELECT value FROM json_each(${big.sql})))`
  }

  private arith(op: string, l: SqlArg, r: SqlArg): SqlArg {
    const dateLike = (t: string) => t === 'date' || t === 'timestamptz' || t === 'timestamp'
    // timestamp ± interval
    if ((op === '+' || op === '-') && dateLike(l.t) && (r.t === 'interval' || (r.c && r.c.v instanceof Interval))) {
      return { sql: this.addInterval(l, r, op === '-'), t: l.t === 'date' ? 'timestamp' : l.t }
    }
    if (op === '+' && l.t === 'interval' && dateLike(r.t)) return { sql: this.addInterval(r, l, false), t: r.t === 'date' ? 'timestamp' : r.t }
    if (dateLike(l.t) && dateLike(r.t) && op === '-') {
      if (l.t === 'date' && r.t === 'date') return { sql: `CAST(julianday(${l.sql}) - julianday(${r.sql}) AS INTEGER)`, t: 'int' }
      const diff = `(julianday(${l.sql}) - julianday(${r.sql}))`
      return { sql: `json_array(0, CAST(${diff} AS INTEGER), (${diff} - CAST(${diff} AS INTEGER)) * 86400)`, t: 'interval' }
    }
    // date + time of day: that moment (a timestamp without time zone)
    if (op === '+' && ((l.t === 'date' && r.t === 'time') || (l.t === 'time' && r.t === 'date'))) {
      const [d, tm] = l.t === 'date' ? [l, r] : [r, l]
      return { sql: `strftime('%Y-%m-%dT%H:%M:%f', ${d.sql} || ' ' || ${tm.sql})`, t: 'timestamp' }
    }
    if (l.t === 'date' && (r.t === 'int' || r.c?.t === 'int') && (op === '+' || op === '-')) {
      return { sql: `date(${l.sql}, (${op === '-' ? '-' : ''}(${r.sql})) || ' days')`, t: 'date' }
    }
    const iv = this.intervalArith(op, l, r)
    if (iv) return iv
    if (l.t === 'interval' || r.t === 'interval') throw new NotSupported('interval arithmetic on columns')
    const t = l.t === 'int' && r.t === 'int' ? 'int' : l.t === 'int' && r.t === 'unknown' ? 'int' : 'numeric'
    const s = t === 'numeric' ? arithScale(op, scaleOf(l), scaleOf(r)) : undefined
    if (op === '/') {
      if (t === 'int') return { sql: `(${l.sql} / ${r.sql})`, t }
      return { sql: `(CAST(${l.sql} AS REAL) / ${r.sql})`, t }
    }
    if (op === '^') return { sql: `power(${l.sql}, ${r.sql})`, t: 'numeric' }
    if (op === '%') return { sql: `(${l.sql} % ${r.sql})`, t, s }
    if (!['+', '-', '*'].includes(op)) throw new NotSupported(`operator ${op}`)
    return { sql: `(${l.sql} ${op} ${r.sql})`, t, s }
  }

  /** An interval's parts in SQL: months, days, seconds (constants inline, else read from the [m, d, s] triple). */
  private ivParts(iv: SqlArg): { m: string; d: string; s: string } {
    if (iv.c && iv.c.v instanceof Interval) {
      const v = iv.c.v
      return { m: String(v.months), d: String(v.days), s: String(v.ms / 1000) }
    }
    if (iv.c && typeof iv.c.v === 'string') {
      const v = cast(iv.c.v, 'text', 'interval') as Interval
      return { m: String(v.months), d: String(v.days), s: String(v.ms / 1000) }
    }
    return { m: `(${iv.sql} ->> 0)`, d: `(${iv.sql} ->> 1)`, s: `(${iv.sql} ->> 2)` }
  }

  private addInterval(ts: SqlArg, iv: SqlArg, minus: boolean): string {
    const fmt = ts.t === 'timestamptz' ? '%Y-%m-%dT%H:%M:%fZ' : '%Y-%m-%dT%H:%M:%f'
    const base = ts.t === 'date' ? `(${ts.sql} || 'T00:00:00.000')` : ts.sql
    const p = this.ivParts(iv)
    const sign = minus ? '-' : ''
    if (iv.c) {
      const mods: string[] = []
      const lit = (n: string, unit: string) => {
        const v = Number(n) * (minus ? -1 : 1)
        if (v) mods.push(`'${v >= 0 ? '+' : ''}${v} ${unit}'`)
      }
      lit(p.m, 'months')
      lit(p.d, 'days')
      lit(p.s, 'seconds')
      return `strftime('${fmt}', ${base}${mods.length ? `, ${mods.join(', ')}` : ''})`
    }
    return `strftime('${fmt}', ${base}, (${sign}${p.m}) || ' months', (${sign}${p.d}) || ' days', (${sign}${p.s}) || ' seconds')`
  }

  /** Interval arithmetic in SQL on [months, days, seconds]. */
  private intervalArith(op: string, l: SqlArg, r: SqlArg): SqlArg | null {
    const isIv = (a: SqlArg) => a.t === 'interval' || (a.c?.v instanceof Interval)
    if (isIv(l) && isIv(r) && (op === '+' || op === '-')) {
      const a = this.ivParts(l)
      const b = this.ivParts(r)
      return { sql: `json_array(${a.m} ${op} ${b.m}, ${a.d} ${op} ${b.d}, ${a.s} ${op} ${b.s})`, t: 'interval' }
    }
    if ((isIv(l) && !isIv(r) && (op === '*' || op === '/')) || (isIv(r) && !isIv(l) && op === '*')) {
      const iv = isIv(l) ? this.ivParts(l) : this.ivParts(r)
      const n = isIv(l) ? r.sql : l.sql
      const f = op === '/' ? `/ CAST(${n} AS REAL)` : `* (${n})`
      return { sql: `json_array(CAST(${iv.m} ${f} AS INTEGER), CAST(${iv.d} ${f} AS INTEGER), ${iv.s} ${f})`, t: 'interval' }
    }
    return null
  }

  /** extract(epoch from interval): seconds, with 30-day months as Postgres counts them. */
  intervalEpoch(iv: SqlArg): string {
    const p = this.ivParts(iv)
    return `((${p.m}) * 2592000 + (${p.d}) * 86400 + (${p.s}))`
  }

  /** A cast SQLite cannot do itself (text → interval), per distinct value in JavaScript. */
  private lookupCast(a: SqlArg, to: string): SqlArg {
    if (!this.currentScope) throw new NotSupported(`a cast to ${to} on a column`)
    return this.lookup(this.currentScope, [a], to, (vals) => ({ t: to, v: vals[0].v === null ? null : cast(vals[0].v, vals[0].t === 'unknown' ? 'text' : vals[0].t, to) }))
  }

  private currentScope: QScope | null = null

  castSql(a: SqlArg, to: string, scale?: number): SqlArg {
    if (a.c) {
      const v = castTyped({ ...a.c, t: a.t, s: a.c.s ?? a.s }, to, scale)
      return { sql: this.bind(v.v, to), t: to, c: v, s: v.s }
    }
    const from = a.t
    // ::bigint marks the value for display; ::int drops the mark
    if (to === 'int' && from === 'int') return { sql: a.sql, t: 'int', s: scale === BIGINT ? BIGINT : undefined }
    if (to === 'numeric') {
      // numeric(p, s) rounds; plain numeric keeps the value's scale (integers have none)
      const s = castScale({ t: from, v: null, s: a.s }, scale)
      const real = from === 'numeric' ? a.sql : `CAST(${a.sql} AS REAL)`
      return { sql: scale !== undefined && scale >= 0 ? `round(${real}, ${scale})` : real, t: 'numeric', s }
    }
    if (from === to) return a
    const x = a.sql
    switch (to) {
      case 'text':
        if (from === 'bool') return { sql: textSql(a), t: 'text' }
        if (from === 'numeric') return { sql: numericTextSql(x, a.s), t: 'text' }
        if (from === 'int') return { sql: `CAST(${x} AS TEXT)`, t: 'text' }
        return { sql: x, t: 'text' }
      case 'int':
        if (from === 'numeric') return { sql: `CAST(round(${x}) AS INTEGER)`, t: 'int' }
        if (from === 'bool') return { sql: x, t: 'int' }
        return { sql: `CAST(${x} AS INTEGER)`, t: 'int' }
      case 'bool':
        if (from === 'int' || from === 'numeric') return { sql: `((${x}) <> 0)`, t: 'bool' }
        return { sql: `(CASE WHEN ${x} IS NULL THEN NULL WHEN lower(CAST(${x} AS TEXT)) IN ('t', 'true', 'y', 'yes', 'on', '1') THEN 1 WHEN lower(CAST(${x} AS TEXT)) IN ('f', 'false', 'n', 'no', 'off', '0') THEN 0 END)`, t: 'bool' }
      case 'jsonb':
        if (from === 'text' || from === 'unknown') return { sql: `json(${x})`, t: 'jsonb' }
        return { sql: this.jsonValue(a), t: 'jsonb' }
      case 'timestamptz':
        if (from === 'date') return { sql: `(${x} || 'T00:00:00.000Z')`, t: to }
        if (from === 'timestamp') return { sql: `(${x} || 'Z')`, t: to }
        if (from === 'text' || from === 'unknown') return { sql: `strftime('%Y-%m-%dT%H:%M:%fZ', ${x})`, t: to }
        return { sql: x, t: to }
      case 'timestamp':
        if (from === 'date') return { sql: `(${x} || 'T00:00:00.000')`, t: to }
        return { sql: `substr(${x}, 1, 23)`, t: to }
      case 'date':
        if (from === 'timestamptz' || from === 'timestamp') return { sql: `substr(${x}, 1, 10)`, t: to }
        return { sql: `date(${x})`, t: to }
      case 'time': return { sql: `substr(${x}, 12, 8)`, t: to }
      case 'interval':
        return this.lookupCast(a, 'interval')
      case 'uuid': return { sql: `lower(${x})`, t: to }
      default:
        if (isArrayType(to)) {
          if (isArrayType(from) || from === 'jsonb') return { sql: x, t: to }
          throw new NotSupported(`a cast to ${to} on a column`)
        }
        if (isEnum(to)) return { sql: x, t: to }
        return { sql: x, t: to }
    }
  }

  // ---------------------------------------------------------------- calls

  private call(e: CallExpr, scope: QScope): SqlArg {
    const name = e.name
    if (e.schema === 'auth' || e.schema === 'vault' || e.schema === 'extensions') {
      // computed per request, never per row
      const v = this.evaluator.eval(e)
      return { sql: this.bind(v.v, v.t), t: v.t, c: v }
    }
    const builtin = !e.schema || e.schema === 'pg_catalog'
    if (e.over) return this.windowCall(e, scope)
    if (builtin && aggregates.has(name)) return this.aggregate(e, scope)
    if (builtin && name === 'make_interval') {
      const order = ['years', 'months', 'weeks', 'days', 'hours', 'mins', 'secs']
      const parts: Record<string, string> = {}
      e.args.forEach((x, i) => {
        parts[e.names?.[i] ?? order[i]] = `coalesce(${this.expr(x, scope).sql}, 0)`
      })
      const g = (k: string) => parts[k] ?? '0'
      return { sql: `json_array(${g('years')} * 12 + ${g('months')}, ${g('weeks')} * 7 + ${g('days')}, ${g('hours')} * 3600 + ${g('mins')} * 60 + ${g('secs')})`, t: 'interval' }
    }
    if (builtin && builtins[name]) {
      const b = builtins[name]
      const args = e.args.map((x) => this.expr(x, scope))
      const scaleFor = (rt: string, xs: SqlArg[]) => (rt === 'numeric' ? b.scale?.(xs.map(scaleOf), xs.map((a) => (a.c ? { v: a.c.v } : undefined))) : undefined)
      const perRow = (rt: string): SqlArg => ({
        ...this.lookup(scope, args, rt, (vals) => this.evaluator.eval({ ...e, args: vals.map((x) => ({ k: 'value', v: x.v, type: x.t, s: x.s })) }), e.args.some((x) => hasAggregate(x))),
        s: scaleFor(rt, args),
      })
      if (!b.sql) return perRow(b.ret(args.map((x) => x.t), e.args))
      try {
        const rt = b.ret(args.map((x) => x.t), e.args)
        // literals take the type of the other arguments (coalesce(tags, '{}'))
        const conv = ['coalesce', 'nullif', 'greatest', 'least'].includes(name) ? args.map((a) => (a.c && a.t === 'unknown' ? this.coerceTo(a, rt) : a)) : args
        return { sql: b.sql(conv, this), t: rt, s: scaleFor(rt, conv) }
      } catch (err) {
        if (err instanceof DbError) throw err
        // SQLite has no form of it: per distinct argument in JavaScript
        return perRow(b.ret(args.map((x) => x.t), e.args))
      }
    }
    if (builtin && SRF.has(name)) throw new NotSupported(`set-returning ${name}() in a select list`)
    // a user function with per-row arguments: inline its SQL body
    const args = e.args.map((x) => this.expr(x, scope))
    const inline = this.engine.inline(name, args.map((x) => x.t))
    if (!inline) {
      const rt = this.engine.returnType(name, args.map((x) => x.t), e.schema)
      if (!rt) throw new DbError('42883', `function ${name}(${args.map((x) => x.t).join(', ')}) does not exist`)
      if (rt.startsWith('setof ')) throw new NotSupported(`set-returning function ${name} with per-row arguments`)
      return this.lookup(scope, args, rt, (vals) => this.engine.call(name, vals, e.names, e.schema), e.args.some((x) => hasAggregate(x)))
    }
    const frag = new Map<string, SqlArg>()
    inline.params.forEach((p, i) => {
      const a = args[i] ?? { sql: 'NULL', t: inline.types[i] }
      frag.set(p, a)
      frag.set(`$${i + 1}`, a)
    })
    this.fragments.push(frag)
    if (inline.bypass) this.bypass++
    try {
      const c = this.select(uniqueAliases(inline.q, `__i${++this.cteCount}`), scope)
      const rt = this.engine.returnType(name, args.map((x) => x.t), e.schema) ?? c.cols[0]?.t ?? 'unknown'
      return { sql: `(${c.sql})`, t: rt.startsWith('setof ') ? rt.slice(6) : rt, s: rt === 'numeric' ? c.cols[0]?.s : undefined }
    } finally {
      this.fragments.pop()
      if (inline.bypass) this.bypass--
    }
  }

  /**
   * A per-row value SQLite cannot compute (a PL/pgSQL function, a regular expression):
   * computed in JavaScript once per distinct argument tuple the query produces, then
   * read per row from a JSON object keyed by the arguments (hex of their JSON array,
   * computed by SQLite on both sides, so the keys always agree).
   */
  private lookup(scope: QScope, args: SqlArg[], t: string, compute: (vals: Typed[]) => Typed, grouped = false): SqlArg {
    const level = this.sourceLevel(scope)
    if (!level) throw new NotSupported('a per-row function outside a query with FROM')
    if (grouped && level.groupSql === null) throw new NotSupported('a per-row function of aggregates grouped by output names')
    const key = `('k' || hex(json_array(${args.map((a) => a.sql).join(', ')})))`
    const cols = [`${key} AS "__k"`, ...args.map((a, i) => `${a.sql} AS "a${i}"`)]
    const ctes: string[] = []
    let recursive = false
    for (let s: QScope | null = scope; s; s = s.parent) {
      ctes.unshift(...s.cteSql)
      recursive ||= s.recursive
    }
    const withSql = ctes.length ? `WITH ${recursive ? 'RECURSIVE ' : ''}${ctes.join(', ')} ` : ''
    // The query's own FROM (and WHERE / GROUP BY when known); when the arguments use an
    // outer query's columns too, those FROMs as well.
    let rows: Row[] | null = null
    const froms: string[] = []
    for (let s: QScope | null = level; s && !rows; s = s.parent) {
      if (!s.fromSql.length) continue
      froms.unshift(s.fromSql.join(', '))
      const own = s === level
      const where = own && level.whereSql ? ` WHERE ${level.whereSql}` : ''
      const group = own && grouped && level.groupSql ? ` GROUP BY ${level.groupSql}` : ''
      try {
        rows = runSql(this.engine, `${withSql}SELECT DISTINCT ${cols.join(', ')} FROM ${froms.join(', ')}${where}${group}`, [...this.params])
      } catch (e) {
        if (!(e instanceof DbError && e.code === '42703')) throw e
      }
    }
    if (!rows) throw new NotSupported('a per-row function on columns SQLite cannot reach')
    const map: Record<string, unknown> = {}
    for (const r of rows) {
      const vals = args.map((a, i) => ({ t: a.t, v: decodeSql(r[`a${i}`] ?? null, a.t), s: a.s }))
      const result = compute(vals)
      map[String(r.__k)] = encodeSql(result.v, result.t)
    }
    return { sql: `(${this.bind(map, 'jsonb')} ->> ${key})`, t }
  }

  /** The innermost query level that has FROM items. */
  private sourceLevel(scope: QScope): QScope | null {
    for (let s: QScope | null = scope; s; s = s.parent) if (s.fromSql.length) return s
    return null
  }

  private aggregate(e: CallExpr, scope: QScope): SqlArg {
    const name = e.name
    const args = e.star ? [] : e.args.map((x) => this.expr(x, scope))
    const distinct = e.distinct ? 'DISTINCT ' : ''
    const order = e.order?.length ? ` ORDER BY ${e.order.map((o) => `${this.expr(o.e, scope).sql}${o.desc ? ' DESC NULLS FIRST' : ' NULLS LAST'}`).join(', ')}` : ''
    const filter = e.filter ? ` FILTER (WHERE ${this.cond(e.filter, scope)})` : ''
    const t = aggregateType(name, args.map((x) => x.t))
    let sql: string
    switch (name) {
      case 'count': sql = e.star ? `count(*)${filter}` : `count(${distinct}${args[0].sql})${filter}`; break
      case 'sum': sql = `sum(${distinct}${args[0].sql})${filter}`; break
      case 'avg': sql = `avg(${distinct}${args[0].sql})${filter}`; break
      case 'min': case 'max': sql = `${name}(${args[0].sql})${filter}`; break
      case 'bool_or': sql = `max(${args[0].sql})${filter}`; break
      case 'bool_and': case 'every': sql = `min(${args[0].sql})${filter}`; break
      case 'string_agg':
        // SQLite's DISTINCT aggregates take one argument: collect distinct values, then join them
        sql = e.distinct
          ? `(SELECT group_concat(value, ${args[1].sql}) FROM json_each(json_group_array(DISTINCT ${textSql(args[0])}${order})${filter}))`
          : `group_concat(${textSql(args[0])}, ${args[1].sql}${order})${filter}`
        break
      case 'array_agg': sql = `nullif(json_group_array(${distinct}${this.json(args[0])}${order})${filter}, '[]')`; break
      case 'jsonb_agg': case 'json_agg': sql = `nullif(json_group_array(${distinct}${this.json({ ...args[0], t: args[0].t === 'unknown' ? 'text' : args[0].t })}${order})${filter}, '[]')`; break
      case 'jsonb_object_agg': case 'json_object_agg': sql = `nullif(json_group_object(${textSql(args[0])}, ${this.json(args[1])}${order})${filter}, '{}')`; break
      case 'mode': {
        throw new NotSupported('mode() WITHIN GROUP')
      }
      default: throw new NotSupported(`aggregate ${name}`)
    }
    // sum, min and max keep the values' display scale (sum of numeric(12,2) prints 990.00); count is a bigint
    const s = name === 'count' || (name === 'sum' && t === 'int') ? BIGINT : t === 'numeric' && ['sum', 'min', 'max'].includes(name) ? args[0]?.s : undefined
    return { sql, t, s }
  }

  private windowCall(e: CallExpr, scope: QScope): SqlArg {
    const name = e.name
    const args = e.args.map((x) => this.expr(x, scope))
    const w = e.over!
    if (w.name) throw new NotSupported('a named window')
    const over = `OVER (${w.partition.length ? `PARTITION BY ${w.partition.map((p) => this.expr(p, scope).sql).join(', ')} ` : ''}${
      w.order.length ? `ORDER BY ${w.order.map((o) => `${this.expr(o.e, scope).sql}${o.desc ? ' DESC NULLS FIRST' : ' NULLS LAST'}`).join(', ')} ` : ''}${w.frame ?? ''})`
    if (aggregates.has(name)) {
      const inner = this.aggregate({ ...e, over: undefined }, scope)
      // json aggregates are not window functions in SQLite; the plain ones are
      if (!['count', 'sum', 'avg', 'min', 'max', 'bool_or', 'bool_and', 'every'].includes(name)) throw new NotSupported(`${name} OVER`)
      return { sql: `${inner.sql} ${over}`, t: inner.t }
    }
    if (!windowFunctions.has(name)) throw new NotSupported(`window function ${name}`)
    return { sql: `${name}(${args.map((x) => x.sql).join(', ')}) ${over}`, t: windowType(name, args.map((x) => x.t)) }
  }

  // ---------------------------------------------------------------- JSON helpers (SqlHelp)

  json(a: SqlArg): string {
    if (a.t === 'bool') return `json(CASE WHEN ${a.sql} THEN 'true' WHEN NOT ${a.sql} THEN 'false' END)`
    if (a.t === 'jsonb' || isArrayType(a.t) || a.t === 'record' || isTableType(a.t)) {
      return a.c ? `json(${a.sql})` : `json(${a.sql})`
    }
    if (a.t === 'interval') return a.sql
    return a.sql
  }

  jsonValue(a: SqlArg): string {
    if (a.t === 'jsonb' || isArrayType(a.t) || a.t === 'record' || isTableType(a.t)) return a.sql
    if (a.t === 'bool') return `(CASE WHEN ${a.sql} THEN 'true' WHEN NOT ${a.sql} THEN 'false' END)`
    if (a.t === 'int' || a.t === 'numeric') return `CAST(${a.sql} AS TEXT)`
    return `json_quote(${a.sql})`
  }
}

// ---------------------------------------------------------------- helpers

/** Bound parameters per statement before constants are written out (the Durable Object's SQLite allows ?1…?100). */
const MAX_BOUND_PARAMS = 90

function sqlLiteral(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? '9e999' : '-9e999'
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`
  const bytes = v instanceof Uint8Array ? v : new Uint8Array(v)
  return `X'${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}'`
}

/** jsonb || jsonb in SQLite: objects merge (right wins, one level), anything else concatenates as arrays. */
/**
 * j ->> k as Postgres returns it: strings unquoted, everything else as its JSON text
 * (false, 1.50, {"a":1}); SQLite's ->> would give booleans as 0/1 and numbers as numbers.
 */
function jsonTextSql(j: string, k: string): string {
  const v = `(${j} -> ${k})`
  return `(CASE json_type(${v}) WHEN 'text' THEN (${j} ->> ${k}) WHEN 'null' THEN NULL ELSE ${v} END)`
}

function jsonConcatSql(l: string, r: string): string {
  // each element as JSON text, parsed again where it is aggregated (SQLite forgets a value is JSON once it leaves a sub-query)
  const v = (alias: string) => `(CASE ${alias}.type WHEN 'text' THEN json_quote(${alias}.value) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE CAST(${alias}.value AS TEXT) END)`
  const merge = `(SELECT json_group_object(k, json(v)) FROM (SELECT "_l".key AS k, ${v('"_l"')} AS v, 0 AS s, "_l".id AS o FROM json_each(${l}) AS "_l" WHERE "_l".key NOT IN (SELECT key FROM json_each(${r}))
    UNION ALL SELECT "_r".key, ${v('"_r"')}, 1, "_r".id FROM json_each(${r}) AS "_r" ORDER BY s, o))`
  const arr = (x: string) => `(CASE json_type(${x}) WHEN 'array' THEN ${x} ELSE json_array(json(${x})) END)`
  const cat = `(SELECT json_group_array(json(v)) FROM (SELECT ${v('"_l"')} AS v, 0 AS s, "_l".id AS o FROM json_each(${arr(l)}) AS "_l" UNION ALL SELECT ${v('"_r"')}, 1, "_r".id FROM json_each(${arr(r)}) AS "_r" ORDER BY s, o))`
  return `(CASE WHEN ${l} IS NULL OR ${r} IS NULL THEN NULL WHEN json_type(${l}) = 'object' AND json_type(${r}) = 'object' THEN ${merge} ELSE ${cat} END)`
}

function guessScalar(v: unknown): string {
  return typeof v === 'number' ? 'numeric' : typeof v === 'boolean' ? 'bool' : 'text'
}

/** A value inside json_each(?) rows for column type t. */
function encodeJsonCell(v: unknown, t: string): unknown {
  if (v === null || v === undefined) return null
  if (t === 'jsonb' || isArrayType(t)) return { j: v }
  if (v instanceof Interval) return v.toString()
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return { j: v }
  return v
}

/** Reads a cell back out of the json_each row (JSON values were wrapped as {j: …}). */
function jsonCell(row: string, key: string, t: string, wrapped = true): string {
  const path = `'$."${key.replaceAll("'", "''").replaceAll('"', '\\"')}"'`
  if ((t === 'jsonb' || isArrayType(t)) && !wrapped) return `(${row} -> ${path})`
  if (t === 'jsonb' || isArrayType(t)) return `coalesce((${row} -> ${path}) -> '$.j', CASE WHEN json_type(${row}, ${path}) = 'object' OR json_type(${row}, ${path}) = 'array' THEN ${row} -> ${path} END)`
  if (t === 'bool') return `json_extract(${row}, ${path})`
  return `json_extract(${row}, ${path})`
}

function rowObject(r: unknown, names: string[]): Record<string, unknown> {
  if (r && typeof r === 'object' && 'values' in (r as object) && (r as { values: unknown }).values && typeof (r as { get?: unknown }).get === 'function') {
    return (r as { values: Record<string, unknown> }).values
  }
  if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>
  return { [names[0]]: r }
}

const builtinsInternals = { addInterval: (ms: number, iv: Interval) => addIv(ms, iv) }

export { quoteId }

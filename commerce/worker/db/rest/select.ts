// Reads with embedded resources. The root query and one query per embedded level
// (all parents' keys at once) run through the row-security shadowing, so every
// level shows only rows the caller may see; results are assembled here.
import { decode, type SqlValue } from '../codec.ts'
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import { columnsOf, table, view, type ColumnMeta } from '../meta.ts'
import { requireGrant, secure } from '../policy.ts'
import type { Row, Sql } from '../sql.ts'
import type { Level, ParsedQuery, SelectItem } from './parse.ts'
import { resolve, type Relationship } from './relations.ts'
import { column, fieldSql, filterSql, jsonPath, type Source } from './where.ts'

export interface ReadEnv {
  sql: Sql
  ctx: Context
}

type Out = { key: string; sql: string; col?: ColumnMeta; json?: boolean; cast?: string }

interface Plan {
  source: Source
  outs: Out[]
  embeds: Array<{ item: Extract<SelectItem, { kind: 'embed' }>; rel: Relationship; path: string; plan: Plan; keyCols: string[] }>
  level: Level
}

const emptyLevel: Level = { filters: [], order: [] }

function sourceOf(name: string): Source {
  const columns = columnsOf(name)
  if (!columns) throw new DbError('42P01', `relation "public.${name}" does not exist`)
  return { name, alias: quoteId(name), columns }
}

function plan(name: string, items: SelectItem[], levels: Map<string, Level>, path: string): Plan {
  const source = sourceOf(name)
  const outs: Out[] = []
  const embeds: Plan['embeds'] = []
  for (const item of items) {
    if (item.kind === 'star') {
      for (const [c, meta] of Object.entries(source.columns)) outs.push({ key: c, sql: `${source.alias}.${quoteId(c)}`, col: meta })
    } else if (item.kind === 'column') {
      const f = fieldSql(source, item.name, item.json)
      const last = item.json[item.json.length - 1]
      outs.push({ key: item.alias ?? (last ? last.key : item.name), sql: last?.op === '->' ? `${source.alias}.${quoteId(item.name)} -> ${jsonPath(item.json)}` : f.sql,
        col: item.json.length ? undefined : f.col, json: last?.op === '->', cast: item.cast })
    } else {
      if (!table(name)) throw new DbError('PGRST200', `Could not find a relationship between '${name}' and '${item.relation}' in the schema cache`)
      const rel = resolve(name, item.relation, item.hint)
      const childPath = path ? `${path}.${item.alias ?? item.relation}` : item.alias ?? item.relation
      const level = levels.get(childPath) ?? levels.get(path ? `${path}.${item.relation}` : item.relation) ?? emptyLevel
      const childLevels = levels
      embeds.push({ item, rel, path: childPath, plan: { ...plan(rel.target, item.select, childLevels, childPath), level }, keyCols: rel.parentColumns })
      if (item.spread && !rel.toOne) throw new DbError('PGRST119', `A spread operation on '${item.relation}' is only possible on a to-one relationship`)
    }
  }
  return { source, outs, embeds, level: levels.get(path) ?? emptyLevel }
}

/** EXISTS (…) for !inner embeds, including their own inner embeds. */
function innerExists(parentAlias: string, e: Plan['embeds'][number], params: SqlValue[], depth: number): string {
  const alias = `__i${depth}`
  const target = quoteId(e.rel.target)
  const join = e.rel.parentColumns.map((c, i) => `${alias}.${quoteId(e.rel.targetColumns[i])} = ${parentAlias}.${quoteId(c)}`).join(' AND ')
  const src: Source = { ...e.plan.source, alias }
  const filters = filterSql(src, e.plan.level.filters, params)
  const nested = e.plan.embeds.filter((n) => n.item.inner).map((n) => innerExists(alias, n, params, depth + 1))
  return `EXISTS (SELECT 1 FROM ${target} AS ${alias} WHERE ${[join, filters, ...nested].join(' AND ')})`
}

function orderSql(src: Source, level: Level): string {
  if (!level.order.length) return ''
  return ` ORDER BY ${level.order.map((o) => {
    const f = fieldSql(src, o.column, o.json)
    const nulls = o.nulls ?? (o.desc ? 'first' : 'last')
    return `${f.sql} ${o.desc ? 'DESC' : 'ASC'} NULLS ${nulls.toUpperCase()}`
  }).join(', ')}`
}

function decodeRow(row: Row, outs: Out[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i]
    let v = row[`c${i}`]
    if (o.json) v = typeof v === 'string' ? JSON.parse(v) : v ?? null
    else v = decode(v, o.col)
    if (o.cast && v !== null) {
      if (/^(text|varchar|character varying)$/.test(o.cast)) v = typeof v === 'object' ? JSON.stringify(v) : String(v)
      else if (/^(int|integer|bigint|numeric|float8|real|double precision)$/.test(o.cast)) v = Number(v)
    }
    obj[o.key] = v
  }
  return obj
}

/** Runs one level and its embeds; `parentKeys` limits it to rows of the given parents. */
/** Limits a level to rows whose `columns` match one of `keys` (a parent's keys, or primary keys). */
interface Scope { columns: string[]; keys: SqlValue[][] }

function runLevel(env: ReadEnv, p: Plan, scope: Scope | null, page: boolean): Array<{ obj: Record<string, unknown>; parentKey?: string }> {
  requireGrant(p.source.name, env.ctx, 'select')
  const params: SqlValue[] = []
  const cols = p.outs.map((o, i) => `${o.sql} AS c${i}`)
  // keys this level's embeds join on
  const keyIndex = new Map<string, number>()
  for (const e of p.embeds) for (const k of e.keyCols) {
    if (!keyIndex.has(k)) {
      column(p.source, k)
      keyIndex.set(k, keyIndex.size)
      cols.push(`${p.source.alias}.${quoteId(k)} AS k${keyIndex.get(k)}`)
    }
  }
  const where: string[] = []
  if (scope) {
    scope.columns.forEach((c, i) => cols.push(`${p.source.alias}.${quoteId(c)} AS p${i}`))
    const target = scope.columns.map((c) => `${p.source.alias}.${quoteId(c)}`)
    params.push(JSON.stringify(scope.keys))
    where.push(target.length === 1
      ? `${target[0]} IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`
      : `(${target.join(', ')}) IN (SELECT ${target.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(?))`)
  }
  where.push(filterSql(p.source, p.level.filters, params))
  for (const e of p.embeds) if (e.item.inner) where.push(innerExists(p.source.alias, e, params, 0))
  const order = orderSql(p.source, p.level)
  let sql = `SELECT ${cols.join(', ')} FROM ${quoteId(p.source.name)} AS ${p.source.alias} WHERE ${where.join(' AND ')}`
  const { limit, offset } = p.level
  if (scope && (limit !== undefined || offset !== undefined)) {
    // Per-parent paging (orders.limit=3 gives each parent up to three).
    const part = scope.columns.map((c) => `${p.source.alias}.${quoteId(c)}`).join(', ')
    sql = `SELECT * FROM (SELECT ${cols.join(', ')}, row_number() OVER (PARTITION BY ${part}${order}) AS rn FROM ${quoteId(p.source.name)} AS ${p.source.alias} WHERE ${where.join(' AND ')}) WHERE rn > ${offset ?? 0}${limit !== undefined ? ` AND rn <= ${(offset ?? 0) + limit}` : ''} ORDER BY rn`
  } else {
    sql += order
    if (page && limit !== undefined) sql += ` LIMIT ${limit}`
    if (page && offset !== undefined) sql += `${limit === undefined ? ' LIMIT -1' : ''} OFFSET ${offset}`
  }
  const rows = env.sql.all(secure(sql, env.ctx), params)
  const result = rows.map((row) => ({
    row,
    obj: decodeRow(row, p.outs),
    parentKey: scope ? JSON.stringify(scope.columns.map((_, i) => row[`p${i}`])) : undefined,
  }))

  for (const e of p.embeds) {
    const idx = e.keyCols.map((k) => keyIndex.get(k)!)
    const keyOf = (row: Row) => idx.map((i) => row[`k${i}`] as SqlValue)
    const keys = new Map<string, SqlValue[]>()
    for (const r of result) {
      const k = keyOf(r.row)
      if (k.some((v) => v === null || v === undefined)) continue
      keys.set(JSON.stringify(k), k)
    }
    const children = keys.size ? runLevel(env, e.plan, { columns: e.rel.targetColumns, keys: [...keys.values()] }, true) : []
    const byParent = new Map<string, Array<Record<string, unknown>>>()
    for (const c of children) {
      const list = byParent.get(c.parentKey!) ?? []
      list.push(c.obj)
      byParent.set(c.parentKey!, list)
    }
    const name = e.item.alias ?? e.item.relation
    for (const r of result) {
      const k = keyOf(r.row)
      const found = k.some((v) => v === null || v === undefined) ? [] : byParent.get(JSON.stringify(k)) ?? []
      if (e.rel.toOne) {
        const one = found[0] ?? null
        if (e.item.spread) Object.assign(r.obj, one ?? Object.fromEntries(e.plan.outs.map((o) => [o.key, null])))
        else r.obj[name] = one
      } else r.obj[name] = found
    }
  }
  return result.map(({ obj, parentKey }) => ({ obj, parentKey }))
}

export function read(env: ReadEnv, name: string, q: ParsedQuery, opts: { count?: boolean; rows?: boolean } = {}): { rows: Array<Record<string, unknown>>; total: number | null } {
  if (!table(name) && !view(name)) throw new DbError('42P01', `relation "public.${name}" does not exist`)
  const p = plan(name, q.select, q.levels, '')
  const rows = opts.rows === false ? [] : runLevel(env, p, null, true).map((r) => r.obj)
  let total: number | null = null
  if (opts.count) {
    requireGrant(name, env.ctx, 'select')
    const params: SqlValue[] = []
    const where = [filterSql(p.source, p.level.filters, params), ...p.embeds.filter((e) => e.item.inner).map((e) => innerExists(p.source.alias, e, params, 0))]
    total = Number(env.sql.all(secure(`SELECT count(*) AS n FROM ${quoteId(name)} AS ${p.source.alias} WHERE ${where.join(' AND ')}`, env.ctx), params)[0].n)
  }
  return { rows, total }
}

/**
 * Reads rows by primary key after a write, with the request's select list and the
 * caller's SELECT policies (Postgres refuses RETURNING a row the caller may not see).
 */
export function readByKeys(env: ReadEnv, name: string, q: ParsedQuery, keys: SqlValue[][]): Array<Record<string, unknown>> {
  if (!keys.length) return []
  const pk = table(name)!.pk
  const p = plan(name, q.select, q.levels, '')
  const rows = runLevel(env, { ...p, level: emptyLevel }, { columns: pk, keys }, false)
  if (rows.length < new Set(keys.map((k) => JSON.stringify(k))).size) {
    throw new DbError('42501', `new row violates row-level security policy for table "${name}"`)
  }
  const position = new Map(keys.map((k, i) => [JSON.stringify(k), i]))
  return rows.sort((a, b) => position.get(a.parentKey!)! - position.get(b.parentKey!)!).map((r) => r.obj)
}

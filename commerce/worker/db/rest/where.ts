// PostgREST filters → SQLite conditions with bound parameters. Values are converted
// with the column's type first, so a bad uuid or date fails like it did in Postgres.
import { encode, encodeFilter, type SqlValue } from '../codec.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import type { ColumnMeta } from '../meta.ts'
import { parseList, type Filter, type JsonStep } from './parse.ts'

export interface Source {
  name: string
  alias: string
  columns: Record<string, ColumnMeta>
}

export function column(src: Source, name: string): ColumnMeta {
  const c = Object.hasOwn(src.columns, name) ? src.columns[name] : undefined
  if (!c) throw new DbError('42703', `column ${src.name}.${name} does not exist`)
  return c
}

/** '$."a"."b"' for a JSON path. */
export function jsonPath(steps: JsonStep[]): string {
  return `'$${steps.map((s) => (/^\d+$/.test(s.key) ? `[${s.key}]` : `."${s.key.replaceAll('"', '\\"').replaceAll("'", "''")}"`)).join('')}'`
}

/** The SQL for a column or a JSON path inside it. ->> yields text, as in Postgres. */
export function fieldSql(src: Source, name: string, json: JsonStep[]): { sql: string; col: ColumnMeta | undefined; text: boolean } {
  const col = column(src, name)
  const base = `${src.alias}.${quoteId(name)}`
  if (!json.length) return { sql: base, col, text: false }
  const path = jsonPath(json)
  if (json[json.length - 1].op === '->>') {
    return {
      sql: `(CASE json_type(${base}, ${path}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'object' THEN json_extract(${base}, ${path}) WHEN 'array' THEN json_extract(${base}, ${path}) ELSE CAST(json_extract(${base}, ${path}) AS TEXT) END)`,
      col: undefined, text: true,
    }
  }
  return { sql: `json_extract(${base}, ${path})`, col: undefined, text: false }
}

/** like/ilike pattern: PostgREST lets * stand for %. */
const likePattern = (p: string) => p.replaceAll('*', '%')

/** A case-sensitive LIKE (Postgres) as a GLOB pattern. */
function globPattern(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i]
      out += n === '*' || n === '?' || n === '[' ? `[${n}]` : n
    } else if (c === '%' || c === '*') out += '*'
    else if (c === '_') out += '?'
    else if (c === '?' || c === '[' || c === ']') out += `[${c}]`
    else out += c
  }
  return out
}

/**
 * %text%, text% and %text without other wildcards, as instr/substr: exact, index-free
 * either way, and not subject to the 50-byte LIKE/GLOB pattern limit of Durable Objects.
 */
function simpleMatch(sql: string, pattern: string, insensitive: boolean, push: (v: SqlValue) => string): string | null {
  const m = /^(%?)([^%_\\]*)(%?)$/.exec(pattern)
  if (!m) return null
  const [, lead, text, tail] = m
  const col = insensitive ? `lower(${sql})` : sql
  const value = insensitive ? text.toLowerCase() : text
  if ((lead || tail) && value === '') return `${sql} IS NOT NULL`
  if (lead && tail) return `instr(${col}, ${push(value)}) > 0`
  if (tail) return `substr(${col}, 1, ${[...value].length}) = ${push(value)}`
  if (lead) return `substr(${col}, -${[...value].length}) = ${push(value)}`
  return `${col} = ${push(value)}`
}

function scalarValue(value: string, col: ColumnMeta | undefined, text: boolean): SqlValue {
  if (text || !col) return value
  if (col.type === 'array') return encode(parseList(value, '{', '}'), col)
  return encodeFilter(value, col)
}

function condition(src: Source, f: Extract<Filter, { kind: 'cond' }>, params: SqlValue[]): string {
  const { sql, col, text } = fieldSql(src, f.column, f.json)
  const push = (v: SqlValue) => {
    params.push(v)
    return '?'
  }
  const anyAll = (patterns: string[], one: (p: string) => string) => {
    const parts = patterns.map(one)
    return `(${parts.join(f.quantifier === 'all' ? ' AND ' : ' OR ')})`
  }
  let out: string
  switch (f.op) {
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': {
      const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op]
      if (f.quantifier) {
        out = anyAll(parseList(f.value, '{', '}'), (v) => `${sql} ${op} ${push(scalarValue(v, col, text))}`)
      } else out = `${sql} ${op} ${push(scalarValue(f.value, col, text))}`
      break
    }
    case 'like': {
      const one = (p: string) => simpleMatch(sql, likePattern(p), false, push) ?? `${sql} GLOB ${push(globPattern(likePattern(p)))}`
      out = f.quantifier ? anyAll(parseList(f.value, '{', '}'), one) : one(f.value)
      break
    }
    case 'ilike': {
      const one = (p: string) => simpleMatch(sql, likePattern(p), true, push) ?? `lower(${sql}) LIKE lower(${push(likePattern(p))}) ESCAPE '\\'`
      out = f.quantifier ? anyAll(parseList(f.value, '{', '}'), one) : one(f.value)
      break
    }
    case 'in': {
      const list = parseList(f.value)
      if (!list.length) out = '0'
      else {
        const values = list.map((v) => (v.toLowerCase() === 'null' ? null : scalarValue(v, col, text)))
        const nonNull = values.filter((v) => v !== null)
        const hasNull = values.length !== nonNull.length
        out = `(${sql} IN (SELECT value FROM json_each(${push(JSON.stringify(nonNull))}))${hasNull ? ` OR ${sql} IS NULL` : ''})`
      }
      break
    }
    case 'is': {
      const v = f.value.toLowerCase()
      if (v === 'null' || v === 'unknown') out = `${sql} IS NULL`
      else if (v === 'not_null') out = `${sql} IS NOT NULL`
      else if (v === 'true') out = `${sql} IS 1`
      else if (v === 'false') out = `${sql} IS 0`
      else throw new DbError('22023', `"failed to parse filter (is.${f.value})"`)
      break
    }
    case 'isdistinct':
      out = `${sql} IS NOT ${push(scalarValue(f.value, col, text))}`
      break
    case 'cs': case 'cd': case 'ov': {
      if (!col || (col.type !== 'array' && col.type !== 'json')) throw new DbError('42883', `operator does not exist for ${f.column}`)
      let list: string
      if (col.type === 'array') list = String(encode(f.value.trim().startsWith('[') ? JSON.parse(f.value) : parseList(f.value, '{', '}'), col))
      else {
        const parsed = JSON.parse(f.value) as unknown
        if (f.op === 'cs' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // jsonb @> '{"key": value}' for flat objects
          const entries = Object.entries(parsed as Record<string, unknown>)
          out = entries.length ? `(${entries.map(([k, v]) => `json_extract(${sql}, ${jsonPath([{ op: '->', key: k }])}) IS ${push(typeof v === 'boolean' ? (v ? 1 : 0) : v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as SqlValue))}`).join(' AND ')})` : '1'
          break
        }
        list = JSON.stringify(parsed)
      }
      const p = push(list)
      if (f.op === 'cs') out = `NOT EXISTS (SELECT 1 FROM json_each(${p}) v WHERE v.value NOT IN (SELECT value FROM json_each(${sql})))`
      else if (f.op === 'cd') out = `NOT EXISTS (SELECT 1 FROM json_each(${sql}) v WHERE v.value NOT IN (SELECT value FROM json_each(${p})))`
      else out = `EXISTS (SELECT 1 FROM json_each(${sql}) v WHERE v.value IN (SELECT value FROM json_each(${p})))`
      break
    }
    default:
      throw new DbError('0A000', `The ${f.op} filter is not available`)
  }
  return f.negate ? `NOT (${out})` : out
}

export function filterSql(src: Source, filters: Filter[], params: SqlValue[]): string {
  const parts = filters.map((f) => node(src, f, params))
  return parts.length ? parts.join(' AND ') : '1'
}

function node(src: Source, f: Filter, params: SqlValue[]): string {
  if (f.kind === 'cond') return condition(src, f, params)
  const inner = f.items.map((i) => node(src, i, params))
  const joined = inner.length ? `(${inner.join(f.op === 'and' ? ' AND ' : ' OR ')})` : f.op === 'and' ? '1' : '0'
  return f.negate ? `NOT ${joined}` : joined
}

// Between engine values (values.ts) and what SQLite stores and returns (codec.ts:
// booleans 0/1, JSON and arrays as text, numbers as REAL/INTEGER, dates as text).
import type { SqlValue } from '../codec.ts'
import type { ColumnMeta } from '../meta.ts'
import { elemType, isArrayType } from './types.ts'
import { cleanNumber, Interval, isTableType, JNULL, parseArrayText, parseInterval, parseJson, PgRow, plainValue, toText } from './values.ts'

/** The engine type of a stored column. */
export function columnType(c: ColumnMeta): string {
  switch (c.type) {
    case 'json': return 'jsonb'
    case 'array': return `${c.elem === 'enum' ? c.enum ?? 'text' : columnType({ type: c.elem ?? 'text' } as ColumnMeta)}[]`
    case 'enum': return c.enum ?? 'text'
    case 'bytes': return 'bytea'
    case 'timestamptz': return c.local ? 'timestamp' : 'timestamptz'
    default: return c.type
  }
}

/** An engine value bound as a SQLite parameter. */
export function encodeSql(v: unknown, t: string): SqlValue {
  if (v === null || v === undefined) return null
  if (v === JNULL) return 'null'
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v
  // intervals travel through SQLite as [months, days, seconds] (see compile.ts)
  if (v instanceof Interval) return JSON.stringify([v.months, v.days, v.ms / 1000])
  if (v instanceof Uint8Array) return v
  if (v instanceof PgRow) return JSON.stringify(v.plain())
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(plainValue(v))
  return toText(v, t)
}

/** A SQLite result value read as type t. */
export function decodeSql(raw: unknown, t: string): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') raw = Number(raw)
  if (isArrayType(t)) {
    if (typeof raw !== 'string') return [raw]
    const et = elemType(t)
    if (raw.startsWith('{')) return parseArrayText(raw).map((x) => (x === null ? null : decodeElem(x, et)))
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((x) => (x === null ? null : decodeElem(x, et)))
  }
  switch (t) {
    case 'bool':
      return raw === 1 || raw === '1' || raw === true || raw === 'true' || raw === 't'
    case 'int':
      return typeof raw === 'number' ? Math.trunc(raw) : Number(raw)
    case 'numeric':
      return cleanNumber(typeof raw === 'number' ? raw : Number(raw))
    case 'jsonb':
      if (typeof raw === 'string') return parseJson(raw)
      return raw
    case 'interval': {
      if (raw instanceof Interval) return raw
      const text = String(raw)
      if (text.startsWith('[')) {
        const [m, d, secs] = JSON.parse(text) as number[]
        return new Interval(Math.trunc(m ?? 0), Math.trunc(d ?? 0), Math.round((secs ?? 0) * 1000))
      }
      return parseInterval(text)
    }
    case 'bytea':
      return raw
    case 'text': case 'uuid': case 'unknown':
      return typeof raw === 'number' ? String(raw) : raw
    case 'record':
      return typeof raw === 'string' && raw.startsWith('{') ? rowFromJson(JSON.parse(raw), null) : raw
    default:
      if (isTableType(t) && typeof raw === 'string' && raw.startsWith('{')) return rowFromJson(JSON.parse(raw), t)
      return typeof raw === 'number' && t !== 'int' && t !== 'numeric' ? String(raw) : raw
  }
}

function decodeElem(x: unknown, t: string): unknown {
  switch (t) {
    case 'bool': return x === true || x === 1
    case 'int': case 'numeric': return typeof x === 'number' ? x : Number(x)
    case 'jsonb': return x
    default: return typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x)
  }
}

let rowTypes: ((table: string) => Record<string, string> | null) | null = null

/** Set by the engine: the column types of a table's row type. */
export function setRowTypes(fn: (table: string) => Record<string, string> | null): void {
  rowTypes = fn
}

/** A JSON object (json_object of a row) as a row value. */
export function rowFromJson(o: Record<string, unknown>, table: string | null): PgRow {
  const types = (table && rowTypes?.(table)) || {}
  const values: Record<string, unknown> = {}
  const outTypes: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    const t = types[k] ?? (typeof v === 'number' ? 'numeric' : typeof v === 'boolean' ? 'bool' : v !== null && typeof v === 'object' ? 'jsonb' : 'text')
    outTypes[k] = t
    values[k] = v === null ? null : t === 'jsonb' ? v : decodeSql(typeof v === 'object' ? JSON.stringify(v) : v, t)
  }
  return new PgRow(values, outTypes)
}

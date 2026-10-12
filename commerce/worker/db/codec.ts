// Values between the app (JSON, as PostgREST sends and returns them) and SQLite.
//
//   uuid, text, enum      TEXT (uuids lower-case)
//   timestamptz           TEXT, ISO 8601 in UTC with milliseconds: 2026-10-12T08:30:00.000Z
//   date / time           TEXT, 2026-10-12 / 08:30:00
//   numeric(p, s)         REAL, rounded to s decimals on every write
//   bool                  INTEGER 0/1
//   json, arrays          TEXT holding JSON
import { DbError } from './errors.ts'
import type { ColumnMeta, ColumnType } from './meta.ts'

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i

const invalid = (type: string, value: unknown): never => {
  throw new DbError('22P02', `invalid input syntax for type ${type}: "${String(value).slice(0, 80)}"`)
}

/** Rounds half away from zero to `scale` decimals, like Postgres numeric. */
export function roundTo(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value
  const text = String(Math.abs(value))
  if (/e/i.test(text)) return Number(value.toFixed(scale))
  const shifted = Math.round(Number(`${text}e${scale}`))
  return Math.sign(value) * Number(`${shifted}e-${scale}`) || 0
}

/** Any accepted timestamp → 2026-10-12T08:30:00.000Z. Without an offset the time is UTC. */
export function toTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalid('timestamp with time zone', value)
    return value.toISOString()
  }
  if (typeof value === 'number') return new Date(value).toISOString()
  const text = String(value).trim()
  if (/^now$/i.test(text)) return new Date().toISOString()
  const m = TS_RE.exec(text)
  if (!m) return invalid('timestamp with time zone', value)
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = m
  let offset = 0
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!
    offset = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0))
  }
  const ms = frac ? Math.floor(Number(`0${frac}`) * 1000) : 0
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms)
  const check = new Date(local)
  // Rejects 2026-02-30, 25:00 and the like instead of rolling them over.
  if (Number.isNaN(local) || check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d) ||
    check.getUTCHours() !== Number(h) || check.getUTCMinutes() !== Number(mi) || Number(y) < 1000) {
    invalid('timestamp with time zone', value)
  }
  return new Date(local - offset * 60_000).toISOString()
}

function toDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(`${text}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) invalid('date', value)
    return text
  }
  return toTimestamp(text).slice(0, 10)
}

function toTime(value: unknown): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(String(value).trim())
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) invalid('time without time zone', value)
  return `${m![1].padStart(2, '0')}:${m![2]}:${m![3] ?? '00'}`
}

function toNumber(value: unknown, type: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(type, value)
    return value
  }
  if (typeof value === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(value)) return Number(value)
  if (typeof value === 'boolean' && type === 'integer') invalid(type, value)
  return invalid(type, value)
}

function scalar(value: unknown, type: ColumnType, col: Pick<ColumnMeta, 'values' | 'scale'>): string | number | null {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'uuid': {
      const s = String(value)
      if (!UUID_RE.test(s)) invalid('uuid', value)
      return s.toLowerCase()
    }
    case 'text':
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
    case 'enum': {
      const s = String(value)
      if (col.values && !col.values.includes(s)) {
        throw new DbError('22P02', `invalid input value for enum: "${s.slice(0, 80)}"`)
      }
      return s
    }
    case 'int': {
      const n = toNumber(value, 'integer')
      if (!Number.isInteger(n)) invalid('integer', value)
      return n
    }
    case 'numeric': {
      const n = toNumber(value, 'numeric')
      return col.scale === undefined ? n : roundTo(n, col.scale)
    }
    case 'bool': {
      if (value === true || value === 1) return 1
      if (value === false || value === 0) return 0
      const s = String(value).trim().toLowerCase()
      if (['t', 'true', 'y', 'yes', 'on', '1'].includes(s)) return 1
      if (['f', 'false', 'n', 'no', 'off', '0'].includes(s)) return 0
      return invalid('boolean', value)
    }
    case 'timestamptz': return toTimestamp(value)
    case 'date': return toDate(value)
    case 'time': return toTime(value)
    default: return invalid(type, value)
  }
}

/** Postgres array text ({a,b,"c d"}) → items. */
function parsePgArray(text: string): Array<string | null> {
  const inner = text.trim().replace(/^\{|\}$/g, '')
  if (inner === '') return []
  const items: Array<string | null> = []
  let cur = ''
  let quoted = false
  let wasQuoted = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quoted) {
      if (c === '\\') cur += inner[++i]
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') {
      quoted = true
      wasQuoted = true
    } else if (c === ',') {
      items.push(!wasQuoted && cur.trim().toUpperCase() === 'NULL' ? null : wasQuoted ? cur : cur.trim())
      cur = ''
      wasQuoted = false
    } else cur += c
  }
  items.push(!wasQuoted && cur.trim().toUpperCase() === 'NULL' ? null : wasQuoted ? cur : cur.trim())
  return items
}

/** A value from the app → what SQLite stores for this column. */
export function encode(value: unknown, col: ColumnMeta): SqlValue {
  if (value === null || value === undefined) return null
  switch (col.type) {
    case 'json':
      return JSON.stringify(value)
    case 'array': {
      const list = Array.isArray(value) ? value : typeof value === 'string' && value.trim().startsWith('{') ? parsePgArray(value) : invalid('array', value)
      return JSON.stringify(list.map((v) => scalar(v, col.elem ?? 'text', {})))
    }
    case 'bytes':
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value
      return invalid('bytea', value)
    default:
      return scalar(value, col.type, col)
  }
}

/** A stored value → the JSON value PostgREST would return. */
export function decode(raw: unknown, col: ColumnMeta | undefined): unknown {
  if (raw === null || raw === undefined) return null
  if (!col) return typeof raw === 'bigint' ? Number(raw) : raw
  switch (col.type) {
    case 'bool': return raw === 1 || raw === 1n || raw === '1' || raw === true
    case 'json':
    case 'array': return typeof raw === 'string' ? JSON.parse(raw) : raw
    case 'int':
    case 'numeric': return typeof raw === 'bigint' ? Number(raw) : typeof raw === 'string' ? Number(raw) : raw
    default: return raw
  }
}

/** Encodes a filter value (always text in a PostgREST query string) for a column. */
export function encodeFilter(value: string, col: ColumnMeta | undefined): SqlValue {
  if (!col) return value
  if (col.type === 'json') return value
  if (col.type === 'array') return encode(value, col)
  return scalar(value, col.type === 'enum' ? 'text' : col.type, col)
}

// Postgres built-in functions: a JavaScript version (constant arguments, PL/pgSQL
// expressions) and, where queries use them on columns, a SQLite version. Aggregates,
// window and set-returning functions only have the SQLite form.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { Expr } from './ast.ts'
import { schema } from '../meta.ts'
import type { Engine, Typed } from './runtime.ts'
import { elemType, isArrayType } from './types.ts'
import {
  addInterval, cast, cleanNumber, compare, err, guessType, Interval, isJNull, isoLocal, isoZ, jsonKeyOrder, jsonText, jsonType, JNULL,
  localToTz, parseInterval, PgRow, toJson, toText, tzToLocal, zoneOffset,
} from './values.ts'

/** A compiled SQL argument. */
export interface SqlArg {
  sql: string
  t: string
  /** Set when the argument is a constant (its value). */
  c?: Typed
  /** A whole row from a FROM item: its columns. */
  cols?: Record<string, { sql: string; t: string }>
}

export interface SqlHelp {
  /** The argument as something json_object/json_array embeds correctly (booleans, nested JSON). */
  json(a: SqlArg): string
  /** The argument as JSON text (a jsonb value). */
  jsonValue(a: SqlArg): string
  bind(v: unknown, t: string): string
  engine: Engine
}

export interface CallInfo {
  engine: Engine
  names?: Array<string | null>
  exprs: Expr[]
}

export interface Builtin {
  ret: (types: string[], exprs: Expr[]) => string
  js?: (args: unknown[], types: string[], call: CallInfo) => unknown
  /** NULL in → NULL out (default true). */
  strict?: boolean
  sql?: (a: SqlArg[], h: SqlHelp) => string
  agg?: boolean
  window?: boolean
  /** A new value each call (never folded inside a multi-row query). */
  volatile?: boolean
}

const fixed = (t: string) => () => t

let grantsOf: (name: string) => string[] | null = () => null
/** Set by the engine: who may execute a function (anon / authenticated). */
export function setFunctionGrants(fn: (name: string) => string[] | null): void {
  grantsOf = fn
}
const functionGrants = (name: string) => grantsOf(name)
const same = (types: string[]) => (types.find((t) => t !== 'unknown' && t !== 'null') ?? 'text')
const str = (v: unknown, t = 'text') => (typeof v === 'string' ? v : toText(v, t))
const q = (s: string) => `'${s.replaceAll("'", "''")}'`
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))

// ---------------------------------------------------------------- regular expressions

const POSIX: Record<string, string> = {
  alpha: 'A-Za-z\\u00C0-\\uFFFF', digit: '0-9', alnum: 'A-Za-z0-9\\u00C0-\\uFFFF', space: '\\s', upper: 'A-Z', lower: 'a-z', punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f', word: '\\w', blank: ' \\t', cntrl: '\\x00-\\x1F',
}

/** A Postgres (ARE) regular expression as a JavaScript one. */
export function pgRegex(pattern: string, flags = ''): RegExp {
  let p = pattern
  let f = flags.replace(/[^gi]/g, '')
  const embedded = /^\(\?([a-z]+)\)/.exec(p)
  if (embedded) {
    if (embedded[1].includes('i')) f += 'i'
    p = p.slice(embedded[0].length)
  }
  p = p.replace(/\[\[:([a-z]+):\]\]/g, (_, c: string) => `[${POSIX[c] ?? c}]`).replace(/\[:([a-z]+):\]/g, (_, c: string) => POSIX[c] ?? c)
  p = p.replace(/\\m/g, '\\b(?=\\w)').replace(/\\M/g, '\\b(?<=\\w)').replace(/\\y/g, '\\b').replace(/\\Y/g, '\\B').replace(/\\A/g, '^').replace(/\\Z/g, '$')
  try {
    return new RegExp(p, [...new Set(f)].join(''))
  } catch {
    return err('2201B', `invalid regular expression: ${pattern}`)
  }
}

/** LIKE / ILIKE pattern as a regular expression. */
export function likeRegex(pattern: string, ci: boolean, escape = '\\'): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (escape && c === escape) {
      const n = pattern[++i] ?? ''
      out += n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (c === '%') out += '[\\s\\S]*'
    else if (c === '_') out += '[\\s\\S]'
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, ci ? 'i' : '')
}

// ---------------------------------------------------------------- dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Milliseconds since epoch of a date-family value, reading wall times as UTC. */
export function msOf(v: unknown, t: string): number {
  const s = String(v)
  if (t === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s.slice(0, 10)}T00:00:00Z`)
  if (t === 'timestamp' || (!s.endsWith('Z') && /T\d/.test(s) && !/[+-]\d{2}(:?\d{2})?$/.test(s))) return Date.parse(`${s.slice(0, 23)}Z`)
  return Date.parse(s)
}

/** A timestamp-family result back in the representation of type t. */
export function fromMs(ms: number, t: string): string {
  if (t === 'date') return isoZ(new Date(ms)).slice(0, 10)
  if (t === 'timestamp') return isoLocal(new Date(ms))
  return isoZ(new Date(ms))
}

function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7) }
}

export function extract(field: string, v: unknown, t: string): number | null {
  const f = field.toLowerCase().replace(/s$/, '').replace(/^epoch$/, 'epoch')
  if (v instanceof Interval) {
    switch (f) {
      case 'epoch': return v.epoch()
      case 'year': return Math.trunc(v.months / 12)
      case 'month': return v.months % 12
      case 'day': return v.days
      case 'hour': return Math.trunc(v.ms / 3_600_000)
      case 'minute': return Math.trunc((v.ms % 3_600_000) / 60_000)
      case 'second': return (v.ms % 60_000) / 1000
      default: return err('22023', `interval units "${field}" not supported`)
    }
  }
  const ms = msOf(v, t)
  const d = new Date(ms)
  switch (f) {
    case 'epoch': return t === 'date' ? ms / 1000 : ms / 1000
    case 'year': return d.getUTCFullYear()
    case 'month': return d.getUTCMonth() + 1
    case 'day': return d.getUTCDate()
    case 'hour': return d.getUTCHours()
    case 'minute': return d.getUTCMinutes()
    case 'second': return d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
    case 'millisecond': return d.getUTCSeconds() * 1000 + d.getUTCMilliseconds()
    case 'microsecond': return (d.getUTCSeconds() * 1000 + d.getUTCMilliseconds()) * 1000
    case 'dow': return d.getUTCDay()
    case 'isodow': return d.getUTCDay() || 7
    case 'doy': return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1
    case 'week': return isoWeek(d).week
    case 'isoyear': return isoWeek(d).year
    case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1
    case 'decade': return Math.floor(d.getUTCFullYear() / 10)
    case 'century': return Math.ceil(d.getUTCFullYear() / 100)
    case 'timezone': return 0
    default: return err('22023', `units "${field}" not recognized`)
  }
}

export function dateTrunc(unit: string, v: unknown, t: string, zone?: string): string {
  const u = unit.toLowerCase()
  let ms = msOf(v, t)
  let offset = 0
  if (t !== 'timestamp' && t !== 'date' && zone) {
    offset = zoneOffset(zone, ms) * 60_000
    ms += offset
  }
  const d = new Date(ms)
  let out: number
  switch (u) {
    case 'microseconds': case 'milliseconds': out = ms; break
    case 'second': out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()); break
    case 'minute': out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()); break
    case 'hour': out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()); break
    case 'day': out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); break
    case 'week': {
      const day = d.getUTCDay() || 7
      out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1)
      break
    }
    case 'month': out = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); break
    case 'quarter': out = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1); break
    case 'year': out = Date.UTC(d.getUTCFullYear(), 0, 1); break
    case 'decade': out = Date.UTC(Math.floor(d.getUTCFullYear() / 10) * 10, 0, 1); break
    default: return err('22023', `unit "${unit}" not recognized`)
  }
  out -= offset
  return fromMs(out, t === 'date' ? 'timestamptz' : t)
}

/** to_char for dates and times. */
function toCharDate(v: unknown, t: string, fmt: string): string {
  const d = new Date(msOf(v, t))
  let out = ''
  let i = 0
  const two = (n: number, fm: boolean) => (fm ? String(n) : String(n).padStart(2, '0'))
  while (i < fmt.length) {
    if (fmt[i] === '"') {
      const j = fmt.indexOf('"', i + 1)
      out += fmt.slice(i + 1, j < 0 ? undefined : j)
      i = j < 0 ? fmt.length : j + 1
      continue
    }
    let fm = false
    if (fmt.startsWith('FM', i)) {
      fm = true
      i += 2
    }
    const rest = fmt.slice(i)
    const tok = /^(YYYY|IYYY|YY|MONTH|Month|month|MON|Mon|mon|MM|DDD|DD|D|DAY|Day|day|DY|Dy|dy|HH24|HH12|HH|MI|SS|MS|US|AM|PM|am|pm|A\.M\.|P\.M\.|Q|IW|WW|TZ|tz|OF)/.exec(rest)
    if (!tok) {
      out += fmt[i]
      i++
      continue
    }
    const k = tok[1]
    i += k.length
    const h = d.getUTCHours()
    switch (k) {
      case 'YYYY': out += String(d.getUTCFullYear()); break
      case 'IYYY': out += String(isoWeek(d).year); break
      case 'YY': out += String(d.getUTCFullYear()).slice(-2); break
      case 'MONTH': out += fm ? MONTHS[d.getUTCMonth()].toUpperCase() : MONTHS[d.getUTCMonth()].toUpperCase().padEnd(9); break
      case 'Month': out += fm ? MONTHS[d.getUTCMonth()] : MONTHS[d.getUTCMonth()].padEnd(9); break
      case 'month': out += fm ? MONTHS[d.getUTCMonth()].toLowerCase() : MONTHS[d.getUTCMonth()].toLowerCase().padEnd(9); break
      case 'MON': out += MONTHS[d.getUTCMonth()].slice(0, 3).toUpperCase(); break
      case 'Mon': out += MONTHS[d.getUTCMonth()].slice(0, 3); break
      case 'mon': out += MONTHS[d.getUTCMonth()].slice(0, 3).toLowerCase(); break
      case 'MM': out += two(d.getUTCMonth() + 1, fm); break
      case 'DDD': out += fm ? String(extract('doy', v, t)) : String(extract('doy', v, t)).padStart(3, '0'); break
      case 'DD': out += two(d.getUTCDate(), fm); break
      case 'D': out += String(d.getUTCDay() + 1); break
      case 'DAY': out += fm ? DAYS[d.getUTCDay()].toUpperCase() : DAYS[d.getUTCDay()].toUpperCase().padEnd(9); break
      case 'Day': out += fm ? DAYS[d.getUTCDay()] : DAYS[d.getUTCDay()].padEnd(9); break
      case 'day': out += fm ? DAYS[d.getUTCDay()].toLowerCase() : DAYS[d.getUTCDay()].toLowerCase().padEnd(9); break
      case 'DY': out += DAYS[d.getUTCDay()].slice(0, 3).toUpperCase(); break
      case 'Dy': out += DAYS[d.getUTCDay()].slice(0, 3); break
      case 'dy': out += DAYS[d.getUTCDay()].slice(0, 3).toLowerCase(); break
      case 'HH24': out += two(h, fm); break
      case 'HH12': case 'HH': out += two(h % 12 === 0 ? 12 : h % 12, fm); break
      case 'MI': out += two(d.getUTCMinutes(), fm); break
      case 'SS': out += two(d.getUTCSeconds(), fm); break
      case 'MS': out += String(d.getUTCMilliseconds()).padStart(3, '0'); break
      case 'US': out += String(d.getUTCMilliseconds() * 1000).padStart(6, '0'); break
      case 'AM': case 'PM': out += h < 12 ? 'AM' : 'PM'; break
      case 'am': case 'pm': out += h < 12 ? 'am' : 'pm'; break
      case 'A.M.': case 'P.M.': out += h < 12 ? 'A.M.' : 'P.M.'; break
      case 'Q': out += String(Math.floor(d.getUTCMonth() / 3) + 1); break
      case 'IW': out += two(isoWeek(d).week, fm); break
      case 'WW': out += two(Math.floor((extract('doy', v, t)! - 1) / 7) + 1, fm); break
      case 'TZ': out += 'UTC'; break
      case 'tz': out += 'utc'; break
      case 'OF': out += '+00'; break
    }
  }
  return out
}

/** to_char for numbers ('FM999,990.00', '9999'). */
function toCharNumber(n: number, fmt: string): string {
  const fm = fmt.startsWith('FM')
  const f = fm ? fmt.slice(2) : fmt
  const dot = f.indexOf('.') >= 0 ? f.indexOf('.') : f.indexOf('D')
  const decimals = dot >= 0 ? f.slice(dot + 1).replace(/[^09]/g, '').length : 0
  const grouping = /[,G]/.test(dot >= 0 ? f.slice(0, dot) : f)
  const intDigits = (dot >= 0 ? f.slice(0, dot) : f).replace(/[^09]/g, '').length
  const abs = Math.abs(n)
  let text = abs.toFixed(decimals)
  let [ip, fp] = text.split('.')
  if (ip.length > intDigits) return '#'.repeat(f.length)
  if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  text = fp !== undefined ? `${ip}.${fp}` : ip
  if (fm && fp !== undefined) text = text.replace(/0+$/, '').replace(/\.$/, '')
  const sign = n < 0 ? '-' : fm ? '' : ' '
  return fm ? `${sign}${text}` : `${sign}${text}`.padStart(f.length + 1)
}

/** age(a, b): years, months and days apart, like Postgres. */
function age(a: unknown, b: unknown, ta: string, tb: string): Interval {
  let x = new Date(msOf(a, ta))
  let y = new Date(msOf(b, tb))
  let sign = 1
  if (x < y) {
    ;[x, y] = [y, x]
    sign = -1
  }
  let years = x.getUTCFullYear() - y.getUTCFullYear()
  let months = x.getUTCMonth() - y.getUTCMonth()
  let days = x.getUTCDate() - y.getUTCDate()
  let ms = (x.getUTCHours() * 3600 + x.getUTCMinutes() * 60 + x.getUTCSeconds()) * 1000 + x.getUTCMilliseconds() -
    ((y.getUTCHours() * 3600 + y.getUTCMinutes() * 60 + y.getUTCSeconds()) * 1000 + y.getUTCMilliseconds())
  if (ms < 0) {
    ms += 86_400_000
    days--
  }
  if (days < 0) {
    const prevMonthDays = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 0)).getUTCDate()
    days += prevMonthDays
    months--
  }
  if (months < 0) {
    months += 12
    years--
  }
  return new Interval(sign * (years * 12 + months), sign * days, sign * ms)
}

// ---------------------------------------------------------------- json

function jsonPathKeys(path: unknown): string[] {
  if (Array.isArray(path)) return path.map((p) => String(p))
  const inner = String(path).trim().replace(/^\{|\}$/g, '')
  if (inner.trim() === '') return []
  return inner.split(',').map((k) => k.trim().replace(/^"|"$/g, ''))
}

export function jsonGet(j: unknown, key: unknown): unknown {
  if (j === null || j === undefined || j === JNULL) return null
  if (Array.isArray(j)) {
    let i = typeof key === 'number' ? key : /^-?\d+$/.test(String(key)) && typeof key !== 'string' ? Number(key) : NaN
    if (Number.isNaN(i)) return null
    if (i < 0) i += j.length
    const v = j[i]
    return v === undefined ? null : v === null ? JNULL : v
  }
  if (typeof j === 'object') {
    if (typeof key === 'number') return null
    const o = j as Record<string, unknown>
    if (!Object.hasOwn(o, String(key))) return null
    const v = o[String(key)]
    return v === null ? JNULL : v
  }
  return null
}

/** ->> : the element as text (strings unquoted, the rest as JSON text). */
export function jsonGetText(j: unknown, key: unknown): string | null {
  const v = jsonGet(j, key)
  if (v === null || v === JNULL) return null
  return typeof v === 'string' ? v : jsonText(v)
}

export function jsonPath(j: unknown, path: unknown): unknown {
  let cur = j
  for (const k of jsonPathKeys(path)) {
    if (cur === null || cur === JNULL) return null
    cur = jsonGet(cur, Array.isArray(cur) && /^-?\d+$/.test(k) ? Number(k) : k)
  }
  return cur
}

function jsonSet(target: unknown, path: unknown, value: unknown, create: boolean, insert = false, after = false): unknown {
  const keys = jsonPathKeys(path)
  if (!keys.length) return target
  const root = structuredCloneJson(target)
  const val = value === JNULL ? null : value
  let cur: unknown = root
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const last = i === keys.length - 1
    if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(k)) return err('22P02', `path element at position ${i + 1} is not an integer: "${k}"`)
      let idx = Number(k)
      if (idx < 0) idx += cur.length
      if (last) {
        if (insert) cur.splice(Math.max(0, Math.min(cur.length, after ? idx + 1 : idx)), 0, val)
        else if (idx >= 0 && idx < cur.length) cur[idx] = val
        else if (create) {
          if (idx < 0) cur.unshift(val)
          else cur.push(val)
        }
        return root
      }
      cur = cur[idx]
    } else if (cur && typeof cur === 'object' && cur !== JNULL) {
      const o = cur as Record<string, unknown>
      if (last) {
        if (insert && Object.hasOwn(o, k)) return err('22023', 'cannot replace existing key')
        if (Object.hasOwn(o, k) || create || insert) o[k] = val
        return root
      }
      cur = o[k]
    } else return root
    if (cur === undefined || cur === null) return root
  }
  return root
}

function structuredCloneJson(v: unknown): unknown {
  if (v === JNULL || v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object' && v !== JNULL) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== null) o[k] = stripNulls(x)
    return o
  }
  return v
}

/** jsonb @> jsonb */
export function jsonContains(a: unknown, b: unknown, top = true): boolean {
  if (b === JNULL) b = null
  if (a === JNULL) a = null
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return false
    return b.every((y) => a.some((x) => jsonContains(x, y, false)))
  }
  if (b && typeof b === 'object') {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false
    const o = a as Record<string, unknown>
    return Object.entries(b as Record<string, unknown>).every(([k, y]) => Object.hasOwn(o, k) && jsonContains(o[k], y, false))
  }
  if (Array.isArray(a) && top) return a.some((x) => !Array.isArray(x) && (x === null || typeof x !== 'object') && x === b)
  return a === b
}

/** jsonb ? key */
export function jsonHasKey(j: unknown, key: string): boolean {
  if (Array.isArray(j)) return j.some((x) => x === key)
  if (j && typeof j === 'object' && j !== JNULL) return Object.hasOwn(j, key)
  return j === key
}

/** jsonb - key / - text[] / - index */
export function jsonDelete(j: unknown, k: unknown, kt: string): unknown {
  if (Array.isArray(j)) {
    if (typeof k === 'number' && kt !== 'text' && kt !== 'unknown') {
      const i = k < 0 ? k + j.length : k
      return j.filter((_, x) => x !== i)
    }
    const keys = Array.isArray(k) ? k.map(String) : [String(k)]
    return j.filter((x) => !(typeof x === 'string' && keys.includes(x)))
  }
  if (j && typeof j === 'object' && j !== JNULL) {
    const keys = Array.isArray(k) ? k.map(String) : [String(k)]
    const o: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(j as Record<string, unknown>)) if (!keys.includes(key)) o[key] = v
    return o
  }
  return err('22023', 'cannot delete from scalar')
}

/** jsonb || jsonb */
export function jsonConcat(a: unknown, b: unknown): unknown {
  const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v) && v !== JNULL
  if (isObj(a) && isObj(b)) return { ...(a as object), ...(b as object) }
  const left = Array.isArray(a) ? a : [a === JNULL ? null : a]
  const right = Array.isArray(b) ? b : [b === JNULL ? null : b]
  return [...left, ...right]
}

// ---------------------------------------------------------------- format()

function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`
}

function quoteLiteral(s: string): string {
  return s.includes('\\') ? `E'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'` : `'${s.replaceAll("'", "''")}'`
}

export function pgFormat(fmt: string, args: unknown[], types: string[]): string {
  let out = ''
  let next = 0
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]
    if (c !== '%') {
      out += c
      continue
    }
    const m = /^(\d+\$)?(-)?(\d+|\*)?([sIL%])/.exec(fmt.slice(i + 1))
    if (!m) return err('22023', 'unrecognized format() type specifier')
    i += m[0].length
    if (m[4] === '%') {
      out += '%'
      continue
    }
    const idx = m[1] ? Number(m[1].slice(0, -1)) - 1 : next++
    if (m[1]) next = idx + 1
    if (idx >= args.length) return err('22023', 'too few arguments for format()')
    const v = args[idx]
    let s: string
    if (m[4] === 's') s = v === null || v === undefined ? '' : toText(v, types[idx] ?? guessType(v))
    else if (m[4] === 'I') {
      if (v === null) return err('22004', 'null values cannot be formatted as an SQL identifier')
      s = quoteIdent(toText(v, types[idx]))
    } else s = v === null || v === undefined ? 'NULL' : quoteLiteral(toText(v, types[idx]))
    const width = m[3] ? Number(m[3]) : 0
    if (width) s = m[2] ? s.padEnd(width) : s.padStart(width)
    out += s
  }
  return out
}

// ---------------------------------------------------------------- bytes

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new TextEncoder().encode(String(v)))

function encodeBytes(b: Uint8Array, fmt: string): string {
  switch (fmt.toLowerCase()) {
    case 'hex': return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    case 'base64': return btoa(String.fromCharCode(...b))
    case 'escape': return new TextDecoder().decode(b)
    default: return err('22023', `unrecognized encoding: "${fmt}"`)
  }
}

function decodeBytes(s: string, fmt: string): Uint8Array {
  switch (fmt.toLowerCase()) {
    case 'hex': return new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)))
    case 'base64': return Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
    case 'escape': return new TextEncoder().encode(s)
    default: return err('22023', `unrecognized encoding: "${fmt}"`)
  }
}

function hashName(alg: string): string {
  const a = alg.toLowerCase()
  if (!['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'].includes(a)) return err('22023', `cannot use "${alg}"`)
  return a
}

// ---------------------------------------------------------------- arrays

const arrType = (types: string[], i = 0) => (isArrayType(types[i]) ? types[i] : `${types[i] === 'unknown' ? 'text' : types[i]}[]`)

function eqValue(a: unknown, b: unknown, t: string): boolean {
  if (a === null || b === null) return a === b
  return compare(a, b, t) === 0
}

// ---------------------------------------------------------------- the table

const S = (sql: string) => sql
const numericOrInt = (types: string[]) => (types[0] === 'int' ? 'int' : 'numeric')
const roundHalfAway = (n: number, d = 0) => {
  const f = 10 ** d
  const x = Math.abs(n) * f
  const r = Math.round(Number(x.toPrecision(15)))
  return cleanNumber((Math.sign(n) * r) / f) || 0
}

const textFn = (fn: (s: string, ...rest: unknown[]) => unknown, sql?: (a: SqlArg[]) => string, ret = 'text'): Builtin => ({
  ret: fixed(ret), js: (a) => fn(str(a[0]), ...a.slice(1)), sql: sql ? (a) => sql(a) : undefined,
})

export const builtins: Record<string, Builtin> = {
  // ---- text
  length: textFn((s) => [...s].length, (a) => S(`length(${a[0].sql})`), 'int'),
  char_length: textFn((s) => [...s].length, (a) => S(`length(${a[0].sql})`), 'int'),
  character_length: textFn((s) => [...s].length, (a) => S(`length(${a[0].sql})`), 'int'),
  octet_length: textFn((s) => new TextEncoder().encode(s).length, undefined, 'int'),
  lower: textFn((s) => s.toLowerCase(), (a) => `lower(${a[0].sql})`),
  upper: textFn((s) => s.toUpperCase(), (a) => `upper(${a[0].sql})`),
  initcap: textFn((s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase())),
  btrim: { ret: fixed('text'), js: (a) => trimChars(str(a[0]), a[1] === undefined ? ' ' : str(a[1]), 'both'), sql: (a) => `trim(${a.map((x) => x.sql).join(', ')})` },
  trim: { ret: fixed('text'), js: (a) => trimChars(str(a[0]), a[1] === undefined ? ' ' : str(a[1]), 'both'), sql: (a) => `trim(${a.map((x) => x.sql).join(', ')})` },
  ltrim: { ret: fixed('text'), js: (a) => trimChars(str(a[0]), a[1] === undefined ? ' ' : str(a[1]), 'left'), sql: (a) => `ltrim(${a.map((x) => x.sql).join(', ')})` },
  rtrim: { ret: fixed('text'), js: (a) => trimChars(str(a[0]), a[1] === undefined ? ' ' : str(a[1]), 'right'), sql: (a) => `rtrim(${a.map((x) => x.sql).join(', ')})` },
  substring: {
    ret: fixed('text'),
    js: (a) => {
      const chars = [...str(a[0])]
      const from = num(a[1])
      if (a.length < 3) return chars.slice(Math.max(from - 1, 0)).join('')
      const len = num(a[2])
      if (len < 0) return err('22011', 'negative substring length not allowed')
      const start = from - 1
      return chars.slice(Math.max(start, 0), Math.max(start + len, 0)).join('')
    },
    sql: (a) => `substr(${a.map((x) => x.sql).join(', ')})`,
  },
  substr: {
    ret: fixed('text'),
    js: (a) => builtins.substring.js!(a, [], undefined as never),
    sql: (a) => `substr(${a.map((x) => x.sql).join(', ')})`,
  },
  strpos: { ret: fixed('int'), js: (a) => [...str(a[0])].join('').indexOf(str(a[1])) + 1, sql: (a) => `instr(${a[0].sql}, ${a[1].sql})` },
  replace: { ret: fixed('text'), js: (a) => str(a[0]).split(str(a[1])).join(str(a[2])), sql: (a) => `replace(${a[0].sql}, ${a[1].sql}, ${a[2].sql})` },
  left: {
    ret: fixed('text'),
    js: (a) => {
      const c = [...str(a[0])]
      const n = num(a[1])
      return (n >= 0 ? c.slice(0, n) : c.slice(0, Math.max(c.length + n, 0))).join('')
    },
    sql: (a) => `substr(${a[0].sql}, 1, ${a[1].sql})`,
  },
  right: {
    ret: fixed('text'),
    js: (a) => {
      const c = [...str(a[0])]
      const n = num(a[1])
      return (n >= 0 ? c.slice(Math.max(c.length - n, 0)) : c.slice(-n)).join('')
    },
    sql: (a) => `substr(${a[0].sql}, -(${a[1].sql}))`,
  },
  lpad: {
    ret: fixed('text'),
    js: (a) => pad(str(a[0]), num(a[1]), a[2] === undefined ? ' ' : str(a[2]), true),
    sql: (a) => {
      const fill = a[2]?.c ? String(a[2].c.v) : ' '
      if (fill.length !== 1 || !a[1].c) throw new Error('lpad on a column needs a constant one-character fill and width')
      const w = Number(a[1].c.v)
      return `substr(${q(fill.repeat(w))} || ${a[0].sql}, -${w}, ${w})`
    },
  },
  rpad: { ret: fixed('text'), js: (a) => pad(str(a[0]), num(a[1]), a[2] === undefined ? ' ' : str(a[2]), false) },
  repeat: { ret: fixed('text'), js: (a) => str(a[0]).repeat(Math.max(0, num(a[1]))) },
  reverse: textFn((s) => [...s].reverse().join('')),
  split_part: {
    ret: fixed('text'),
    js: (a) => {
      const parts = str(a[0]).split(str(a[1]))
      let n = num(a[2])
      if (n === 0) return err('22023', 'field position must not be zero')
      if (n < 0) n = parts.length + n + 1
      return str(a[1]) === '' ? (n === 1 ? str(a[0]) : '') : parts[n - 1] ?? ''
    },
    sql: (a) => {
      if (!a[2].c || Number(a[2].c.v) !== 1) throw new Error('split_part on a column supports field 1 only')
      return `(CASE WHEN instr(${a[0].sql}, ${a[1].sql}) > 0 THEN substr(${a[0].sql}, 1, instr(${a[0].sql}, ${a[1].sql}) - 1) ELSE ${a[0].sql} END)`
    },
  },
  concat: {
    ret: fixed('text'), strict: false,
    js: (a, t) => a.map((v, i) => (v === null || v === undefined ? '' : toText(v, t[i]))).join(''),
    sql: (a) => `(${a.map((x) => `coalesce(${textSql(x)}, '')`).join(' || ') || "''"})`,
  },
  concat_ws: {
    ret: fixed('text'), strict: false,
    js: (a, t) => (a[0] === null ? null : a.slice(1).filter((v) => v !== null && v !== undefined).map((v, i) => toText(v, t[i + 1])).join(str(a[0]))),
    sql: (a) => `(SELECT group_concat(v, ${a[0].sql}) FROM (${a.slice(1).map((x, i) => `SELECT ${i} AS k, ${textSql(x)} AS v`).join(' UNION ALL ')} ORDER BY k) WHERE v IS NOT NULL)`,
  },
  format: {
    ret: fixed('text'), strict: false,
    js: (a, t) => (a[0] === null ? null : pgFormat(str(a[0]), a.slice(1), t.slice(1))),
  },
  quote_ident: textFn((s) => quoteIdent(s)),
  quote_literal: textFn((s) => quoteLiteral(s)),
  quote_nullable: { ret: fixed('text'), strict: false, js: (a, t) => (a[0] === null ? 'NULL' : quoteLiteral(toText(a[0], t[0]))) },
  starts_with: { ret: fixed('bool'), js: (a) => str(a[0]).startsWith(str(a[1])), sql: (a) => `(substr(${a[0].sql}, 1, length(${a[1].sql})) = ${a[1].sql})` },
  translate: {
    ret: fixed('text'),
    js: (a) => {
      const from = [...str(a[1])]
      const to = [...str(a[2])]
      return [...str(a[0])].map((c) => {
        const i = from.indexOf(c)
        return i < 0 ? c : to[i] ?? ''
      }).join('')
    },
  },
  ascii: textFn((s) => s.codePointAt(0) ?? 0, undefined, 'int'),
  chr: { ret: fixed('text'), js: (a) => String.fromCodePoint(num(a[0])) },
  to_hex: { ret: fixed('text'), js: (a) => Math.trunc(num(a[0])).toString(16) },
  regexp_replace: {
    ret: fixed('text'),
    js: (a) => {
      const flags = a[3] === undefined ? '' : str(a[3])
      const re = pgRegex(str(a[1]), flags)
      const rep = str(a[2]).replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/\\&/g, '$$&')
      return str(a[0]).replace(re, rep)
    },
  },
  regexp_match: {
    ret: fixed('text[]'),
    js: (a) => {
      const m = pgRegex(str(a[1]), a[2] === undefined ? '' : str(a[2])).exec(str(a[0]))
      if (!m) return null
      return m.length > 1 ? m.slice(1).map((x) => x ?? null) : [m[0]]
    },
  },
  regexp_like: { ret: fixed('bool'), js: (a) => pgRegex(str(a[1]), a[2] === undefined ? '' : str(a[2])).test(str(a[0])) },
  md5: textFn((s) => createHash('md5').update(s).digest('hex')),
  sha256: { ret: fixed('bytea'), js: (a) => new Uint8Array(createHash('sha256').update(bytes(a[0])).digest()) },
  digest: { ret: fixed('bytea'), js: (a) => new Uint8Array(createHash(hashName(str(a[1]))).update(bytes(a[0])).digest()) },
  hmac: { ret: fixed('bytea'), js: (a) => new Uint8Array(createHmac(hashName(str(a[2])), bytes(a[1])).update(bytes(a[0])).digest()) },
  gen_random_bytes: { ret: fixed('bytea'), volatile: true, js: (a) => new Uint8Array(randomBytes(num(a[0]))) },
  encode: { ret: fixed('text'), js: (a) => encodeBytes(bytes(a[0]), str(a[1])) },
  decode: { ret: fixed('bytea'), js: (a) => decodeBytes(str(a[0]), str(a[1])) },
  convert_to: { ret: fixed('bytea'), js: (a) => bytes(str(a[0])) },
  convert_from: { ret: fixed('text'), js: (a) => new TextDecoder().decode(bytes(a[0])) },
  string_to_array: {
    ret: fixed('text[]'), strict: false,
    js: (a) => {
      if (a[0] === null) return null
      const s = str(a[0])
      if (s === '') return []
      const parts = a[1] === null ? [...s] : s.split(str(a[1]))
      return a[2] === undefined || a[2] === null ? parts : parts.map((p) => (p === str(a[2]) ? null : p))
    },
  },
  array_to_string: {
    ret: fixed('text'), strict: false,
    js: (a, t) => {
      if (a[0] === null || a[1] === null) return null
      const et = elemType(t[0] ?? 'text[]')
      const flat = (a[0] as unknown[]).flat(Infinity)
      return flat.filter((v) => v !== null || (a[2] !== undefined && a[2] !== null)).map((v) => (v === null ? str(a[2]) : toText(v, et))).join(str(a[1]))
    },
    sql: (a) => `(SELECT group_concat(value, ${a[1].sql}) FROM json_each(${a[0].sql}) WHERE value IS NOT NULL)`,
  },

  // ---- conditionals (evaluated lazily by the evaluator; these are for SQL)
  coalesce: { ret: same, strict: false, sql: (a) => `coalesce(${a.map((x) => x.sql).join(', ')}${a.length === 1 ? ', NULL' : ''})` },
  nullif: { ret: (t) => t[0], strict: false, sql: (a) => `nullif(${a[0].sql}, ${a[1].sql})` },
  greatest: { ret: same, strict: false, sql: (a) => `(SELECT max(v) FROM (${a.map((x, i) => `SELECT ${x.sql}${i ? '' : ' AS v'}`).join(' UNION ALL ')}))` },
  least: { ret: same, strict: false, sql: (a) => `(SELECT min(v) FROM (${a.map((x, i) => `SELECT ${x.sql}${i ? '' : ' AS v'}`).join(' UNION ALL ')}))` },
  num_nonnulls: { ret: fixed('int'), strict: false, js: (a) => a.filter((v) => v !== null).length, sql: (a) => `(${a.map((x) => `(${x.sql} IS NOT NULL)`).join(' + ')})` },
  num_nulls: { ret: fixed('int'), strict: false, js: (a) => a.filter((v) => v === null).length, sql: (a) => `(${a.map((x) => `(${x.sql} IS NULL)`).join(' + ')})` },

  // ---- math
  abs: { ret: numericOrInt, js: (a) => Math.abs(num(a[0])), sql: (a) => `abs(${a[0].sql})` },
  round: {
    ret: (t) => (t[0] === 'int' && t.length === 1 ? 'int' : 'numeric'),
    js: (a) => roundHalfAway(num(a[0]), a[1] === undefined ? 0 : num(a[1])),
    sql: (a) => `round(${a[0].sql}${a[1] ? `, ${a[1].sql}` : ''})`,
  },
  trunc: {
    ret: (t) => (t[0] === 'int' ? 'int' : 'numeric'),
    js: (a) => {
      const f = 10 ** (a[1] === undefined ? 0 : num(a[1]))
      return cleanNumber(Math.trunc(num(a[0]) * f) / f)
    },
    sql: (a) => (a[1] ? `(CAST((${a[0].sql}) * power(10, ${a[1].sql}) AS INTEGER) / power(10.0, ${a[1].sql}))` : `CAST(${a[0].sql} AS INTEGER)`),
  },
  floor: { ret: numericOrInt, js: (a) => Math.floor(num(a[0])), sql: (a) => `(CAST(${a[0].sql} AS INTEGER) - ((${a[0].sql}) < CAST(${a[0].sql} AS INTEGER)))` },
  ceil: { ret: numericOrInt, js: (a) => Math.ceil(num(a[0])), sql: (a) => `(CAST(${a[0].sql} AS INTEGER) + ((${a[0].sql}) > CAST(${a[0].sql} AS INTEGER)))` },
  ceiling: { ret: numericOrInt, js: (a) => Math.ceil(num(a[0])), sql: (a) => `(CAST(${a[0].sql} AS INTEGER) + ((${a[0].sql}) > CAST(${a[0].sql} AS INTEGER)))` },
  mod: { ret: numericOrInt, js: (a) => (num(a[1]) === 0 ? err('22012', 'division by zero') : num(a[0]) % num(a[1])), sql: (a) => `(${a[0].sql} % ${a[1].sql})` },
  div: { ret: fixed('numeric'), js: (a) => Math.trunc(num(a[0]) / num(a[1])), sql: (a) => `CAST((${a[0].sql}) / (${a[1].sql}) AS INTEGER)` },
  power: { ret: fixed('numeric'), js: (a) => cleanNumber(num(a[0]) ** num(a[1])) },
  pow: { ret: fixed('numeric'), js: (a) => cleanNumber(num(a[0]) ** num(a[1])) },
  sqrt: { ret: fixed('numeric'), js: (a) => (num(a[0]) < 0 ? err('2201F', 'cannot take square root of a negative number') : cleanNumber(Math.sqrt(num(a[0])))) },
  ln: { ret: fixed('numeric'), js: (a) => cleanNumber(Math.log(num(a[0]))) },
  log: { ret: fixed('numeric'), js: (a) => cleanNumber(a.length === 2 ? Math.log(num(a[1])) / Math.log(num(a[0])) : Math.log10(num(a[0]))) },
  log10: { ret: fixed('numeric'), js: (a) => cleanNumber(Math.log10(num(a[0]))) },
  exp: { ret: fixed('numeric'), js: (a) => cleanNumber(Math.exp(num(a[0]))) },
  sign: { ret: numericOrInt, js: (a) => Math.sign(num(a[0])), sql: (a) => `((${a[0].sql}) > 0) - ((${a[0].sql}) < 0)` },
  random: { ret: fixed('numeric'), volatile: true, js: () => Math.random(), sql: () => '((random() & 9007199254740991) / 9007199254740992.0)' },
  pi: { ret: fixed('numeric'), js: () => Math.PI },
  width_bucket: {
    ret: fixed('int'),
    js: (a) => {
      const [x, lo, hi, n] = a.map(num)
      if (x < lo) return 0
      if (x >= hi) return n + 1
      return Math.floor(((x - lo) / (hi - lo)) * n) + 1
    },
  },

  // ---- date and time
  now: { ret: fixed('timestamptz'), strict: false, js: (_a, _t, c) => c.engine.ctx.now, sql: (_a, h) => h.bind(h.engine.ctx.now, 'timestamptz') },
  current_timestamp: { ret: fixed('timestamptz'), strict: false, js: (_a, _t, c) => c.engine.ctx.now },
  transaction_timestamp: { ret: fixed('timestamptz'), strict: false, js: (_a, _t, c) => c.engine.ctx.now },
  statement_timestamp: { ret: fixed('timestamptz'), strict: false, js: (_a, _t, c) => c.engine.ctx.now },
  clock_timestamp: { ret: fixed('timestamptz'), strict: false, volatile: true, js: () => new Date().toISOString() },
  current_date: { ret: fixed('date'), strict: false, js: (_a, _t, c) => c.engine.ctx.now.slice(0, 10) },
  localtimestamp: { ret: fixed('timestamp'), strict: false, js: (_a, _t, c) => c.engine.ctx.now.slice(0, 23) },
  current_time: { ret: fixed('time'), strict: false, js: (_a, _t, c) => c.engine.ctx.now.slice(11, 19) },
  localtime: { ret: fixed('time'), strict: false, js: (_a, _t, c) => c.engine.ctx.now.slice(11, 19) },
  timeofday: { ret: fixed('text'), strict: false, volatile: true, js: () => new Date().toString() },
  extract: {
    ret: fixed('numeric'),
    js: (a, t) => extract(str(a[0]), a[1], t[1]),
    sql: (a) => {
      const field = String(a[0].c?.v ?? '').toLowerCase()
      const x = a[1].sql
      const fmt: Record<string, string> = { year: '%Y', month: '%m', day: '%d', hour: '%H', minute: '%M', dow: '%w', doy: '%j' }
      if (a[1].t === 'interval') {
        const iv = (i: number) => `(${x} ->> ${i})`
        if (field === 'epoch') return `(${iv(0)} * 2592000 + ${iv(1)} * 86400 + ${iv(2)})`
        if (field === 'day' || field === 'days') return iv(1)
        if (field === 'hour') return `CAST(${iv(2)} / 3600 AS INTEGER)`
        if (field === 'minute') return `CAST((${iv(2)} % 3600) / 60 AS INTEGER)`
        if (field === 'month') return `(${iv(0)} % 12)`
        if (field === 'year') return `CAST(${iv(0)} / 12 AS INTEGER)`
        throw new Error(`extract(${field} from interval) on a column`)
      }
      if (field === 'epoch') return `(julianday(${x}) - 2440587.5) * 86400.0`
      if (field === 'isodow') return `(CASE CAST(strftime('%w', ${x}) AS INTEGER) WHEN 0 THEN 7 ELSE CAST(strftime('%w', ${x}) AS INTEGER) END)`
      if (field === 'second') return `CAST(strftime('%f', ${x}) AS REAL)`
      if (field === 'quarter') return `((CAST(strftime('%m', ${x}) AS INTEGER) + 2) / 3)`
      if (field === 'week') return `CAST(strftime('%V', ${x}) AS INTEGER)`
      if (fmt[field]) return `CAST(strftime('${fmt[field]}', ${x}) AS INTEGER)`
      throw new Error(`extract(${field}) on a column`)
    },
  },
  date_part: { ret: fixed('numeric'), js: (a, t) => extract(str(a[0]), a[1], t[1]) },
  date_trunc: {
    ret: (t) => (t[1] === 'timestamp' ? 'timestamp' : t[1] === 'interval' ? 'interval' : 'timestamptz'),
    js: (a, t) => dateTrunc(str(a[0]), a[1], t[1], a[2] === undefined ? undefined : str(a[2])),
    sql: (a, h) => {
      const unit = String(a[0].c?.v ?? '').toLowerCase()
      const local = a[1].t === 'timestamp'
      const z = local ? '' : 'Z'
      const x = a[1].t === 'date' ? `${a[1].sql}` : a[1].sql
      let shift = ''
      let back = ''
      if (a[2]) {
        if (!a[2].c) throw new Error('date_trunc with a zone from a column')
        const mins = zoneOffset(String(a[2].c.v), Date.parse(h.engine.ctx.now))
        shift = `, '${mins >= 0 ? '+' : ''}${mins} minutes'`
        back = `, '${-mins >= 0 ? '+' : ''}${-mins} minutes'`
      }
      const formats: Record<string, string> = {
        day: `%Y-%m-%dT00:00:00.000${z}`, month: `%Y-%m-01T00:00:00.000${z}`, year: `%Y-01-01T00:00:00.000${z}`,
        hour: `%Y-%m-%dT%H:00:00.000${z}`, minute: `%Y-%m-%dT%H:%M:00.000${z}`,
      }
      if (unit === 'week') {
        const inner = `strftime('%Y-%m-%d', ${x}${shift}, 'weekday 1', '-7 days')`
        return back ? `strftime('%Y-%m-%dT%H:%M:%f${z}', ${inner}${back})` : `(${inner} || 'T00:00:00.000${z}')`
      }
      if (!formats[unit]) throw new Error(`date_trunc('${unit}') on a column`)
      const inner = `strftime('${formats[unit]}', ${x}${shift})`
      return back ? `strftime('%Y-%m-%dT%H:%M:%f${z}', ${inner}${back})` : inner
    },
  },
  age: {
    ret: fixed('interval'),
    js: (a, t, c) => (a.length === 1 ? age(c.engine.ctx.now.slice(0, 10), a[0], 'date', t[0]) : age(a[0], a[1], t[0], t[1])),
  },
  make_interval: {
    ret: fixed('interval'), strict: false,
    js: (a, _t, c) => {
      const order = ['years', 'months', 'weeks', 'days', 'hours', 'mins', 'secs']
      const vals: Record<string, number> = {}
      a.forEach((v, i) => {
        const name = c.names?.[i] ?? order[i]
        vals[name] = v === null ? 0 : num(v)
      })
      return new Interval((vals.years ?? 0) * 12 + (vals.months ?? 0), (vals.weeks ?? 0) * 7 + (vals.days ?? 0),
        (vals.hours ?? 0) * 3_600_000 + (vals.mins ?? 0) * 60_000 + (vals.secs ?? 0) * 1000)
    },
  },
  make_date: { ret: fixed('date'), js: (a) => `${String(num(a[0])).padStart(4, '0')}-${String(num(a[1])).padStart(2, '0')}-${String(num(a[2])).padStart(2, '0')}` },
  make_timestamptz: {
    ret: fixed('timestamptz'),
    js: (a) => {
      const ms = Date.UTC(num(a[0]), num(a[1]) - 1, num(a[2]), num(a[3]), num(a[4]), 0, num(a[5]) * 1000)
      if (a[6] !== undefined) return localToTz(isoLocal(new Date(ms)), str(a[6]))
      return isoZ(new Date(ms))
    },
  },
  to_timestamp: {
    ret: fixed('timestamptz'),
    js: (a) => {
      if (a.length === 1) return isoZ(new Date(num(a[0]) * 1000))
      return cast(str(a[0]), 'text', 'timestamptz')
    },
  },
  to_date: { ret: fixed('date'), js: (a) => cast(str(a[0]), 'text', 'date') },
  to_char: {
    ret: fixed('text'),
    js: (a, t) => {
      if (t[0] === 'int' || t[0] === 'numeric') return toCharNumber(num(a[0]), str(a[1]))
      if (a[0] instanceof Interval) return a[0].toString()
      return toCharDate(a[0], t[0], str(a[1]))
    },
    sql: (a) => {
      const fmt = a[1].c ? String(a[1].c.v) : null
      const map: Record<string, string> = { 'YYYY-MM-DD': '%Y-%m-%d', 'YYYY-MM': '%Y-%m', 'HH24:MI': '%H:%M', 'YYYY-MM-DD HH24:MI': '%Y-%m-%d %H:%M', DD: '%d', MM: '%m', YYYY: '%Y' }
      if (fmt && map[fmt]) return `strftime('${map[fmt]}', ${a[0].sql})`
      throw new Error(`to_char('${fmt}') on a column`)
    },
  },
  timezone: {
    ret: (t) => (t[1] === 'timestamp' ? 'timestamptz' : 'timestamp'),
    js: (a, t) => (t[1] === 'timestamp' ? localToTz(str(a[1]), str(a[0])) : tzToLocal(cast(a[1], t[1], 'timestamptz') as string, str(a[0]))),
  },
  isfinite: { ret: fixed('bool'), js: () => true },
  justify_interval: { ret: fixed('interval'), js: (a) => a[0] },
  justify_hours: { ret: fixed('interval'), js: (a) => a[0] },
  justify_days: { ret: fixed('interval'), js: (a) => a[0] },

  // ---- json
  jsonb_build_object: {
    ret: fixed('jsonb'), strict: false,
    js: (a, t) => {
      if (a.length % 2) return err('22023', 'argument list must have even number of elements')
      const o: Record<string, unknown> = {}
      for (let i = 0; i < a.length; i += 2) {
        if (a[i] === null) return err('22004', 'argument 1: key must not be null')
        const v = toJson(a[i + 1], t[i + 1])
        o[toText(a[i], t[i])] = v === JNULL ? null : v
      }
      return o
    },
    sql: (a, h) => `json_object(${a.map((x, i) => (i % 2 ? h.json(x) : textSql(x))).join(', ')})`,
  },
  jsonb_build_array: {
    ret: fixed('jsonb'), strict: false,
    js: (a, t) => a.map((v, i) => {
      const j = toJson(v, t[i])
      return j === JNULL ? null : j
    }),
    sql: (a, h) => `json_array(${a.map((x) => h.json(x)).join(', ')})`,
  },
  to_jsonb: { ret: fixed('jsonb'), strict: false, js: (a, t) => (a[0] === null ? null : toJson(a[0], t[0])), sql: (a, h) => h.jsonValue(a[0]) },
  to_json: { ret: fixed('jsonb'), strict: false, js: (a, t) => (a[0] === null ? null : toJson(a[0], t[0])), sql: (a, h) => h.jsonValue(a[0]) },
  row_to_json: { ret: fixed('jsonb'), js: (a, t) => toJson(a[0], t[0]), sql: (a, h) => h.jsonValue(a[0]) },
  jsonb_typeof: {
    ret: fixed('text'),
    js: (a) => jsonType(a[0]),
    sql: (a) => `(CASE json_type(${a[0].sql}) WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean' WHEN 'text' THEN 'string' ELSE json_type(${a[0].sql}) END)`,
  },
  jsonb_array_length: {
    ret: fixed('int'),
    js: (a) => (Array.isArray(a[0]) ? a[0].length : err('22023', 'cannot get array length of a non-array')),
    sql: (a) => `json_array_length(${a[0].sql})`,
  },
  jsonb_extract_path: { ret: fixed('jsonb'), js: (a) => jsonPath(a[0], a.slice(1).flat()) },
  jsonb_extract_path_text: {
    ret: fixed('text'),
    js: (a) => {
      const v = jsonPath(a[0], a.slice(1).flat())
      return v === null || v === JNULL ? null : typeof v === 'string' ? v : jsonText(v)
    },
  },
  jsonb_set: {
    ret: fixed('jsonb'),
    js: (a) => jsonSet(a[0], a[1], a[2], a[3] === undefined ? true : Boolean(a[3])),
    sql: (a, h) => {
      if (!a[1].c) throw new Error('jsonb_set with a path from a column')
      const keys = jsonPathKeys(a[1].c.v)
      const path = `$${keys.map((k) => (/^\d+$/.test(k) ? `[${k}]` : `."${k.replaceAll('"', '\\"')}"`)).join('')}`
      return `json_set(${a[0].sql}, ${q(path)}, ${h.json({ ...a[2], t: 'jsonb' })})`
    },
  },
  jsonb_insert: { ret: fixed('jsonb'), js: (a) => jsonSet(a[0], a[1], a[2], true, true, Boolean(a[3])) },
  jsonb_strip_nulls: { ret: fixed('jsonb'), js: (a) => stripNulls(a[0]) },
  jsonb_pretty: { ret: fixed('text'), js: (a) => JSON.stringify(a[0], null, 4) },
  jsonb_exists: { ret: fixed('bool'), js: (a) => jsonHasKey(a[0], str(a[1])) },
  jsonb_object_keys_array: { ret: fixed('text[]'), js: (a) => jsonKeyOrder(Object.keys(a[0] as object)) },

  // ---- arrays
  array_length: {
    ret: fixed('int'),
    js: (a) => (num(a[1]) !== 1 || !(a[0] as unknown[]).length ? null : (a[0] as unknown[]).length),
    sql: (a) => `nullif(json_array_length(${a[0].sql}), 0)`,
  },
  cardinality: { ret: fixed('int'), js: (a) => (a[0] as unknown[]).flat(Infinity).length, sql: (a) => `json_array_length(${a[0].sql})` },
  array_upper: { ret: fixed('int'), js: (a) => ((a[0] as unknown[]).length ? (a[0] as unknown[]).length : null) },
  array_lower: { ret: fixed('int'), js: (a) => ((a[0] as unknown[]).length ? 1 : null) },
  array_append: {
    ret: (t) => arrType(t), strict: false,
    js: (a) => [...((a[0] as unknown[] | null) ?? []), a[1]],
    sql: (a, h) => `json_insert(coalesce(${a[0].sql}, '[]'), '$[#]', ${h.json(a[1])})`,
  },
  array_prepend: { ret: (t) => arrType(t, 1), strict: false, js: (a) => [a[0], ...((a[1] as unknown[] | null) ?? [])] },
  array_cat: {
    ret: (t) => arrType(t), strict: false,
    js: (a) => (a[0] === null && a[1] === null ? null : [...((a[0] as unknown[] | null) ?? []), ...((a[1] as unknown[] | null) ?? [])]),
  },
  array_remove: {
    ret: (t) => arrType(t), strict: false,
    js: (a, t) => (a[0] === null ? null : (a[0] as unknown[]).filter((v) => !eqValue(v, a[1], elemType(arrType(t))))),
  },
  array_position: {
    ret: fixed('int'), strict: false,
    js: (a, t) => {
      if (a[0] === null) return null
      const i = (a[0] as unknown[]).findIndex((v) => eqValue(v, a[1], elemType(arrType(t))))
      return i < 0 ? null : i + 1
    },
  },

  // ---- identifiers, sequences, session
  gen_random_uuid: { ret: fixed('uuid'), strict: false, volatile: true, js: () => randomUUID(), sql: (_a, h) => uuidSql(h) },
  uuid_generate_v4: { ret: fixed('uuid'), strict: false, volatile: true, js: () => randomUUID(), sql: (_a, h) => uuidSql(h) },
  pg_advisory_xact_lock: { ret: fixed('void'), strict: false, js: () => null },
  pg_advisory_lock: { ret: fixed('void'), strict: false, js: () => null },
  pg_advisory_unlock: { ret: fixed('bool'), strict: false, js: () => true },
  pg_try_advisory_xact_lock: { ret: fixed('bool'), strict: false, js: () => true },
  pg_try_advisory_lock: { ret: fixed('bool'), strict: false, js: () => true },
  pg_sleep: { ret: fixed('void'), strict: false, js: () => null },
  hashtext: { ret: fixed('int'), js: (a) => hash32(str(a[0])) },
  hashtextextended: { ret: fixed('int'), js: (a) => hash32(str(a[0])) },
  txid_current: { ret: fixed('int'), strict: false, js: (_a, _t, c) => txid(c.engine) },
  pg_current_xact_id: { ret: fixed('int'), strict: false, js: (_a, _t, c) => txid(c.engine) },
  current_user: { ret: fixed('text'), strict: false, js: (_a, _t, c) => c.engine.roleName() },
  current_role: { ret: fixed('text'), strict: false, js: (_a, _t, c) => c.engine.roleName() },
  session_user: { ret: fixed('text'), strict: false, js: (_a, _t, c) => (c.engine.ctx.identity.role === 'service_role' && !c.engine.ctx.hasClaims() ? 'postgres' : 'authenticator') },
  user: { ret: fixed('text'), strict: false, js: (_a, _t, c) => c.engine.roleName() },
  current_schema: { ret: fixed('text'), strict: false, js: () => 'public' },
  inet_client_addr: { ret: fixed('text'), strict: false, js: (_a, _t, c) => c.engine.ctx.identity.ip ?? null },
  version: { ret: fixed('text'), strict: false, js: () => 'PostgreSQL 15 compatible (Cloudflare SQLite)' },
  pg_typeof: { ret: fixed('text'), strict: false, js: (_a, t) => t[0] },
  enum_range: { ret: (t) => `${t[0]}[]`, strict: false, js: (_a, t) => [...(schema.enums[t[0]] ?? [])] },
  to_regclass: { ret: fixed('text'), js: (a) => {
    const name = String(a[0]).replace(/^public\./, '').replace(/^"|"$/g, '')
    return Object.hasOwn(schema.tables, name) || Object.hasOwn(schema.views, name) ? name : null
  } },
  current_database: { ret: fixed('text'), strict: false, js: () => 'postgres' },
  has_function_privilege: {
    ret: fixed('bool'),
    js: (a, _t, c) => {
      const [role, fnText] = a.length === 3 ? [String(a[0]), String(a[1])] : [c.engine.roleName(), String(a[0])]
      const name = fnText.replace(/^public\./, '').replace(/\(.*$/, '').trim()
      const defs = functionGrants(name)
      if (!defs) return err('42883', `function "${fnText}" does not exist`)
      if (role === 'postgres' || role === 'service_role' || role === 'app_owner') return true
      return defs.includes(role)
    },
  },
  has_table_privilege: {
    ret: fixed('bool'),
    js: (a) => {
      const [role, tableText, priv] = a.map((x) => String(x))
      const name = tableText.replace(/^public\./, '')
      const g = (schema.tables[name] ?? schema.views[name])?.grants as Record<string, string[]> | undefined
      if (role === 'postgres' || role === 'service_role') return true
      return Boolean(g?.[role]?.some((p) => priv.toLowerCase().includes(p)))
    },
  },
}

function uuidSql(h: SqlHelp): string {
  void h
  return "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))"
}

const txids = new WeakMap<object, number>()
function txid(engine: Engine): number {
  let n = txids.get(engine.ctx)
  if (n === undefined) {
    n = Math.floor(Date.parse(engine.ctx.now) / 1000)
    txids.set(engine.ctx, n)
  }
  return n
}

function hash32(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

function trimChars(s: string, chars: string, side: 'both' | 'left' | 'right'): string {
  const set = new Set([...chars])
  const c = [...s]
  let i = 0
  let j = c.length
  if (side !== 'right') while (i < j && set.has(c[i])) i++
  if (side !== 'left') while (j > i && set.has(c[j - 1])) j--
  return c.slice(i, j).join('')
}

function pad(s: string, n: number, fill: string, left: boolean): string {
  const c = [...s]
  if (c.length >= n) return c.slice(0, n).join('')
  if (!fill) return s
  const need = n - c.length
  const f = [...fill]
  let padding = ''
  for (let i = 0; i < need; i++) padding += f[i % f.length]
  return left ? padding + s : s + padding
}

/** SQL for an argument used as text (booleans as true/false). */
export function textSql(a: SqlArg): string {
  if (a.t === 'bool') return `(CASE WHEN ${a.sql} THEN 'true' WHEN NOT ${a.sql} THEN 'false' END)`
  return a.sql
}

// ---------------------------------------------------------------- aggregates and window functions

export const aggregates = new Set(['count', 'sum', 'avg', 'min', 'max', 'bool_or', 'bool_and', 'every', 'string_agg', 'array_agg', 'jsonb_agg',
  'json_agg', 'jsonb_object_agg', 'json_object_agg', 'mode', 'percentile_cont', 'percentile_disc', 'stddev', 'variance', 'group_concat'])

export const windowFunctions = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value'])

/** Result type of an aggregate. */
export function aggregateType(name: string, types: string[]): string {
  switch (name) {
    case 'count': return 'int'
    case 'sum': return types[0] === 'int' ? 'int' : types[0] === 'interval' ? 'interval' : 'numeric'
    case 'avg': case 'stddev': case 'variance': case 'percentile_cont': return 'numeric'
    case 'min': case 'max': case 'mode': case 'percentile_disc': return types[0] ?? 'unknown'
    case 'bool_or': case 'bool_and': case 'every': return 'bool'
    case 'string_agg': case 'group_concat': return 'text'
    case 'array_agg': return isArrayType(types[0] ?? '') ? types[0] : `${types[0] === 'unknown' ? 'text' : types[0]}[]`
    default: return 'jsonb'
  }
}

export function windowType(name: string, types: string[]): string {
  switch (name) {
    case 'row_number': case 'rank': case 'dense_rank': case 'ntile': return 'int'
    case 'percent_rank': case 'cume_dist': return 'numeric'
    default: return types[0] ?? 'unknown'
  }
}

export { addInterval, isJNull, parseInterval, PgRow }

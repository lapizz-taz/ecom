// Postgres values in JavaScript, with Postgres' rules for input, output, casts and
// comparison. Representation by type:
//
//   int, numeric        number (numeric results are cleaned of binary float noise)
//   text, uuid, enums   string (uuids lower-case)
//   bool                boolean
//   timestamptz         '2026-10-12T08:30:00.000Z'      timestamp  '2026-10-12T08:30:00.000'
//   date                '2026-10-12'                     time       '08:30:00'
//   interval            Interval
//   jsonb               the parsed JSON (a top-level JSON null is JNULL)
//   arrays              JS arrays
//   rows                PgRow (a table's row type, or an anonymous record)
//   NULL                null
import { DbError } from '../errors.ts'
import { schema } from '../meta.ts'
import { FLOAT, type Typed } from './runtime.ts'
import { elemType, isArrayType } from './types.ts'

export class Interval {
  constructor(readonly months: number, readonly days: number, readonly ms: number) {}

  negate(): Interval {
    return new Interval(-this.months, -this.days, -this.ms)
  }

  /** Total seconds, as extract(epoch from …) (30-day months, 365.25-day years). */
  epoch(): number {
    const years = Math.trunc(this.months / 12)
    const months = this.months % 12
    return years * 365.25 * 86400 + months * 30 * 86400 + this.days * 86400 + this.ms / 1000
  }

  toString(): string {
    const parts: string[] = []
    const y = Math.trunc(this.months / 12)
    const m = this.months % 12
    if (y) parts.push(`${y} year${Math.abs(y) === 1 ? '' : 's'}`)
    if (m) parts.push(`${m} mon${Math.abs(m) === 1 ? '' : 's'}`)
    if (this.days) parts.push(`${this.days} day${Math.abs(this.days) === 1 ? '' : 's'}`)
    if (this.ms || !parts.length) {
      const neg = this.ms < 0
      let rest = Math.abs(this.ms)
      const h = Math.floor(rest / 3_600_000)
      rest -= h * 3_600_000
      const mi = Math.floor(rest / 60_000)
      rest -= mi * 60_000
      const s = rest / 1000
      const ss = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(6).replace(/0+$/, '').padStart(9, '0')
      parts.push(`${neg ? '-' : ''}${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${ss}`)
    }
    return parts.join(' ')
  }
}

/** A JSON null (as opposed to SQL NULL) at the top level of a jsonb value. */
export const JNULL = Object.freeze({ toJSON: () => null, jnull: true as const })
export const isJNull = (v: unknown): boolean => v === JNULL

export class PgRow {
  constructor(
    readonly values: Record<string, unknown>,
    readonly types: Record<string, string>,
    /** Display scales of numeric fields (see Typed.s). */
    readonly scales: Record<string, number | undefined> = {},
  ) {}

  get(name: string): unknown {
    return Object.hasOwn(this.values, name) ? this.values[name] : undefined
  }

  /** The row as a plain object (API output). */
  plain(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(this.values)) out[k] = plainValue(v)
    return out
  }
}

/** A value as JSON for the API (rows to objects, JNULL to null, intervals to text). */
export function plainValue(v: unknown): unknown {
  if (v instanceof PgRow) return v.plain()
  if (v === JNULL) return null
  if (v instanceof Interval) return v.toString()
  if (Array.isArray(v)) return v.map(plainValue)
  return v
}

export function err(code: string, message: string): never {
  throw new DbError(code, message)
}

const invalid = (type: string, v: unknown): never => err('22P02', `invalid input syntax for type ${type}: "${String(v).slice(0, 100)}"`)

/** Removes binary floating point noise (0.1 + 0.2 → 0.3) from numeric results. */
export function cleanNumber(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n
  return Number(n.toPrecision(15))
}

const UUID_RE = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i

export const isEnum = (t: string): boolean => Object.hasOwn(schema.enums, t)
export const isTableType = (t: string): boolean => Object.hasOwn(schema.tables, t) || Object.hasOwn(schema.views, t)
export const isTextual = (t: string): boolean => t === 'text' || t === 'uuid' || t === 'unknown' || isEnum(t)

// ---------------------------------------------------------------- dates

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/** Date (UTC fields) → '…T…Z' with milliseconds. */
export const isoZ = (d: Date): string => d.toISOString()
/** Date (UTC fields read as wall time) → '…T…' without zone. */
export const isoLocal = (d: Date): string => d.toISOString().slice(0, 23)

const TS_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|UTC|[+-]\d{1,2}(?::?\d{2})?)?$/i

/** Parses date/time text; returns epoch ms and whether a zone was given. */
function parseTimestamp(text: string, type: string): { ms: number; zoned: boolean } {
  const s = text.trim()
  const lower = s.toLowerCase()
  if (lower === 'now') return { ms: Date.now(), zoned: true }
  if (lower === 'today') {
    const d = new Date()
    return { ms: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), zoned: false }
  }
  if (lower === 'infinity' || lower === '-infinity') return err('22008', 'infinite timestamps are not supported')
  const m = TS_RE.exec(s)
  if (!m) return invalid(type, text)
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', zone] = m
  const ms = frac ? Math.round(Number(`0${frac}`) * 1000) : 0
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms)
  const check = new Date(local)
  if (Number.isNaN(local) || check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(mo) - 1 || Number(h) > 24 || Number(mi) > 59 || Number(sec) > 60) {
    return err('22008', `date/time field value out of range: "${text}"`)
  }
  if (!zone) return { ms: local, zoned: false }
  if (/^(z|utc)$/i.test(zone)) return { ms: local, zoned: true }
  const z = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(zone)!
  const offset = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0))
  return { ms: local - offset * 60_000, zoned: true }
}

export function toTimestamptz(v: unknown): string {
  if (v instanceof Date) return isoZ(v)
  if (typeof v === 'number') return isoZ(new Date(v))
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return s
  return isoZ(new Date(parseTimestamp(s, 'timestamp with time zone').ms))
}

export function toTimestampLocal(v: unknown): string {
  if (v instanceof Date) return isoLocal(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(s)) return s
  // a zone in the text is ignored for timestamp without time zone, as in Postgres
  const m = TS_RE.exec(s.trim())
  if (!m) return invalid('timestamp without time zone', v)
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = ''] = m
  const ms = frac ? Math.round(Number(`0${frac}`) * 1000) : 0
  return isoLocal(new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms)))
}

export function toDate(v: unknown): string {
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return err('22008', `date/time field value out of range: "${s}"`)
    return s
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/Z$|[+-]\d{2}(:?\d{2})?$/.test(s)) return s.slice(0, 10)
  return new Date(parseTimestamp(s, 'date').ms).toISOString().slice(0, 10)
}

export function toTime(v: unknown): string {
  const s = String(v).trim()
  const m = /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?/.exec(s)
  if (!m) return invalid('time without time zone', v)
  return `${pad(Number(m[1]))}:${m[2]}:${m[3] ?? '00'}${m[4] && Number(m[4]) ? m[4] : ''}`
}

const tzCache = new Map<string, Intl.DateTimeFormat>()

/** The zone's offset from UTC in minutes at an instant (Asia/Dhaka → 360). */
export function zoneOffset(zone: string, at: number): number {
  const z = zone.trim()
  if (/^(utc|z|gmt)$/i.test(z)) return 0
  const fixed = /^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(z)
  // POSIX-style '+06' means 6 hours WEST in Postgres; ISO-style '+06:00' strings are not zone names here.
  if (fixed) return (fixed[1] === '-' ? 1 : -1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0))
  let f = tzCache.get(z)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return err('22023', `time zone "${zone}" not recognized`)
    }
    tzCache.set(z, f)
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000)
}

/** timestamptz AT TIME ZONE z → local wall time (timestamp). */
export function tzToLocal(ts: string, zone: string): string {
  const ms = Date.parse(ts)
  return isoLocal(new Date(ms + zoneOffset(zone, ms) * 60_000))
}

/** timestamp AT TIME ZONE z → the instant (timestamptz). */
export function localToTz(local: string, zone: string): string {
  const wall = Date.parse(`${local.slice(0, 23)}Z`)
  let guess = wall - zoneOffset(zone, wall) * 60_000
  guess = wall - zoneOffset(zone, guess) * 60_000
  return isoZ(new Date(guess))
}

// ---------------------------------------------------------------- intervals

const UNIT_MS: Record<string, number> = { microsecond: 0.001, millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000 }

function unitOf(word: string): string | null {
  const w = word.toLowerCase().replace(/s$/, '')
  const map: Record<string, string> = {
    year: 'year', yr: 'year', y: 'year', mon: 'month', month: 'month', week: 'week', w: 'week', day: 'day', d: 'day', hour: 'hour', hr: 'hour', h: 'hour',
    minute: 'minute', min: 'minute', m: 'minute', second: 'second', sec: 'second', s: 'second', millisecond: 'millisecond', m_: 'millisecond',
    msec: 'millisecond', microsecond: 'microsecond', usec: 'microsecond', decade: 'decade', century: 'century',
  }
  return map[w] ?? null
}

export function parseInterval(text: string): Interval {
  let s = text.trim().toLowerCase()
  let months = 0
  let days = 0
  let ms = 0
  let sign = 1
  if (s.endsWith(' ago')) {
    sign = -1
    s = s.slice(0, -4)
  }
  if (s.startsWith('@')) s = s.slice(1)
  // ISO 8601 durations: P1DT2H
  const iso = /^p(?:(\d+)y)?(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?)?$/.exec(s)
  if (iso) {
    const [, y, mo, w, d, h, mi, sec] = iso
    return new Interval(sign * (Number(y ?? 0) * 12 + Number(mo ?? 0)), sign * (Number(w ?? 0) * 7 + Number(d ?? 0)),
      sign * (Number(h ?? 0) * 3_600_000 + Number(mi ?? 0) * 60_000 + Number(sec ?? 0) * 1000))
  }
  const hms = /(-|\+)?(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(s)
  if (hms) {
    const v = (Number(hms[2]) * 3600 + Number(hms[3]) * 60 + Number(hms[4] ?? 0)) * 1000
    ms += hms[1] === '-' ? -v : v
    s = s.slice(0, hms.index).trim()
  }
  const re = /([+-]?\d+(?:\.\d+)?)\s*([a-z]+)/g
  let m: RegExpExecArray | null
  let consumed = s.replace(re, '').trim()
  if (consumed && !/^[,\s]*$/.test(consumed)) {
    // a bare number is seconds
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return new Interval(0, 0, sign * Number(s) * 1000)
    return invalid('interval', text)
  }
  consumed = ''
  while ((m = re.exec(s))) {
    const n = Number(m[1])
    const unit = unitOf(m[2])
    if (!unit) return invalid('interval', text)
    switch (unit) {
      case 'century': months += n * 1200; break
      case 'decade': months += n * 120; break
      case 'year': {
        const whole = Math.trunc(n * 12)
        months += whole
        break
      }
      case 'month': {
        const whole = Math.trunc(n)
        months += whole
        days += Math.round((n - whole) * 30)
        break
      }
      case 'week': {
        const d = n * 7
        days += Math.trunc(d)
        ms += Math.round((d - Math.trunc(d)) * 86_400_000)
        break
      }
      case 'day': {
        days += Math.trunc(n)
        ms += Math.round((n - Math.trunc(n)) * 86_400_000)
        break
      }
      default:
        ms += n * UNIT_MS[unit]
    }
  }
  return new Interval(sign * months, sign * days, sign * ms)
}

/** timestamp (ms since epoch, UTC fields) + interval: months and days by the calendar. */
export function addInterval(ms: number, iv: Interval, sign = 1): number {
  const d = new Date(ms)
  if (iv.months) {
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + sign * iv.months)
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
  }
  if (iv.days) d.setUTCDate(d.getUTCDate() + sign * iv.days)
  return d.getTime() + sign * iv.ms
}

// ---------------------------------------------------------------- arrays

/** Postgres array text {a,"b c",NULL} → items (text). */
export function parseArrayText(text: string): Array<string | null> {
  const s = text.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return invalid('array', text)
  const inner = s.slice(1, -1)
  if (inner.trim() === '') return []
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

function arrayText(list: unknown[], elem: string): string {
  return `{${list.map((v) => {
    if (v === null || v === undefined) return 'NULL'
    if (Array.isArray(v)) return arrayText(v, elem)
    const s = toText(v, elem)
    return s === '' || /[{},"\\\s]/.test(s) || s.toUpperCase() === 'NULL' ? `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : s
  }).join(',')}}`
}

// ---------------------------------------------------------------- json text

/** jsonb's key order: shorter keys first, then by bytes. */
export function jsonKeyOrder(keys: string[]): string[] {
  return [...keys].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
}

/** jsonb output text: {"a": 1, "b": [1, 2]} with keys in jsonb order. */
export function jsonText(v: unknown): string {
  if (v === JNULL || v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(jsonText).join(', ')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${jsonKeyOrder(Object.keys(o)).map((k) => `${JSON.stringify(k)}: ${jsonText(o[k])}`).join(', ')}}`
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  return JSON.stringify(v)
}

export function parseJson(text: string): unknown {
  try {
    const v = JSON.parse(text)
    return v === null ? JNULL : v
  } catch {
    return err('22P02', 'invalid input syntax for type json')
  }
}

// ---------------------------------------------------------------- output

/** The text form of a value (Postgres output functions). */
export function toText(v: unknown, t: string, s?: number): string {
  if (v === null || v === undefined) return ''
  if (isArrayType(t) || (Array.isArray(v) && t !== 'jsonb')) return arrayText(v as unknown[], elemType(t))
  switch (t) {
    case 'bool': return v ? 'true' : 'false'
    case 'jsonb': return jsonText(v)
    case 'numeric': return typeof v === 'number' ? scaledText(v, s) : String(v)
    case 'int': return typeof v === 'number' ? numberText(v) : String(v)
    case 'interval': return v instanceof Interval ? v.toString() : String(v)
    case 'timestamptz': return String(v)
    default:
      if (v instanceof PgRow) return `(${Object.entries(v.values).map(([k, x]) => (x === null ? '' : toText(x, v.types[k] ?? 'text'))).join(',')})`
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      if (v instanceof Interval) return v.toString()
      if (typeof v === 'object') return jsonText(v)
      if (typeof v === 'number') return numberText(v)
      return String(v)
  }
}

/** Rounds half away from zero to s decimals, as numeric(p, s) does. */
export function roundScale(n: number, s: number): number {
  if (!Number.isFinite(n) || s < 0 || s > 15) return n
  const f = 10 ** s
  return cleanNumber((Math.sign(n) * Math.round(cleanNumber(Math.abs(n) * f))) / f)
}

/** A numeric as Postgres prints it: with its display scale when known (990.00), else shortest. */
export function scaledText(n: number, s: number | undefined): string {
  if (s === undefined || s === FLOAT || !Number.isFinite(n)) return numberText(n)
  if (s > 15) {
    // beyond a double's digits: the shortest form, padded (1/3 prints 0.33333333333333300000)
    const text = numberText(n)
    if (/e/i.test(text)) return text
    const decimals = text.split('.')[1]?.length ?? 0
    return decimals >= s ? text : `${text}${decimals ? '' : '.'}${'0'.repeat(s - decimals)}`
  }
  return roundScale(n, s).toFixed(s)
}

/** An operand's display scale in arithmetic (integers add none). */
export function scaleOf(x: { t: string; s?: number }): number | undefined {
  return x.t === 'int' ? 0 : x.t === 'numeric' ? x.s : undefined
}

/** The display scale of a op b when the values are not known (a compiled query). */
export function arithScale(op: string, sa: number | undefined, sb: number | undefined): number | undefined {
  if (sa === FLOAT || sb === FLOAT) return FLOAT
  if (sa === undefined || sb === undefined) return undefined
  if (op === '+' || op === '-' || op === '%') return Math.max(sa, sb)
  if (op === '*') return sa + sb
  return undefined
}

/** Postgres' display scale of x / y (select_div_scale): about 16 significant digits, never fewer decimals than either side. */
export function divScale(x: number, y: number, sa: number, sb: number): number {
  const digits = (n: number) => {
    const a = Math.abs(n)
    if (a === 0 || !Number.isFinite(a)) return { w: 0, first: 0 }
    let w = Math.floor(Math.log10(a) / 4)
    while (10000 ** w > a) w--
    while (10000 ** (w + 1) <= a) w++
    return { w, first: Math.floor(cleanNumber(a / 10000 ** w)) }
  }
  const p = digits(x)
  const q = digits(y)
  let qweight = p.w - q.w
  if (p.first <= q.first) qweight--
  return Math.min(Math.max(16 - qweight * 4, sa, sb, 0), 1000)
}

/** The decimals a number was written with ('0.2500' → 4). */
export function writtenScale(text: string): number | undefined {
  const m = /^\s*[+-]?\d*(?:\.(\d*))?(?:e([+-]?\d+))?\s*$/i.exec(text)
  return m ? Math.max(0, (m[1]?.length ?? 0) - Number(m[2] ?? 0)) : undefined
}

/** The display scale a cast gives: the target's numeric(p, s), else what the value carries. */
export function castScale(x: { t: string; v: unknown; s?: number }, scale: number | undefined): number | undefined {
  if (scale !== undefined) return scale
  if (x.t === 'int') return 0
  if (x.t === 'numeric') return x.s
  if (typeof x.v === 'string') return writtenScale(x.v)
  return undefined
}

/** cast() for a typed value, keeping or setting a numeric's display scale. */
export function castTyped(x: Typed, to: string, scale?: number): Typed {
  if (to === 'numeric') {
    const s = castScale(x, scale)
    if (x.v === null || x.v === undefined) return { t: to, v: null, s }
    const n = cast(x.v, x.t, to) as number
    return { t: to, v: scale !== undefined && scale !== FLOAT ? roundScale(n, scale) : n, s }
  }
  if (x.v === null || x.v === undefined) return { t: to, v: null }
  return { t: to, v: cast(x.v, x.t, to, x.s) }
}

function numberText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
  const s = String(cleanNumber(n))
  if (/e/i.test(s)) return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
  return s
}

// ---------------------------------------------------------------- casts

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['t', 'true', 'y', 'yes', 'on', '1'].includes(s)) return true
  if (['f', 'false', 'n', 'no', 'off', '0'].includes(s)) return false
  return invalid('boolean', v)
}

function toNumber(v: unknown, t: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return t === 'int' ? (v ? 1 : 0) : err('42846', 'cannot cast type boolean to numeric')
  const s = String(v).trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    if (/^nan$/i.test(s)) return NaN
    if (t !== 'int' && /^[+-]?infinity$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity
    return invalid(t === 'int' ? 'integer' : 'numeric', v)
  }
  return Number(s)
}

/** Converts a value of type `from` to type `to` (explicit cast / assignment). */
export function cast(v: unknown, from: string, to: string, s?: number): unknown {
  if (v === null || v === undefined) return null
  if (from === to && !(to === 'int' && typeof v === 'number' && !Number.isInteger(v))) return v
  if (isArrayType(to)) {
    const elem = elemType(to)
    let list: unknown[]
    if (Array.isArray(v)) list = v
    else if (from === 'jsonb') return err('42846', `cannot cast type jsonb to ${to}`)
    else list = parseArrayText(String(v))
    const fromElem = isArrayType(from) ? elemType(from) : 'text'
    return list.map((x) => (Array.isArray(x) ? cast(x, from, to) : cast(x, x === null ? 'text' : fromElem, elem)))
  }
  if (v === JNULL && to !== 'jsonb' && to !== 'text') return null
  switch (to) {
    case 'text': case 'unknown':
      return toText(v, from, s)
    case 'uuid': {
      const m = UUID_RE.exec(String(v).trim())
      if (!m) return invalid('uuid', v)
      return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase()
    }
    case 'int': {
      if (from === 'jsonb') {
        if (typeof v !== 'number') return err('22023', `cannot cast jsonb ${jsonType(v)} to type integer`)
      }
      const n = toNumber(v, 'int')
      if (!Number.isFinite(n)) return invalid('integer', v)
      // Postgres rounds numeric → integer half away from zero; text must be an integer.
      if (typeof v === 'string' && !/^\s*[+-]?\d+\s*$/.test(v) && from !== 'numeric') return invalid('integer', v)
      return Math.sign(n) * Math.round(Math.abs(n))
    }
    case 'numeric': {
      if (from === 'jsonb' && typeof v !== 'number') return err('22023', `cannot cast jsonb ${jsonType(v)} to type numeric`)
      return toNumber(v, 'numeric')
    }
    case 'bool':
      if (from === 'jsonb' && typeof v !== 'boolean') return err('22023', `cannot cast jsonb ${jsonType(v)} to type boolean`)
      if (from === 'int' || from === 'numeric') return v !== 0
      return toBool(v)
    case 'jsonb':
      if (from === 'jsonb') return v
      if (from === 'text' || from === 'unknown') return parseJson(String(v))
      return toJson(v, from)
    case 'timestamptz':
      if (from === 'timestamp') return toTimestamptz(`${String(v)}Z`)
      if (from === 'date') return `${String(v)}T00:00:00.000Z`
      return toTimestamptz(v)
    case 'timestamp':
      if (from === 'timestamptz') return String(v).slice(0, 23)
      if (from === 'date') return `${String(v)}T00:00:00.000`
      return toTimestampLocal(v)
    case 'date':
      if (from === 'timestamptz' || from === 'timestamp') return String(v).slice(0, 10)
      return toDate(v)
    case 'time':
      if (from === 'timestamptz' || from === 'timestamp') return String(v).slice(11, 19)
      return toTime(v)
    case 'interval':
      if (v instanceof Interval) return v
      return parseInterval(String(v))
    case 'bytea':
      return typeof v === 'string' ? v : invalid('bytea', v)
    case 'record':
      return v
    default:
      if (isEnum(to)) {
        const s = typeof v === 'string' ? v : toText(v, from)
        if (!schema.enums[to].includes(s)) return err('22P02', `invalid input value for enum ${to}: "${s}"`)
        return s
      }
      if (isTableType(to)) {
        if (v instanceof PgRow) return v
        if (from === 'jsonb' && v && typeof v === 'object') return v
        return err('42846', `cannot cast type ${from} to ${to}`)
      }
      return v
  }
}

export function jsonType(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v === JNULL) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  return 'string'
}

/** to_jsonb(value). */
export function toJson(v: unknown, t: string): unknown {
  if (v === null || v === undefined) return JNULL
  if (v === JNULL) return JNULL
  if (v instanceof PgRow) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v.values)) o[k] = inner(toJson(x, v.types[k] ?? guessType(x)))
    return o
  }
  if (isArrayType(t) || Array.isArray(v)) {
    if (t === 'jsonb') return v
    const et = isArrayType(t) ? elemType(t) : guessType((v as unknown[])[0])
    return (v as unknown[]).map((x) => inner(toJson(x, et)))
  }
  switch (t) {
    case 'jsonb': return v
    case 'int': case 'numeric': return typeof v === 'number' && Number.isFinite(v) ? v : toText(v, t)
    case 'bool': return Boolean(v)
    case 'interval': return (v as Interval).toString()
    default:
      if (typeof v === 'number' || typeof v === 'boolean') return v
      if (v instanceof Interval) return v.toString()
      if (typeof v === 'object') return v
      return String(v)
  }
}

/** JNULL inside an object or array is just null. */
const inner = (v: unknown) => (v === JNULL ? null : v)

export function guessType(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'numeric'
  if (typeof v === 'boolean') return 'bool'
  if (v instanceof Interval) return 'interval'
  if (v instanceof PgRow) return 'record'
  if (Array.isArray(v) || (v && typeof v === 'object')) return 'jsonb'
  return 'text'
}

// ---------------------------------------------------------------- comparison

/** Equality of two non-null values of the same type family. */
export function equal(a: unknown, b: unknown, t: string): boolean {
  return compare(a, b, t) === 0
}

/** Ordering of two non-null values (Postgres' btree order for the type). */
export function compare(a: unknown, b: unknown, t: string): number {
  if (a === b) return 0
  if (t === 'jsonb') return compareJson(a, b)
  if (a instanceof Interval && b instanceof Interval) return Math.sign(a.epoch() - b.epoch())
  if (Array.isArray(a) && Array.isArray(b)) {
    const et = elemType(t)
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === null && b[i] === null) continue
      if (a[i] === null) return 1
      if (b[i] === null) return -1
      const c = compare(a[i], b[i], et)
      if (c) return c
    }
    return Math.sign(a.length - b.length)
  }
  if (a instanceof PgRow && b instanceof PgRow) {
    const ka = Object.keys(a.values)
    for (const k of ka) {
      const x = a.values[k]
      const y = b.values[k]
      if (x === null && y === null) continue
      if (x === null) return 1
      if (y === null) return -1
      const c = compare(x, y, a.types[k] ?? guessType(x))
      if (c) return c
    }
    return 0
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1
  if (t === 'timestamptz' || t === 'timestamp') {
    const x = Date.parse(t === 'timestamp' ? `${String(a)}Z` : String(a))
    const y = Date.parse(t === 'timestamp' ? `${String(b)}Z` : String(b))
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (isEnum(t)) {
    const order = schema.enums[t]
    return Math.sign(order.indexOf(String(a)) - order.indexOf(String(b)))
  }
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

const JSON_RANK: Record<string, number> = { null: 0, string: 1, number: 2, boolean: 3, array: 4, object: 5 }

function compareJson(a: unknown, b: unknown): number {
  const ta = jsonType(a)
  const tb = jsonType(b)
  if (ta !== tb) {
    // jsonb orders objects > arrays > booleans > numbers > strings > null
    return Math.sign(JSON_RANK[ta] - JSON_RANK[tb])
  }
  switch (ta) {
    case 'null': return 0
    case 'number': return Math.sign((a as number) - (b as number))
    case 'boolean': return a === b ? 0 : a ? 1 : -1
    case 'string': return a === b ? 0 : (a as string) < (b as string) ? -1 : 1
    case 'array': {
      const x = a as unknown[]
      const y = b as unknown[]
      if (x.length !== y.length) return Math.sign(x.length - y.length)
      for (let i = 0; i < x.length; i++) {
        const c = compareJson(x[i] ?? JNULL, y[i] ?? JNULL)
        if (c) return c
      }
      return 0
    }
    default: {
      const x = a as Record<string, unknown>
      const y = b as Record<string, unknown>
      const kx = jsonKeyOrder(Object.keys(x))
      const ky = jsonKeyOrder(Object.keys(y))
      if (kx.length !== ky.length) return Math.sign(kx.length - ky.length)
      for (let i = 0; i < kx.length; i++) {
        if (kx[i] !== ky[i]) return kx[i] < ky[i] ? -1 : 1
        const c = compareJson(x[kx[i]] ?? JNULL, y[ky[i]] ?? JNULL)
        if (c) return c
      }
      return 0
    }
  }
}

/** A deep copy of a JSON value (jsonb values are immutable in Postgres). */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object' || (v as unknown) === JNULL) return v
  return JSON.parse(JSON.stringify(v)) as T
}

// Evaluates expressions in JavaScript with Postgres' semantics (three-valued logic,
// types, JSON operators). Anything that reads tables (sub-queries, EXISTS, aggregates)
// is handed to SQLite through the compiler.
import { DbError } from '../errors.ts'
import { nextval } from '../writer.ts'
import type { CallExpr, Expr, Select } from './ast.ts'
import { decodeSql } from './bridge.ts'
import { aggregates, builtins, jsonConcat, jsonContains, jsonDelete, jsonGet, jsonGetText, jsonHasKey, jsonPath, likeRegex, msOf, fromMs, pgRegex, windowFunctions } from './builtins.ts'
import { SERVER_SETTINGS } from './catalog.ts'
import { runSql } from './run.ts'
import { FLOAT, NotSupported, type Engine, type Typed, type Vars } from './runtime.ts'
import { elemType, isArrayType } from './types.ts'
import { addInterval, arithScale, cast, castTyped, cleanNumber, compare, divScale, err, guessType, Interval, isEnum, isTableType, JNULL, localToTz, PgRow, scaleOf, tzToLocal } from './values.ts'

const T = (t: string, v: unknown): Typed => ({ t, v })
const NULLT: Typed = { t: 'unknown', v: null }
const BOOL = (v: boolean | null): Typed => ({ t: 'bool', v })

const dateLike = (t: string) => t === 'date' || t === 'timestamptz' || t === 'timestamp'
const numberLike = (t: string) => t === 'int' || t === 'numeric'
const textLike = (t: string) => t === 'text' || t === 'unknown' || t === 'uuid' || isEnum(t)

/** The type two operands are compared or combined as. */
export function commonType(a: string, b: string): string {
  if (a === b) return a === 'unknown' ? 'text' : a
  if (a === 'unknown') return b
  if (b === 'unknown') return a
  if (numberLike(a) && numberLike(b)) return 'numeric'
  if (dateLike(a) && dateLike(b)) return a === 'date' ? b : b === 'date' ? a : 'timestamptz'
  if (textLike(a) && textLike(b)) return isEnum(a) ? a : isEnum(b) ? b : a === 'uuid' || b === 'uuid' ? 'uuid' : 'text'
  if (a === 'record' || isTableType(a)) return a
  if (b === 'record' || isTableType(b)) return b
  return a
}

function coerce(x: Typed, t: string): unknown {
  if (x.v === null) return null
  if (x.t === t) return x.v
  if (numberLike(x.t) && numberLike(t)) return x.v
  return cast(x.v, x.t, t)
}

/** Postgres comparison of two typed values: -1/0/1, or null when either is NULL. */
export function compareTyped(a: Typed, b: Typed): number | null {
  if (a.v === null || b.v === null) return null
  const t = commonType(a.t, b.t)
  if (dateLike(t)) {
    const x = msOf(coerce(a, t), t)
    const y = msOf(coerce(b, t), t)
    return x < y ? -1 : x > y ? 1 : 0
  }
  return compare(coerce(a, t), coerce(b, t), t)
}

export class Evaluator {
  constructor(readonly engine: Engine, readonly vars: Vars, readonly params: Typed[] = []) {}

  eval(e: Expr): Typed {
    switch (e.k) {
      case 'lit':
        if (e.v === null) return NULLT
        if (typeof e.v === 'boolean') return BOOL(e.v)
        if (typeof e.v === 'number') return e.type === 'int' ? T('int', e.v) : { t: 'numeric', v: e.v, s: e.s }
        return T('unknown', e.v)
      case 'value':
        return { t: e.type, v: e.v, s: e.s }
      case 'param': {
        const v = this.vars.lookup([`$${e.n}`]) ?? this.params[e.n - 1]
        if (!v) throw new DbError('42P02', `there is no parameter $${e.n}`)
        return v
      }
      case 'ref': {
        const v = this.vars.lookup(e.parts)
        if (v) return v
        throw new DbError('42703', `column "${e.parts.join('.')}" does not exist`)
      }
      case 'star':
        throw new DbError('42601', 'a star is only allowed in a select list')
      case 'call':
        return this.call(e)
      case 'bin':
        return this.binary(e.op, e.l, e.r)
      case 'un': {
        if (e.op === 'not') {
          const x = this.eval(e.e)
          return BOOL(x.v === null ? null : !this.truth(x))
        }
        const x = this.eval(e.e)
        if (x.v === null) return x
        if (x.v instanceof Interval) return T('interval', x.v.negate())
        return { t: x.t === 'unknown' ? 'numeric' : x.t, v: -Number(x.v), s: x.s }
      }
      case 'is': {
        const x = this.eval(e.e)
        let r: boolean
        if (e.what === 'null' || e.what === 'unknown') r = x.v === null || (x.v instanceof PgRow && Object.values(x.v.values).every((v) => v === null))
        else if (x.v === null) r = false
        else r = this.truth(x) === (e.what === 'true')
        return BOOL(e.not ? !r : r)
      }
      case 'isdistinct': {
        const a = this.eval(e.l)
        const b = this.eval(e.r)
        let same: boolean
        if (a.v === null || b.v === null) same = a.v === null && b.v === null
        else same = compareTyped(a, b) === 0
        return BOOL(e.not ? same : !same)
      }
      case 'between': {
        const x = this.eval(e.e)
        const lo = this.eval(e.lo)
        const hi = this.eval(e.hi)
        const a = compareTyped(x, lo)
        const b = compareTyped(x, hi)
        const r = and3(a === null ? null : a >= 0, b === null ? null : b <= 0)
        return BOOL(r === null ? null : e.not ? !r : r)
      }
      case 'in': {
        if (e.q) return this.viaSql(e)
        const x = this.eval(e.e)
        if (x.v === null) return BOOL(null)
        let sawNull = false
        for (const it of e.list!) {
          const y = this.eval(it)
          const c = compareTyped(x, y)
          if (c === null) sawNull = true
          else if (c === 0) return BOOL(!e.not)
        }
        return BOOL(sawNull ? null : e.not)
      }
      case 'quant': {
        if (e.q) return this.viaSql(e)
        const x = this.eval(e.l)
        const arr = this.eval(e.r!)
        if (arr.v === null) return BOOL(null)
        const list = Array.isArray(arr.v) ? arr.v : (cast(arr.v, arr.t, 'text[]') as unknown[])
        const et = isArrayType(arr.t) ? elemType(arr.t) : x.t
        let sawNull = false
        const all = e.quant === 'all'
        for (const item of list) {
          const r = this.test(e.op, x, T(et, item))
          if (r === null) sawNull = true
          else if (all && !r) return BOOL(false)
          else if (!all && r) return BOOL(true)
        }
        return BOOL(sawNull ? null : all)
      }
      case 'like': {
        const x = this.eval(e.e)
        const p = this.eval(e.p)
        if (x.v === null || p.v === null) return BOOL(null)
        if (e.similar) throw new NotSupported('SIMILAR TO')
        const esc = e.escape ? String(this.eval(e.escape).v ?? '') : '\\'
        const r = likeRegex(String(p.v), e.ci, esc).test(this.text(x))
        return BOOL(e.not ? !r : r)
      }
      case 'case': {
        if (e.subject) {
          const s = this.eval(e.subject)
          for (const w of e.whens) {
            if (compareTyped(s, this.eval(w.when)) === 0) return this.eval(w.then)
          }
        } else {
          for (const w of e.whens) if (this.truth(this.eval(w.when))) return this.eval(w.then)
        }
        return e.else ? this.eval(e.else) : NULLT
      }
      case 'cast': {
        const x = this.eval(e.e)
        const to = e.type.array ? `${e.type.name}[]` : e.type.name
        return castTyped(x, to, e.type.scale)
      }
      case 'exists': case 'sub': case 'arraysub':
        return this.viaSql(e)
      case 'array': {
        const items = e.items.map((it) => this.eval(it))
        const et = items.find((x) => x.t !== 'unknown')?.t ?? 'text'
        const elem = isArrayType(et) ? elemType(et) : et
        return T(`${elem}[]`, items.map((x) => (x.v === null ? null : isArrayType(x.t) ? x.v : coerce(x, elem))))
      }
      case 'row': {
        const values: Record<string, unknown> = {}
        const types: Record<string, string> = {}
        e.items.forEach((it, i) => {
          const x = this.eval(it)
          values[`f${i + 1}`] = x.v
          types[`f${i + 1}`] = x.t
        })
        return T('record', new PgRow(values, types))
      }
      case 'field': {
        const x = this.eval(e.e)
        if (x.v === null) return NULLT
        if (!(x.v instanceof PgRow)) throw new DbError('42809', `cannot read field ${e.name} of a non-composite value`)
        if (e.name === '*') return x
        if (!Object.hasOwn(x.v.values, e.name)) throw new DbError('42703', `record has no field "${e.name}"`)
        return T(x.v.types[e.name] ?? guessType(x.v.values[e.name]), x.v.values[e.name])
      }
      case 'index': {
        const x = this.eval(e.e)
        if (x.v === null) return NULLT
        if (!Array.isArray(x.v)) throw new DbError('42804', 'cannot subscript a non-array value')
        const et = isArrayType(x.t) ? elemType(x.t) : 'text'
        if (e.slice) {
          const lo = e.idx ? Number(this.eval(e.idx).v) : 1
          const hi = e.upper ? Number(this.eval(e.upper).v) : x.v.length
          return T(x.t, x.v.slice(Math.max(lo, 1) - 1, Math.max(hi, 0)))
        }
        const i = this.eval(e.idx!)
        if (i.v === null) return T(et, null)
        const v = x.v[Number(i.v) - 1]
        return T(et, v === undefined ? null : v)
      }
      case 'attz': {
        const x = this.eval(e.e)
        const z = this.eval(e.zone)
        if (x.v === null || z.v === null) return T(x.t === 'timestamp' ? 'timestamptz' : 'timestamp', null)
        if (x.t === 'timestamp') return T('timestamptz', localToTz(String(x.v), String(z.v)))
        const ts = cast(x.v, x.t === 'unknown' ? 'text' : x.t, 'timestamptz') as string
        return T('timestamp', tzToLocal(ts, String(z.v)))
      }
      case 'default':
        throw new DbError('42601', 'DEFAULT is not allowed here')
      case 'quantarg':
        throw new DbError('42601', 'ANY/ALL needs an operator')
    }
  }

  /** WHERE/IF truth: only TRUE counts. */
  truth(x: Typed): boolean {
    if (x.v === null) return false
    if (typeof x.v === 'boolean') return x.v
    return cast(x.v, x.t, 'bool') as boolean
  }

  private text(x: Typed): string {
    return x.t === 'unknown' || typeof x.v === 'string' ? String(x.v) : (cast(x.v, x.t, 'text', x.s) as string)
  }

  /** Runs the expression in SQLite (it reads tables). */
  viaSql(e: Expr): Typed {
    const sel: Select = { k: 'select', items: [{ e, alias: 'v' }], from: [], groupBy: [], orderBy: [] }
    return this.selectValue(sel)
  }

  selectValue(sel: Select): Typed {
    // imported lazily: compile.ts imports this module
    const c = new Compiler(this.engine, this.vars, this.params)
    const compiled = c.select(sel, null, true)
    const rows = runSql(this.engine, compiled.sql, c.params)
    const { t, s } = compiled.cols[0]
    if (!rows.length) return { t, v: null, s }
    return { t, v: decodeSql(Object.values(rows[0])[0], t), s }
  }

  // ---------------------------------------------------------------- operators

  private test(op: string, a: Typed, b: Typed): boolean | null {
    if (op === 'like' || op === 'ilike' || op === 'not like' || op === 'not ilike') {
      if (a.v === null || b.v === null) return null
      const r = likeRegex(String(b.v), op.includes('ilike')).test(this.text(a))
      return op.startsWith('not') ? !r : r
    }
    if (op === '~' || op === '~*' || op === '!~' || op === '!~*') {
      if (a.v === null || b.v === null) return null
      const r = pgRegex(String(b.v), op.includes('*') ? 'i' : '').test(this.text(a))
      return op.startsWith('!') ? !r : r
    }
    const c = compareTyped(a, b)
    if (c === null) return null
    switch (op) {
      case '=': return c === 0
      case '<>': return c !== 0
      case '<': return c < 0
      case '>': return c > 0
      case '<=': return c <= 0
      case '>=': return c >= 0
      default: throw new NotSupported(`operator ${op} with ANY/ALL`)
    }
  }

  private binary(op: string, le: Expr, re: Expr): Typed {
    if (op === 'and') {
      const a = this.eval(le)
      if (a.v !== null && !this.truth(a)) return BOOL(false)
      const b = this.eval(re)
      return BOOL(and3(a.v === null ? null : true, b.v === null ? null : this.truth(b)))
    }
    if (op === 'or') {
      const a = this.eval(le)
      if (a.v !== null && this.truth(a)) return BOOL(true)
      const b = this.eval(re)
      if (b.v !== null && this.truth(b)) return BOOL(true)
      return BOOL(a.v === null || b.v === null ? null : false)
    }
    const a = this.eval(le)
    const b = this.eval(re)
    switch (op) {
      case '=': case '<>': case '<': case '>': case '<=': case '>=':
      case '~': case '~*': case '!~': case '!~*': case 'like':
        return BOOL(this.test(op, a, b))
      case '||': return this.concat(a, b)
      case '->': {
        if (a.v === null || b.v === null) return T('jsonb', null)
        const j = a.t === 'jsonb' ? a.v : cast(a.v, a.t, 'jsonb')
        const v = jsonGet(j, b.t === 'int' ? b.v : String(b.v))
        return T('jsonb', v)
      }
      case '->>': {
        if (a.v === null || b.v === null) return T('text', null)
        const j = a.t === 'jsonb' ? a.v : cast(a.v, a.t, 'jsonb')
        return T('text', jsonGetText(j, b.t === 'int' ? b.v : String(b.v)))
      }
      case '#>': case '#>>': {
        if (a.v === null || b.v === null) return T(op === '#>' ? 'jsonb' : 'text', null)
        const j = a.t === 'jsonb' ? a.v : cast(a.v, a.t, 'jsonb')
        const v = jsonPath(j, b.v)
        if (op === '#>') return T('jsonb', v)
        return T('text', v === null || v === JNULL ? null : typeof v === 'string' ? v : cast(v, 'jsonb', 'text'))
      }
      case '?': {
        if (a.v === null || b.v === null) return BOOL(null)
        return BOOL(jsonHasKey(a.v, String(b.v)))
      }
      case '?|': case '?&': {
        if (a.v === null || b.v === null) return BOOL(null)
        const keys = (Array.isArray(b.v) ? b.v : cast(b.v, b.t, 'text[]') as unknown[]).map(String)
        return BOOL(op === '?|' ? keys.some((k) => jsonHasKey(a.v, k)) : keys.every((k) => jsonHasKey(a.v, k)))
      }
      case '@>': case '<@': {
        const [big, small] = op === '@>' ? [a, b] : [b, a]
        if (big.v === null || small.v === null) return BOOL(null)
        if (big.t === 'jsonb' || small.t === 'jsonb') {
          const x = big.t === 'jsonb' ? big.v : cast(big.v, big.t, 'jsonb')
          const y = small.t === 'jsonb' ? small.v : cast(small.v, small.t, 'jsonb')
          return BOOL(jsonContains(x, y))
        }
        const x = Array.isArray(big.v) ? big.v : (cast(big.v, big.t, 'text[]') as unknown[])
        const y = Array.isArray(small.v) ? small.v : (cast(small.v, small.t, isArrayType(big.t) ? big.t : 'text[]') as unknown[])
        const et = isArrayType(big.t) ? elemType(big.t) : 'text'
        return BOOL(y.every((v) => x.some((w) => w !== null && v !== null && compare(w, v, et) === 0)))
      }
      case '&&': {
        if (a.v === null || b.v === null) return BOOL(null)
        const x = a.v as unknown[]
        const y = b.v as unknown[]
        const et = isArrayType(a.t) ? elemType(a.t) : 'text'
        return BOOL(x.some((v) => v !== null && y.some((w) => w !== null && compare(v, w, et) === 0)))
      }
      case '#-': {
        if (a.v === null || b.v === null) return T('jsonb', null)
        throw new NotSupported('#- operator')
      }
      default:
        return this.arith(op, a, b)
    }
  }

  private concat(a: Typed, b: Typed): Typed {
    if (a.t === 'jsonb' || b.t === 'jsonb') {
      if (a.v === null || b.v === null) return T('jsonb', null)
      const x = a.t === 'jsonb' ? a.v : cast(a.v, a.t === 'unknown' ? 'text' : a.t, 'jsonb')
      const y = b.t === 'jsonb' ? b.v : cast(b.v, b.t === 'unknown' ? 'text' : b.t, 'jsonb')
      return T('jsonb', jsonConcat(x, y))
    }
    if (isArrayType(a.t) || isArrayType(b.t)) {
      const at = isArrayType(a.t) ? a.t : b.t
      const et = elemType(at)
      if (isArrayType(a.t) && isArrayType(b.t)) {
        if (a.v === null) return b
        if (b.v === null) return a
        return T(at, [...(a.v as unknown[]), ...(b.v as unknown[])])
      }
      if (isArrayType(a.t)) {
        const elem = b.t === 'unknown' && typeof b.v === 'string' && b.v.startsWith('{') ? (cast(b.v, 'text', at) as unknown[]) : [coerce(b, et)]
        return T(at, [...((a.v as unknown[] | null) ?? []), ...elem])
      }
      const elem = a.t === 'unknown' && typeof a.v === 'string' && a.v.startsWith('{') ? (cast(a.v, 'text', at) as unknown[]) : [coerce(a, et)]
      return T(at, [...elem, ...((b.v as unknown[] | null) ?? [])])
    }
    if (a.v === null || b.v === null) return T('text', null)
    return T('text', this.text(a) + this.text(b))
  }

  private arith(op: string, a: Typed, b: Typed): Typed {
    const resultType = this.arithType(op, a.t, b.t)
    if (a.v === null || b.v === null) return T(resultType, null)
    // dates, times and intervals
    if (a.v instanceof Interval || b.v instanceof Interval || a.t === 'interval' || b.t === 'interval' || dateLike(a.t) || dateLike(b.t)) {
      return this.dateArith(op, a, b)
    }
    if (op === '-' && a.t === 'jsonb') return T('jsonb', jsonDelete(a.v, b.v, b.t))
    const x = Number(coerce(a, 'numeric'))
    const y = Number(coerce(b, 'numeric'))
    const intOp = resultType === 'int'
    let r: number
    switch (op) {
      case '+': r = x + y; break
      case '-': r = x - y; break
      case '*': r = x * y; break
      case '/':
        if (y === 0) return err('22012', 'division by zero')
        r = intOp ? Math.trunc(x / y) : x / y
        break
      case '%':
        if (y === 0) return err('22012', 'division by zero')
        r = x % y
        break
      case '^': r = x ** y; break
      default: throw new NotSupported(`operator ${op}`)
    }
    if (intOp) return T(resultType, r)
    const sa = scaleOf(a.t === 'unknown' ? { t: 'numeric', s: undefined } : a)
    const sb = scaleOf(b.t === 'unknown' ? { t: 'numeric', s: undefined } : b)
    const s = op === '/' && sa !== FLOAT && sb !== FLOAT ? divScale(x, y, sa ?? 0, sb ?? 0) : arithScale(op, sa, sb)
    return { t: resultType, v: cleanNumber(r), s }
  }

  private arithType(op: string, a: string, b: string): string {
    if (dateLike(a) || dateLike(b) || a === 'interval' || b === 'interval') {
      if (a === 'date' && b === 'date' && op === '-') return 'int'
      if (a === 'date' && (b === 'int' || b === 'unknown')) return 'date'
      if (dateLike(a) && dateLike(b) && op === '-') return 'interval'
      if (a === 'date' || b === 'date') return 'timestamp'
      if (dateLike(a)) return a
      if (dateLike(b)) return b
      return 'interval'
    }
    if (a === 'jsonb') return 'jsonb'
    if (op === '^') return 'numeric'
    const x = a === 'unknown' ? b : a
    const y = b === 'unknown' ? a : b
    return x === 'int' && y === 'int' ? 'int' : 'numeric'
  }

  private dateArith(op: string, a: Typed, b: Typed): Typed {
    const iv = (x: Typed): Interval => (x.v instanceof Interval ? x.v : (cast(x.v, x.t, 'interval') as Interval))
    const isIv = (x: Typed) => x.v instanceof Interval || x.t === 'interval'
    // date ± integer days
    if (a.t === 'date' && (numberLike(b.t) || (b.t === 'unknown' && /^-?\d+$/.test(String(b.v))))) {
      const days = Number(b.v) * (op === '-' ? -1 : 1)
      return T('date', fromMs(msOf(a.v, 'date') + days * 86_400_000, 'date'))
    }
    if (numberLike(a.t) && b.t === 'date' && op === '+') return T('date', fromMs(msOf(b.v, 'date') + Number(a.v) * 86_400_000, 'date'))
    if (dateLike(a.t) && (isIv(b) || b.t === 'unknown') && (op === '+' || op === '-')) {
      const t = a.t === 'date' ? 'timestamp' : a.t
      const ms = addInterval(msOf(a.v, a.t), iv(b), op === '-' ? -1 : 1)
      return T(t, fromMs(ms, t))
    }
    if (isIv(a) && dateLike(b.t) && op === '+') {
      const t = b.t === 'date' ? 'timestamp' : b.t
      return T(t, fromMs(addInterval(msOf(b.v, b.t), iv(a)), t))
    }
    if (dateLike(a.t) && (dateLike(b.t) || b.t === 'unknown') && op === '-') {
      if (a.t === 'date' && (b.t === 'date' || b.t === 'unknown')) return T('int', Math.round((msOf(a.v, 'date') - msOf(coerce(b, 'date'), 'date')) / 86_400_000))
      const tb = b.t === 'unknown' ? a.t : b.t
      const diff = msOf(a.v, a.t) - msOf(coerce(b, tb), tb)
      const days = Math.trunc(diff / 86_400_000)
      return T('interval', new Interval(0, days, diff - days * 86_400_000))
    }
    if (isIv(a) && isIv(b)) {
      const x = iv(a)
      const y = iv(b)
      if (op === '+') return T('interval', new Interval(x.months + y.months, x.days + y.days, x.ms + y.ms))
      if (op === '-') return T('interval', new Interval(x.months - y.months, x.days - y.days, x.ms - y.ms))
    }
    if ((isIv(a) && numberLike(b.t)) || (numberLike(a.t) && isIv(b))) {
      const x = isIv(a) ? iv(a) : iv(b)
      const n = Number(isIv(a) ? b.v : a.v)
      if (op === '*') return T('interval', scaleInterval(x, n))
      if (op === '/' && isIv(a)) {
        if (n === 0) return err('22012', 'division by zero')
        return T('interval', scaleInterval(x, 1 / n))
      }
    }
    if (a.t === 'date' && b.t === 'time' && op === '+') return T('timestamp', `${String(a.v)}T${String(b.v)}.000`)
    throw new DbError('42883', `operator does not exist: ${a.t} ${op} ${b.t}`)
  }

  // ---------------------------------------------------------------- calls

  private call(e: CallExpr): Typed {
    const name = e.name
    const schema = e.schema
    if (schema === 'auth' || schema === 'vault') return this.engine.call(name, e.args.map((x) => this.eval(x)), e.names, schema)
    const builtin = !schema || schema === 'pg_catalog' || schema === 'extensions'
    if (builtin) {
      if (e.over || ((aggregates.has(name) || windowFunctions.has(name)) && !builtins[name])) return this.viaSql(e)
      switch (name) {
        case 'coalesce': {
          let t = 'unknown'
          for (const a of e.args) {
            const x = this.eval(a)
            if (x.v !== null) return x
            if (t === 'unknown') t = x.t
          }
          return T(t, null)
        }
        case 'nullif': {
          const a = this.eval(e.args[0])
          const b = this.eval(e.args[1])
          return compareTyped(a, b) === 0 ? T(a.t, null) : a
        }
        case 'greatest': case 'least': {
          let best: Typed | null = null
          let t = 'unknown'
          for (const a of e.args) {
            const x = this.eval(a)
            if (t === 'unknown') t = x.t
            if (x.v === null) continue
            if (!best) best = x
            else {
              const c = compareTyped(x, best)!
              if (name === 'greatest' ? c > 0 : c < 0) best = x
            }
          }
          if (!best) return T(t, null)
          const rt = e.args.length ? this.commonOf([best.t, t]) : best.t
          return rt === best.t ? best : { t: rt, v: coerce(best, rt), s: scaleOf(best) }
        }
        case 'set_config': {
          const [k, v] = e.args.map((x) => this.eval(x))
          const value = v.v === null ? '' : this.text(v)
          this.engine.ctx.setSetting(String(k.v), value)
          return T('text', value)
        }
        case 'current_setting': {
          const [k, missing] = e.args.map((x) => this.eval(x))
          const v = this.engine.ctx.getSetting(String(k.v)) ?? SERVER_SETTINGS[String(k.v)] ?? null
          if (v === null && !(missing && missing.v === true)) throw new DbError('42704', `unrecognized configuration parameter "${String(k.v)}"`)
          return T('text', v)
        }
        case 'nextval': case 'currval': case 'setval': {
          const args = e.args.map((x) => this.eval(x))
          const seq = String(args[0].v).replace(/^public\./, '').replace(/^"|"$/g, '')
          if (name === 'nextval') {
            const n = nextval(this.engine.sql, seq)
            sequenceValues(this.engine).set(seq, n)
            return T('int', n)
          }
          if (name === 'currval') {
            const n = sequenceValues(this.engine).get(seq)
            if (n === undefined) throw new DbError('55000', `currval of sequence "${seq}" is not yet defined in this session`)
            return T('int', n)
          }
          const n = Number(args[1].v)
          const called = args[2] ? Boolean(args[2].v) : true
          this.engine.sql.run('UPDATE _sequences SET value = ? WHERE name = ?', [called ? n : n - 1, seq])
          return T('int', n)
        }
      }
      const b = builtins[name]
      if (b) {
        const args = e.args.map((x) => this.eval(x))
        const types = args.map((x) => x.t)
        const rt = b.ret(types, e.args)
        if (b.strict !== false && args.some((x) => x.v === null)) return T(rt, null)
        if (!b.js) return this.viaSql({ ...e, args: args.map((x) => ({ k: 'value', v: x.v, type: x.t })) })
        const scales = args.map((x) => x.s)
        const v = b.js(args.map((x) => x.v), types, { engine: this.engine, names: e.names, exprs: e.args, scales })
        const s = rt === 'numeric' ? b.scale?.(args.map(scaleOf), args.map((x) => ({ v: x.v }))) : undefined
        return { t: rt, v: v === undefined ? null : v, s }
      }
      if (aggregates.has(name)) return this.viaSql(e)
      if (schema === 'pg_catalog' || schema === 'extensions') throw new DbError('42883', `function ${name} does not exist`)
    }
    const args = e.args.map((x) => this.eval(x))
    return this.engine.call(name, args, e.names, schema)
  }

  private commonOf(types: string[]): string {
    return types.reduce((a, b) => (a === 'unknown' ? b : b === 'unknown' ? a : commonType(a, b)), 'unknown')
  }
}

function and3(a: boolean | null, b: boolean | null): boolean | null {
  if (a === false || b === false) return false
  if (a === null || b === null) return null
  return true
}

function scaleInterval(x: Interval, n: number): Interval {
  const months = x.months * n
  const wholeMonths = Math.trunc(months)
  const days = x.days * n + (months - wholeMonths) * 30
  const wholeDays = Math.trunc(days)
  const ms = x.ms * n + (days - wholeDays) * 86_400_000
  return new Interval(wholeMonths, wholeDays, Math.round(ms))
}

const sequences = new WeakMap<object, Map<string, number>>()
function sequenceValues(engine: Engine): Map<string, number> {
  let m = sequences.get(engine.ctx)
  if (!m) {
    m = new Map()
    sequences.set(engine.ctx, m)
  }
  return m
}

// late import (circular)
import { Compiler } from './compile.ts'

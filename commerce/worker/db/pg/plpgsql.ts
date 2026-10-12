// The PL/pgSQL interpreter: runs a function body as written in the migrations.
// Variables live in block frames; SQL statements go through query.ts with the
// variables visible to them; a block with EXCEPTION handlers runs as a savepoint, so
// a caught error undoes that block's writes exactly like Postgres.
import { DbError } from '../errors.ts'
import { table as tableMeta } from '../meta.ts'
import type { Expr, Into, Statement } from './ast.ts'
import { columnType } from './bridge.ts'
import { Evaluator } from './evaluate.ts'
import { lex } from './lex.ts'
import { Parser } from './parse.ts'
import type { Decl, Handler, PlStmt } from './plparse.ts'
import { execStatement, type ResultSet } from './query.ts'
import { NotSupported, type Engine, type Typed, type Vars } from './runtime.ts'
import { elemType, isArrayType } from './types.ts'
import { cast, castScale, guessType, isTableType, PgRow, roundScale, toText } from './values.ts'

export interface Variable {
  type: string
  value: unknown
  constant?: boolean
  notNull?: boolean
  /** Declared numeric(p, s) scale (values are rounded to it), or FLOAT. */
  scale?: number
  /** The display scale of the current numeric value. */
  s?: number
}

interface Frame {
  label?: string
  vars: Map<string, Variable>
}

type Signal = { k: 'return' } | { k: 'exit' | 'continue'; label?: string } | null

/** SQLSTATE codes of the condition names PL/pgSQL handlers use. */
const CONDITIONS: Record<string, string> = {
  unique_violation: '23505', foreign_key_violation: '23503', not_null_violation: '23502', check_violation: '23514', exclusion_violation: '23P01',
  restrict_violation: '23001', raise_exception: 'P0001', no_data_found: 'P0002', too_many_rows: 'P0003', assert_failure: 'P0004',
  invalid_text_representation: '22P02', numeric_value_out_of_range: '22003', division_by_zero: '22012', invalid_parameter_value: '22023',
  invalid_datetime_format: '22007', datetime_field_overflow: '22008', string_data_right_truncation: '22001', null_value_not_allowed: '22004',
  invalid_regular_expression: '2201B', untranslatable_character: '22P05', character_not_in_repertoire: '22021', invalid_binary_representation: '22P03',
  invalid_escape_sequence: '22025', floating_point_exception: '22P01', array_subscript_error: '2202E', invalid_json_text: '22032',
  insufficient_privilege: '42501', undefined_function: '42883', undefined_table: '42P01', undefined_column: '42703', undefined_object: '42704',
  duplicate_object: '42710', syntax_error: '42601', wrong_object_type: '42809', ambiguous_column: '42702', lock_not_available: '55P03',
  object_not_in_prerequisite_state: '55000', serialization_failure: '40001', deadlock_detected: '40P01', query_canceled: '57014',
  feature_not_supported: '0A000', program_limit_exceeded: '54000', internal_error: 'XX000', duplicate_table: '42P07', invalid_cursor_state: '24000',
  read_only_sql_transaction: '25006', cardinality_violation: '21000', data_exception: '22000', integrity_constraint_violation: '23000',
}
const CLASSES: Record<string, string> = {
  data_exception: '22', integrity_constraint_violation: '23', syntax_error_or_access_rule_violation: '42', transaction_rollback: '40',
  insufficient_resources: '53', program_limit_exceeded: '54', object_not_in_prerequisite_state: '55', operator_intervention: '57',
  system_error: '58', plpgsql_error: 'P0', invalid_transaction_state: '25', feature_not_supported: '0A',
}

export function sqlstateOf(nameOrCode: string): string {
  const s = nameOrCode.toLowerCase()
  if (CONDITIONS[s]) return CONDITIONS[s]
  if (/^[0-9a-z]{5}$/i.test(nameOrCode)) return nameOrCode.toUpperCase()
  return 'P0001'
}

function matches(conditions: string[], code: string): boolean {
  for (const c of conditions) {
    const s = c.toLowerCase()
    if (s === 'others') {
      if (code !== '57014' && code !== 'P0004') return true
      continue
    }
    if (CLASSES[s] && code.startsWith(CLASSES[s])) return true
    if (CONDITIONS[s] === code) return true
    if (c.toUpperCase() === code) return true
  }
  return false
}

/** Rows of a result as row values (for record targets, RETURN QUERY, FOR loops). */
export function rowOf(res: ResultSet, i: number): PgRow {
  const values: Record<string, unknown> = {}
  const types: Record<string, string> = {}
  const scales: Record<string, number | undefined> = {}
  res.cols.forEach((c, j) => {
    values[c.name] = res.rows[i]?.[j] ?? null
    types[c.name] = c.t
    if (c.s !== undefined) scales[c.name] = c.s
  })
  return new PgRow(values, types, scales)
}

/** A row value converted to a table's row type: by name when the names match, else by position. */
export function toRowType(row: PgRow, table: string): PgRow {
  const meta = tableMeta(table)
  if (!meta) return row
  const names = Object.keys(meta.columns)
  const given = Object.keys(row.values)
  const byName = given.every((g) => names.includes(g))
  const values: Record<string, unknown> = {}
  const types: Record<string, string> = {}
  names.forEach((n, i) => {
    const t = columnType(meta.columns[n])
    types[n] = t
    const src = byName ? n : given[i]
    if (src === undefined || !Object.hasOwn(row.values, src)) {
      values[n] = null
      return
    }
    const v = row.values[src]
    const from = row.types[src] ?? guessType(v)
    values[n] = v === null ? null : from === t ? v : cast(v, from === 'unknown' ? 'text' : from, t)
  })
  return new PgRow(values, types)
}

export interface CallSpec {
  name: string
  /** Parameters in order: name (or null) and type. */
  params: Array<{ name: string | null; type: string; value: unknown; s?: number }>
  /** OUT / TABLE parameters (become variables; the result is built from them). */
  outs: Array<{ name: string; type: string }>
  returns: string
  set: boolean
  /** Trigger variables (NEW, OLD, TG_OP, …). */
  trigger?: Record<string, Variable>
}

export class PlCall implements Vars {
  private frames: Frame[] = []
  found = false
  rowCount = 0
  results: unknown[] = []
  returnValue: Typed | null = null
  private errors: DbError[] = []
  private readonly ev: Evaluator

  constructor(readonly engine: Engine, readonly spec: CallSpec) {
    this.ev = new Evaluator(engine, this)
  }

  // ---------------------------------------------------------------- variables

  private find(name: string, frames = this.frames): Variable | undefined {
    for (let i = frames.length - 1; i >= 0; i--) {
      const v = frames[i].vars.get(name)
      if (v) return v
    }
    return undefined
  }

  private frameNamed(label: string): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].label === label) return this.frames[i]
    return undefined
  }

  lookup(parts: string[]): Typed | null {
    if (parts.length === 1) {
      if (parts[0] === 'found') return { t: 'bool', v: this.found }
      const v = this.find(parts[0])
      return v ? this.typedOf(v) : null
    }
    if (parts.length === 2) {
      const v = this.find(parts[0])
      if (v && (v.value instanceof PgRow || v.type === 'record' || isTableType(v.type))) return this.field(v, parts[0], parts[1])
      const f = this.frameNamed(parts[0])
      if (f) {
        const x = f.vars.get(parts[1])
        if (x) return this.typedOf(x)
      }
      return null
    }
    if (parts.length === 3) {
      const f = this.frameNamed(parts[0])
      const v = f?.vars.get(parts[1])
      if (v) return this.field(v, parts[1], parts[2])
    }
    return null
  }

  private typedOf(v: Variable): Typed {
    if (v.value instanceof PgRow) return { t: isTableType(v.type) ? v.type : 'record', v: v.value }
    return { t: v.type, v: v.value, s: v.s }
  }

  private field(v: Variable, name: string, field: string): Typed {
    const row = v.value
    if (row instanceof PgRow) {
      if (!Object.hasOwn(row.values, field)) throw new DbError('42703', `record "${name}" has no field "${field}"`)
      const s = row.scales[field] ?? (isTableType(v.type) ? tableMeta(v.type)?.columns[field]?.scale : undefined)
      return { t: row.types[field] ?? guessType(row.values[field]), v: row.values[field], s }
    }
    if (isTableType(v.type)) {
      const meta = tableMeta(v.type)
      const col = meta?.columns[field]
      if (!col) throw new DbError('42703', `record "${name}" has no field "${field}"`)
      return { t: columnType(col), v: null }
    }
    throw new DbError('55000', `record "${name}" is not assigned yet`)
  }

  private assign(target: Expr, value: Typed): void {
    if (target.k === 'index') {
      const base = target.e
      if (base.k !== 'ref') throw new NotSupported('assigning into a nested element')
      const cur = this.lookup(base.parts)
      if (!cur) throw new DbError('42703', `"${base.parts.join('.')}" is not a known variable`)
      const arr = Array.isArray(cur.v) ? [...cur.v] : []
      const i = Number(this.ev.eval(target.idx!).v) - 1
      while (arr.length < i) arr.push(null)
      arr[i] = value.v === null ? null : cast(value.v, value.t === 'unknown' ? 'text' : value.t, elemType(cur.t))
      this.assign(base, { t: cur.t, v: arr })
      return
    }
    if (target.k !== 'ref') throw new NotSupported('assignment target')
    const parts = target.parts
    let v: Variable | undefined
    let field: string | undefined
    if (parts.length === 1) v = this.find(parts[0])
    else if (parts.length === 2) {
      const first = this.find(parts[0])
      if (first && (first.value instanceof PgRow || first.type === 'record' || isTableType(first.type))) {
        v = first
        field = parts[1]
      } else v = this.frameNamed(parts[0])?.vars.get(parts[1])
    } else if (parts.length === 3) {
      v = this.frameNamed(parts[0])?.vars.get(parts[1])
      field = parts[2]
    }
    if (!v) throw new DbError('42601', `"${parts.join('.')}" is not a known variable`)
    if (v.constant) throw new DbError('22005', `variable "${parts.join('.')}" is declared CONSTANT`)
    if (field !== undefined) {
      let row = v.value instanceof PgRow ? v.value : null
      if (!row) {
        if (!isTableType(v.type)) throw new DbError('55000', `record "${parts[0]}" is not assigned yet`)
        row = emptyRow(v.type)
        v.value = row
      }
      if (!Object.hasOwn(row.types, field) && !Object.hasOwn(row.values, field)) throw new DbError('42703', `record "${parts[0]}" has no field "${field}"`)
      const ft = row.types[field] ?? value.t
      row.values[field] = convert(value, ft)
      if (ft === 'numeric') row.scales[field] = castScale(value, undefined)
      return
    }
    v.value = this.coerceVar(v, value)
    v.s = v.type === 'numeric' && v.value !== null ? castScale(value, v.scale) : undefined
  }

  private coerceVar(v: Variable, value: Typed): unknown {
    if (value.v === null) {
      if (v.notNull) throw new DbError('22004', 'null value cannot be assigned to a variable declared NOT NULL')
      return null
    }
    if (v.type === 'record') {
      if (value.v instanceof PgRow) return value.v
      throw new DbError('42804', 'cannot assign a non-composite value to a record variable')
    }
    if (isTableType(v.type)) {
      if (value.v instanceof PgRow) return value.v.types && Object.keys(value.v.values).length ? toRowType(value.v, v.type) : value.v
      if (value.t === 'jsonb' && value.v && typeof value.v === 'object') return toRowType(new PgRow(value.v as Record<string, unknown>, {}), v.type)
      throw new DbError('42804', `cannot assign ${value.t} to a ${v.type} variable`)
    }
    const out = convert(value, v.type)
    // numeric(p, s) variables round to their scale
    return v.type === 'numeric' && v.scale !== undefined && typeof out === 'number' ? roundScale(out, v.scale) : out
  }

  // ---------------------------------------------------------------- running

  run(body: PlStmt): void {
    const top: Frame = { label: this.spec.name, vars: new Map() }
    this.spec.params.forEach((p, i) => {
      const variable: Variable = { type: p.type, value: p.value, s: p.type === 'numeric' ? p.s : undefined }
      if (p.name) top.vars.set(p.name, variable)
      top.vars.set(`$${i + 1}`, variable)
    })
    for (const o of this.spec.outs) if (!top.vars.has(o.name)) top.vars.set(o.name, { type: o.type, value: null })
    for (const [k, v] of Object.entries(this.spec.trigger ?? {})) top.vars.set(k, v)
    this.frames.push(top)
    try {
      const sig = this.stmt(body)
      if (sig?.k === 'exit' || sig?.k === 'continue') throw new DbError('42601', 'EXIT/CONTINUE outside a loop')
      if (!this.returnValue && !this.spec.set && !this.spec.outs.length && this.spec.returns !== 'void' && this.spec.returns !== 'trigger' && !this.spec.trigger) {
        throw new DbError('2F005', `control reached end of function without RETURN`)
      }
    } finally {
      this.frames.pop()
    }
  }

  /** The OUT parameters as the function's result. */
  outResult(): Typed {
    const outs = this.spec.outs
    if (outs.length === 1) {
      const v = this.find(outs[0].name)!
      return { t: outs[0].type, v: v.value }
    }
    const values: Record<string, unknown> = {}
    const types: Record<string, string> = {}
    for (const o of outs) {
      values[o.name] = this.find(o.name)?.value ?? null
      types[o.name] = o.type
    }
    return { t: 'record', v: new PgRow(values, types) }
  }

  private stmts(list: PlStmt[]): Signal {
    for (const s of list) {
      const sig = this.stmt(s)
      if (sig) return sig
    }
    return null
  }

  private stmt(s: PlStmt): Signal {
    switch (s.k) {
      case 'block': return this.block(s)
      case 'assign':
        this.assign(s.target, this.ev.eval(s.e))
        return null
      case 'if':
        for (const b of s.branches) if (this.ev.truth(this.ev.eval(b.cond))) return this.stmts(b.body)
        return s.else ? this.stmts(s.else) : null
      case 'case': {
        if (s.subject) {
          const subject = this.ev.eval(s.subject)
          for (const w of s.whens) {
            for (const v of w.values) {
              const x = this.ev.eval({ k: 'bin', op: '=', l: { k: 'value', v: subject.v, type: subject.t }, r: v })
              if (x.v === true) return this.stmts(w.body)
            }
          }
        } else {
          for (const w of s.whens) if (this.ev.truth(this.ev.eval(w.values[0]))) return this.stmts(w.body)
        }
        if (s.else) return this.stmts(s.else)
        throw new DbError('20000', 'case not found')
      }
      case 'loop':
        for (;;) {
          const sig = this.stmts(s.body)
          const r = loopSignal(sig, s.label)
          if (r === 'break') break
          if (r !== 'next') return r
        }
        return null
      case 'while':
        while (this.ev.truth(this.ev.eval(s.cond))) {
          const r = loopSignal(this.stmts(s.body), s.label)
          if (r === 'break') break
          if (r !== 'next') return r
        }
        return null
      case 'fori': {
        const lo = Number(this.ev.eval(s.lo).v)
        const hi = Number(this.ev.eval(s.hi).v)
        const step = s.by ? Number(this.ev.eval(s.by).v) : 1
        if (step <= 0) throw new DbError('22023', 'BY value of FOR loop must be greater than zero')
        const frame: Frame = { label: s.label, vars: new Map([[s.var, { type: 'int', value: lo }]]) }
        this.frames.push(frame)
        try {
          for (let i = lo; s.reverse ? i >= hi : i <= hi; i += s.reverse ? -step : step) {
            frame.vars.get(s.var)!.value = i
            const r = loopSignal(this.stmts(s.body), s.label)
            if (r === 'break') break
            if (r !== 'next') return r
          }
        } finally {
          this.frames.pop()
        }
        return null
      }
      case 'forq': {
        let res: ResultSet
        if (s.execute) {
          const sql = this.ev.eval(s.execute.e)
          const params = s.execute.using.map((u) => this.ev.eval(u))
          res = this.dynamic(String(sql.v ?? ''), params)
        } else res = this.sql(s.q!)
        this.found = res.rows.length > 0
        for (let i = 0; i < res.rows.length; i++) {
          this.intoTargets(s.targets, res, i)
          const r = loopSignal(this.stmts(s.body), s.label)
          if (r === 'break') break
          if (r !== 'next') return r
        }
        this.found = res.rows.length > 0
        return null
      }
      case 'foreach': {
        const arr = this.ev.eval(s.arr)
        if (arr.v === null) return null
        if (!Array.isArray(arr.v)) throw new DbError('42804', 'FOREACH expression must yield an array')
        const et = isArrayType(arr.t) ? elemType(arr.t) : 'text'
        for (const item of arr.v) {
          if (s.targets.length === 1) this.assign(s.targets[0], { t: s.slice ? arr.t : et, v: item })
          else {
            const row = item as PgRow
            s.targets.forEach((t, i) => this.assign(t, { t: Object.values(row.types)[i], v: Object.values(row.values)[i] }))
          }
          const r = loopSignal(this.stmts(s.body), s.label)
          if (r === 'break') break
          if (r !== 'next') return r
        }
        return null
      }
      case 'exit':
      case 'continue':
        if (s.when && !this.ev.truth(this.ev.eval(s.when))) return null
        return { k: s.k, label: s.label }
      case 'return': {
        if (this.spec.set) return { k: 'return' }
        if (!s.e) {
          this.returnValue = this.spec.outs.length ? this.outResult() : { t: 'void', v: null }
          return { k: 'return' }
        }
        const v = this.ev.eval(s.e)
        this.returnValue = this.resultValue(v)
        return { k: 'return' }
      }
      case 'return_next': {
        if (!this.spec.set) throw new DbError('42601', 'cannot use RETURN NEXT in a non-SETOF function')
        if (!s.e) this.results.push(this.outResult().v)
        else this.results.push(this.resultValue(this.ev.eval(s.e)).v)
        return null
      }
      case 'return_query': {
        const res = this.sql(s.q)
        for (let i = 0; i < res.rows.length; i++) this.results.push(this.setRow(res, i))
        this.found = res.rows.length > 0
        this.rowCount = res.rows.length
        return null
      }
      case 'raise': return this.raise(s)
      case 'perform': {
        const res = this.sql(s.q)
        this.found = res.count > 0
        this.rowCount = res.count
        return null
      }
      case 'sql': {
        const st = s.st as Statement & { into?: Into }
        const res = this.sql(st)
        this.rowCount = res.count
        const into = st.into
        if (into) {
          const dml = st.k === 'insert' || st.k === 'update' || st.k === 'delete'
          if (res.rows.length > 1 && (into.strict || dml)) throw new DbError('P0003', 'query returned more than one row')
          if (!res.rows.length && into.strict) throw new DbError('P0002', 'query returned no rows')
          this.intoTargets(into.targets, res, 0)
          this.found = res.rows.length > 0
        } else this.found = res.count > 0
        return null
      }
      case 'getdiag':
        for (const it of s.items) this.assign(it.target, this.diagnostic(it.item, s.stacked))
        return null
      case 'execute': {
        const sql = this.ev.eval(s.e)
        if (sql.v === null) throw new DbError('22004', 'query string argument of EXECUTE is null')
        const params = s.using.map((u) => this.ev.eval(u))
        const res = this.dynamic(String(sql.v), params)
        this.rowCount = res.count
        if (s.into) {
          if (res.rows.length > 1 && s.into.strict) throw new DbError('P0003', 'query returned more than one row')
          if (!res.rows.length && s.into.strict) throw new DbError('P0002', 'query returned no rows')
          this.intoTargets(s.into.targets, res, 0)
        }
        this.found = res.count > 0
        return null
      }
      case 'null':
        return null
      case 'assert': {
        const c = this.ev.eval(s.cond)
        if (c.v !== true) {
          const msg = s.msg ? String(this.ev.eval(s.msg).v ?? '') : 'assertion failed'
          throw new DbError('P0004', msg)
        }
        return null
      }
      case 'utility': {
        if (s.word === 'set') return null
        throw new NotSupported(`${s.word.toUpperCase()} inside a function (${s.src.slice(0, 60)})`)
      }
    }
  }

  private sql(st: Statement): ResultSet {
    return execStatement(this.engine, st, this, [])
  }

  private dynamic(text: string, params: Typed[]): ResultSet {
    const p = new Parser(lex(text), text, {})
    const st = p.statement()
    p.eatPunct(';')
    if (p.peek().k !== 'eof') throw new NotSupported('EXECUTE with several statements')
    return execStatement(this.engine, st, this, params)
  }

  /** A row of a query as the function's set element (scalar for one column of a scalar result). */
  private setRow(res: ResultSet, i: number): unknown {
    const ret = this.spec.returns
    if (this.spec.outs.length > 1 || ret === 'record' || isTableType(ret)) {
      const row = rowOf(res, i)
      if (this.spec.outs.length > 1) {
        const values: Record<string, unknown> = {}
        const types: Record<string, string> = {}
        this.spec.outs.forEach((o, j) => {
          const v = res.rows[i][j] ?? null
          const from = res.cols[j]?.t ?? 'unknown'
          values[o.name] = v === null ? null : from === o.type ? v : cast(v, from === 'unknown' ? 'text' : from, o.type)
          types[o.name] = o.type
        })
        return new PgRow(values, types)
      }
      return isTableType(ret) ? toRowType(row, ret) : row
    }
    const v = res.rows[i][0] ?? null
    return convert({ t: res.cols[0]?.t ?? 'unknown', v }, ret)
  }

  private resultValue(v: Typed): Typed {
    const ret = this.spec.trigger ? 'trigger' : this.spec.returns
    if (ret === 'trigger' || ret === 'record' || ret === 'void') return v
    if (isTableType(ret)) {
      if (v.v === null) return { t: ret, v: null }
      if (v.v instanceof PgRow) return { t: ret, v: toRowType(v.v, ret) }
      return v
    }
    return { t: ret, v: convert(v, ret), s: ret === 'numeric' ? castScale(v, undefined) : undefined }
  }

  private intoTargets(targets: Expr[], res: ResultSet, i: number): void {
    const row = res.rows[i]
    if (targets.length === 1) {
      const t = targets[0]
      const v = t.k === 'ref' ? (t.parts.length === 1 ? this.find(t.parts[0]) : undefined) : undefined
      if (v && (v.type === 'record' || isTableType(v.type))) {
        if (!row) {
          v.value = v.type === 'record' ? new PgRow(Object.fromEntries(res.cols.map((c) => [c.name, null])), Object.fromEntries(res.cols.map((c) => [c.name, c.t]))) : null
          return
        }
        const r = rowOf(res, i)
        // a single column that is itself a row (SELECT t INTO v FROM t)
        if (res.cols.length === 1 && row[0] instanceof PgRow) {
          v.value = v.type === 'record' ? row[0] : toRowType(row[0] as PgRow, v.type)
          return
        }
        v.value = v.type === 'record' ? r : toRowType(r, v.type)
        return
      }
    }
    targets.forEach((t, j) => {
      const value = row ? row[j] ?? null : null
      this.assign(t, { t: res.cols[j]?.t ?? 'unknown', v: value, s: res.cols[j]?.s })
    })
  }

  private block(s: Extract<PlStmt, { k: 'block' }>): Signal {
    const frame: Frame = { label: s.label, vars: new Map() }
    this.frames.push(frame)
    try {
      for (const d of s.decls) this.declare(frame, d)
      if (!s.handlers) return this.stmts(s.body)
      try {
        return this.engine.sql.transaction(() => this.stmts(s.body))
      } catch (e) {
        if (!(e instanceof DbError)) throw e
        const h = s.handlers.find((x) => matches(x.conditions, e.code))
        if (!h) throw e
        return this.handle(h, e)
      }
    } finally {
      this.frames.pop()
    }
  }

  private handle(h: Handler, e: DbError): Signal {
    const frame: Frame = { vars: new Map([['sqlstate', { type: 'text', value: e.code }], ['sqlerrm', { type: 'text', value: e.message }]]) }
    this.frames.push(frame)
    this.errors.push(e)
    try {
      return this.stmts(h.body)
    } finally {
      this.errors.pop()
      this.frames.pop()
    }
  }

  private declare(frame: Frame, d: Decl): void {
    if (d.alias !== undefined) {
      const p = this.frames[0].vars.get(`$${d.alias}`)
      if (!p) throw new DbError('42601', `there is no parameter $${d.alias}`)
      frame.vars.set(d.name, p)
      return
    }
    let type: string
    let scale = d.type.scale
    if (d.type.pct === 'rowtype') type = d.type.name
    else if (d.type.pct === 'type') {
      if (d.type.column) {
        const meta = tableMeta(d.type.name)
        const col = meta?.columns[d.type.column]
        if (!col) throw new DbError('42703', `column ${d.type.name}.${d.type.column} does not exist`)
        type = columnType(col)
        scale = col.scale
      } else type = this.find(d.type.name)?.type ?? 'text'
    } else type = d.type.array ? `${d.type.name}[]` : d.type.name
    const v: Variable = { type, value: null, notNull: d.notNull, scale: type === 'numeric' ? scale : undefined }
    frame.vars.set(d.name, v)
    if (d.default) {
      const x = this.ev.eval(d.default)
      v.value = this.coerceVar(v, x)
      v.s = type === 'numeric' && v.value !== null ? castScale(x, v.scale) : undefined
    } else if (d.notNull) throw new DbError('22004', `variable "${d.name}" must have a default value, since it's declared NOT NULL`)
    v.constant = d.constant
  }

  private diagnostic(item: string, stacked: boolean): Typed {
    const e = this.errors[this.errors.length - 1]
    switch (item) {
      case 'row_count': return { t: 'int', v: this.rowCount }
      case 'pg_context': return { t: 'text', v: '' }
      case 'returned_sqlstate': return { t: 'text', v: e?.code ?? null }
      case 'message_text': return { t: 'text', v: e?.message ?? null }
      case 'pg_exception_detail': return { t: 'text', v: e?.details ?? '' }
      case 'pg_exception_hint': return { t: 'text', v: e?.hint ?? '' }
      case 'pg_exception_context': return { t: 'text', v: '' }
      case 'column_name': case 'constraint_name': case 'pg_datatype_name': case 'table_name': case 'schema_name':
        return { t: 'text', v: '' }
      default:
        if (!stacked) return { t: 'text', v: null }
        throw new DbError('42601', `unrecognized GET DIAGNOSTICS item ${item}`)
    }
  }

  private raise(s: Extract<PlStmt, { k: 'raise' }>): Signal {
    if (!s.fmt && !s.condition && !s.sqlstate && !s.options.length) {
      const e = this.errors[this.errors.length - 1]
      if (!e) throw new DbError('0Z002', 'RAISE without parameters cannot be used outside an exception handler')
      throw e
    }
    let message: string | null = null
    if (s.fmt !== undefined) {
      const args = s.args.map((a) => this.ev.eval(a))
      let i = 0
      message = s.fmt.replace(/%%|%/g, (m) => {
        if (m === '%%') return '%'
        const a = args[i++]
        if (!a) throw new DbError('42601', 'too few parameters specified for RAISE')
        return a.v === null ? '<NULL>' : toText(a.v, a.t === 'unknown' ? 'text' : a.t, a.s)
      })
    }
    let code = s.sqlstate ?? (s.condition ? sqlstateOf(s.condition) : 'P0001')
    let detail: string | null = null
    let hint: string | null = null
    for (const o of s.options) {
      const v = this.ev.eval(o.e)
      const text = v.v === null ? null : toText(v.v, v.t === 'unknown' ? 'text' : v.t, v.s)
      switch (o.name) {
        case 'message': message = text; break
        case 'errcode': code = sqlstateOf(text ?? 'P0001'); break
        case 'detail': detail = text; break
        case 'hint': hint = text; break
      }
    }
    if (s.level !== 'exception') return null
    throw new DbError(code, message ?? (s.condition ?? code), detail, hint)
  }
}

function loopSignal(sig: Signal, label: string | undefined): 'next' | 'break' | Signal {
  if (!sig) return 'next'
  if (sig.k === 'return') return sig
  if (sig.label && sig.label !== label) return sig
  return sig.k === 'exit' ? 'break' : 'next'
}

function emptyRow(table: string): PgRow {
  const meta = tableMeta(table)!
  const values: Record<string, unknown> = {}
  const types: Record<string, string> = {}
  for (const [c, m] of Object.entries(meta.columns)) {
    values[c] = null
    types[c] = columnType(m)
  }
  return new PgRow(values, types)
}

/** Assignment conversion of a value to a declared type. */
export function convert(v: Typed, to: string): unknown {
  if (v.v === null) return null
  if (to === 'anyelement' || to === 'record' || to === 'unknown') return v.v
  if (v.t === to) return v.v
  if ((v.t === 'int' || v.t === 'numeric') && to === 'numeric') return v.v
  if (isTableType(to)) return v.v instanceof PgRow ? toRowType(v.v, to) : v.v
  return cast(v.v, v.t === 'unknown' ? 'text' : v.t, to)
}

// The database functions as the app calls them: the catalog of the migrations'
// functions (generated/functions.json), a few native ones that answer "who is
// asking" from the request (context.ts), auth.* and vault.*, and the interpreter for
// the rest. Also the bridge for business triggers the data layer fires.
import { randomUUID } from 'node:crypto'
import type { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import functionSources from '../generated/functions.json'
import { table as tableMeta, view, type TriggerMeta } from '../meta.ts'
import { setViewCompiler } from '../policy.ts'
import type { DbRole } from '../policy.ts'
import type { Sql } from '../sql.ts'
import { setTriggerFallback, type TriggerImpl, type Values } from '../writer.ts'
import type { Expr, Query, Select, Statement } from './ast.ts'
import { columnType, setRowTypes } from './bridge.ts'
import { setFunctionGrants } from './builtins.ts'
import { Compiler } from './compile.ts'
import { Evaluator } from './evaluate.ts'
import { lex } from './lex.ts'
import { Parser } from './parse.ts'
import { parseFunction, type PlStmt } from './plparse.ts'
import { convert, PlCall, rowOf, toRowType, type Variable } from './plpgsql.ts'
import { execStatement, tableRow } from './query.ts'
import { NotSupported, NO_VARS, type Engine, type Inline, type Typed, type Vars } from './runtime.ts'
import { normType } from './types.ts'
import { cast, castScale, isTableType, JNULL, PgRow, plainValue } from './values.ts'

interface RawFn {
  lang: 'sql' | 'plpgsql'
  src: string
  args: Array<{ name: string | null; type: string; mode: string }>
  defaults?: string
  returns: string
  set: boolean
  definer: boolean
  owner: string
  volatility: string
  config: string[]
  grants: string[]
}

export interface FnDef extends RawFn {
  name: string
  ins: Array<{ name: string | null; type: string }>
  outs: Array<{ name: string; type: string }>
  ret: string
  defaultExprs?: Expr[]
  body?: { sql?: Statement[]; pl?: PlStmt }
}

const catalog = new Map<string, FnDef[]>()
for (const [name, list] of Object.entries(functionSources as unknown as Record<string, RawFn[]>)) {
  catalog.set(name, list.map((f) => {
    const ins = f.args.filter((a) => ['i', 'b', 'v'].includes(a.mode)).map((a) => ({ name: a.name, type: normArg(a.type) }))
    const outs = f.args.filter((a) => ['o', 'b', 't'].includes(a.mode)).map((a, i) => ({ name: a.name ?? `column${i + 1}`, type: normArg(a.type) }))
    return { ...f, name, ins, outs, ret: normArg(f.returns) }
  }))
}

function normArg(t: string): string {
  const arr = t.endsWith('[]')
  const base = normType(arr ? t.slice(0, -2) : t)
  return arr ? `${base}[]` : base
}

setFunctionGrants((name) => {
  const defs = catalog.get(name)
  return defs ? [...new Set(defs.flatMap((d) => d.grants))] : null
})

setRowTypes((t) => {
  const meta = tableMeta(t)
  return meta ? Object.fromEntries(Object.entries(meta.columns).map(([c, m]) => [c, columnType(m)])) : null
})

export function functionDefs(name: string): FnDef[] | undefined {
  return catalog.get(name)
}

function parseDefaults(f: FnDef): Expr[] {
  if (f.defaultExprs) return f.defaultExprs
  const out: Expr[] = []
  if (f.defaults) {
    const p = new Parser(lex(f.defaults), f.defaults)
    do out.push(p.expr()); while (p.eatPunct(','))
  }
  f.defaultExprs = out
  return out
}

function bodyOf(f: FnDef): { sql?: Statement[]; pl?: PlStmt } {
  if (!f.body) {
    if (f.lang === 'sql') {
      const p = new Parser(lex(f.src), f.src, {})
      f.body = { sql: p.statements() }
    } else f.body = { pl: parseFunction(f.src) }
  }
  return f.body
}

/** Picks the overload for the given arguments. */
function resolve(name: string, argTypes: string[], names?: Array<string | null>): FnDef | null {
  const list = catalog.get(name)
  if (!list) return null
  const named = names?.filter((n) => n !== null) ?? []
  const fits = list.filter((f) => {
    const positional = names ? names.filter((n) => n === null).length : argTypes.length
    if (positional > f.ins.length) return false
    for (const n of named) if (!f.ins.some((a) => a.name === n)) return false
    const required = f.ins.length - parseDefaults(f).length
    const given = new Set<number>()
    for (let i = 0; i < positional; i++) given.add(i)
    for (const n of named) given.add(f.ins.findIndex((a) => a.name === n))
    for (let i = 0; i < required; i++) if (!given.has(i)) return false
    return true
  })
  if (fits.length <= 1) return fits[0] ?? null
  // several overloads: the one whose declared types match best
  const score = (f: FnDef) => argTypes.reduce((s, t, i) => s + (f.ins[i]?.type === t ? 2 : t === 'unknown' ? 1 : 0), 0) - Math.abs(f.ins.length - argTypes.length) / 10
  return [...fits].sort((a, b) => score(b) - score(a))[0]
}

/** Functions answered from the request instead of running their SQL (they decide who is asking). */
const NATIVE: Record<string, (ctx: Context, args: Typed[]) => Typed> = {
  current_merchant_id: (ctx) => ({ t: 'uuid', v: ctx.merchantId() }),
  has_permission: (ctx, a) => ({ t: 'bool', v: a[0]?.v === null ? false : ctx.hasPermission(String(a[0].v)) }),
  is_staff: (ctx) => ({ t: 'bool', v: ctx.isStaff() }),
  is_platform_staff: (ctx) => ({ t: 'bool', v: ctx.isPlatformStaff() }),
  current_role_code: (ctx) => ({ t: 'text', v: ctx.roleCode() }),
  is_system_context: (ctx) => ({ t: 'bool', v: ctx.isSystem() }),
  _support_session_id: (ctx) => ({ t: 'uuid', v: ctx.supportSessionId() }),
  _support_read_only: (ctx) => ({ t: 'bool', v: ctx.supportReadOnly() }),
  merchant_access_mode: (ctx, a) => ({ t: 'text', v: ctx.accessMode(a[0]?.v == null ? ctx.merchantId() : String(a[0].v)) }),
  _device_ok: (ctx, a) => ({ t: 'bool', v: ctx.deviceOk(String(a[0].v), String(a[1].v)) }),
}

export class PgEngine implements Engine {
  constructor(readonly sql: Sql, readonly ctx: Context, public role: DbRole) {}

  roleName(): string {
    if (this.role === 'service_role' && this.ctx.identity.system) return 'postgres'
    return this.role
  }

  returnType(name: string, argTypes: string[], schema?: string): string | null {
    if (schema && schema !== 'public') return null
    if (NATIVE[name]) return name === 'has_permission' || name === 'is_staff' || name.startsWith('is_') || name.endsWith('_ok') || name === '_support_read_only' ? 'bool' : name === 'current_merchant_id' || name === '_support_session_id' ? 'uuid' : 'text'
    const f = resolve(name, argTypes)
    if (!f) return null
    return f.set ? `setof ${f.ret}` : f.ret
  }

  resultColumns(name: string, argTypes: string[]): Array<{ name: string; type: string }> | null {
    const f = resolve(name, argTypes)
    if (!f) return null
    if (f.outs.length > 1 || (f.outs.length === 1 && f.ret === 'record')) return f.outs.map((o) => ({ name: o.name, type: o.type }))
    if (isTableType(f.ret)) {
      const meta = tableMeta(f.ret)
      if (meta) return Object.entries(meta.columns).map(([c, m]) => ({ name: c, type: columnType(m) }))
    }
    return null
  }

  volatile(name: string, argTypes: string[]): boolean {
    return resolve(name, argTypes)?.volatility === 'v'
  }

  inline(name: string, argTypes: string[]): Inline | null {
    if (NATIVE[name]) return null
    const f = resolve(name, argTypes)
    if (!f || f.lang !== 'sql') return null
    const body = bodyOf(f).sql!
    if (body.length !== 1 || body[0].k !== 'select') return null
    return {
      q: body[0] as Select,
      params: f.ins.map((a, i) => a.name ?? `$${i + 1}`),
      types: f.ins.map((a) => a.type),
      bypass: f.definer && f.owner !== 'app_owner',
    }
  }

  call(name: string, args: Typed[], names?: Array<string | null>, schema?: string): Typed {
    if (schema === 'auth') return this.auth(name)
    if (schema === 'vault') return this.vault(name, args, names)
    if (schema && schema !== 'public') throw new DbError('42883', `function ${schema}.${name} does not exist`)
    if (NATIVE[name]) return NATIVE[name](this.ctx, this.bindArgs(name, args, names))
    const f = resolve(name, args.map((a) => a.t), names)
    if (!f) {
      if (!catalog.has(name)) throw new DbError('42883', `function ${name}(${args.map((a) => a.t).join(', ')}) does not exist`)
      throw new DbError('42883', `function ${name}(${args.map((a) => a.t).join(', ')}) does not exist`, null, 'No function matches the given name and argument types.')
    }
    return this.invoke(f, args, names)
  }

  /** Arguments of a native function in declared order (names resolved, defaults filled). */
  private bindArgs(name: string, args: Typed[], names?: Array<string | null>): Typed[] {
    const f = resolve(name, args.map((a) => a.t), names)
    if (!f) return args
    return this.argValues(f, args, names)
  }

  private argValues(f: FnDef, args: Typed[], names?: Array<string | null>): Typed[] {
    const out: Array<Typed | undefined> = new Array(f.ins.length).fill(undefined)
    args.forEach((a, i) => {
      const n = names?.[i]
      const idx = n ? f.ins.findIndex((p) => p.name === n) : i
      if (idx < 0) throw new DbError('42883', `function ${f.name} has no parameter named "${n}"`)
      out[idx] = a
    })
    const defaults = parseDefaults(f)
    const first = f.ins.length - defaults.length
    const ev = new Evaluator(this, NO_VARS)
    return out.map((a, i) => {
      const p = f.ins[i]
      if (a === undefined) {
        if (i < first) throw new DbError('42883', `function ${f.name} requires argument ${p.name ?? i + 1}`)
        a = ev.eval(defaults[i - first])
      }
      if (a.v === null) return { t: p.type, v: null }
      try {
        return { t: p.type, v: convert(a, p.type), s: p.type === 'numeric' ? castScale(a, undefined) : undefined }
      } catch (e) {
        if (e instanceof DbError) throw e
        throw e
      }
    })
  }

  private checkGrant(f: FnDef): void {
    if (this.role !== 'anon' && this.role !== 'authenticated') return
    if (!f.grants.includes(this.role)) throw new DbError('42501', `permission denied for function ${f.name}`)
  }

  invoke(f: FnDef, args: Typed[], names?: Array<string | null>, trigger?: Record<string, Variable>): Typed {
    if (!trigger) this.checkGrant(f)
    const values = trigger ? [] : this.argValues(f, args, names)
    const saved = this.role
    if (f.definer) this.role = f.owner === 'app_owner' ? 'app_owner' : 'service_role'
    try {
      const body = bodyOf(f)
      if (body.sql) {
        try {
          return this.runSqlFunction(f, body.sql, values)
        } catch (e) {
          if (e instanceof NotSupported && !e.message.includes(' [in ')) throw new NotSupported(`${e.message} [in ${f.name}]`)
          throw e
        }
      }
      const call = new PlCall(this, {
        name: f.name,
        params: f.ins.map((p, i) => ({ name: p.name, type: p.type, value: values[i]?.v ?? null, s: values[i]?.s })),
        outs: f.outs.filter((o) => !f.ins.some((p) => p.name === o.name) || true).filter((o) => f.args.some((a) => a.name === o.name && a.mode !== 'i')),
        returns: f.ret,
        set: f.set,
        trigger,
      })
      try {
        call.run(body.pl!)
      } catch (e) {
        if (e instanceof NotSupported && !e.message.includes(' [in ')) throw new NotSupported(`${e.message} [in ${f.name}]`)
        throw e
      }
      if (f.set) return { t: `setof ${f.ret}`, v: call.results }
      if (call.returnValue) return call.returnValue
      if (call.spec.outs.length) return call.outResult()
      return { t: f.ret, v: null }
    } finally {
      this.role = saved
    }
  }

  private runSqlFunction(f: FnDef, statements: Statement[], values: Typed[]): Typed {
    const vars: Vars = {
      lookup: (parts) => {
        if (parts.length === 1) {
          const m = /^\$(\d+)$/.exec(parts[0])
          const i = m ? Number(m[1]) - 1 : f.ins.findIndex((p) => p.name === parts[0])
          if (i >= 0 && i < values.length) return values[i]
        }
        if (parts.length === 2 && parts[0] === f.name) {
          const i = f.ins.findIndex((p) => p.name === parts[1])
          if (i >= 0) return values[i]
        }
        if (parts.length === 2) {
          // a field of a composite parameter (p_channel.settings)
          const i = f.ins.findIndex((p) => p.name === parts[0])
          const row = i >= 0 ? values[i]?.v : undefined
          if (row instanceof PgRow) {
            if (!Object.hasOwn(row.values, parts[1])) throw new DbError('42703', `column ${parts.join('.')} does not exist`)
            return { t: row.types[parts[1]] ?? 'unknown', v: row.values[parts[1]] }
          }
          if (i >= 0 && row === null && isTableType(f.ins[i].type)) return { t: columnType(tableMeta(f.ins[i].type)!.columns[parts[1]]), v: null }
        }
        return null
      },
    }
    let last = null as ReturnType<typeof execStatement> | null
    for (const st of statements) last = execStatement(this, st, vars, values)
    const ret = f.ret
    if (!last || ret === 'void') return { t: ret, v: null }
    const composite = f.outs.length > 1 || ret === 'record' || isTableType(ret)
    const value = (i: number): unknown => {
      if (composite) {
        if (last!.cols.length === 1 && last!.rows[i][0] instanceof PgRow) {
          const r = last!.rows[i][0] as PgRow
          return isTableType(ret) ? toRowType(r, ret) : r
        }
        const row = rowOf(last!, i)
        if (f.outs.length) {
          const vals: Record<string, unknown> = {}
          const types: Record<string, string> = {}
          f.outs.forEach((o, j) => {
            const v = last!.rows[i][j] ?? null
            const from = last!.cols[j]?.t ?? 'unknown'
            vals[o.name] = v === null ? null : convert({ t: from, v }, o.type)
            types[o.name] = o.type
          })
          return new PgRow(vals, types)
        }
        return isTableType(ret) ? toRowType(row, ret) : row
      }
      return convert({ t: last!.cols[0]?.t ?? 'unknown', v: last!.rows[i][0] ?? null }, ret)
    }
    if (f.set) return { t: `setof ${ret}`, v: last.rows.map((_, i) => value(i)) }
    const s = ret === 'numeric' && !composite ? castScale({ t: last.cols[0]?.t ?? 'unknown', v: null, s: last.cols[0]?.s }, undefined) : undefined
    if (!last.rows.length) return { t: composite && f.outs.length > 1 ? 'record' : ret, v: null, s }
    return { t: composite && f.outs.length > 1 ? 'record' : ret, v: value(0), s }
  }

  // ---------------------------------------------------------------- auth.* and vault.*

  private auth(name: string): Typed {
    switch (name) {
      case 'uid': return { t: 'uuid', v: this.ctx.uid }
      case 'jwt': {
        const c = this.ctx.claims()
        return { t: 'jsonb', v: c }
      }
      case 'role': return { t: 'text', v: (this.ctx.claims()?.role as string | undefined) ?? null }
      case 'email': return { t: 'text', v: this.ctx.identity.email ?? null }
      default: throw new DbError('42883', `function auth.${name} does not exist`)
    }
  }

  private vault(name: string, args: Typed[], names?: Array<string | null>): Typed {
    if (this.role === 'anon' || this.role === 'authenticated') throw new DbError('42501', 'permission denied for schema vault')
    const arg = (i: number, n: string): unknown => {
      const k = names?.indexOf(n) ?? -1
      const a = k >= 0 ? args[k] : names?.[i] ? undefined : args[i]
      return a?.v ?? null
    }
    if (name === 'create_secret') {
      const id = randomUUID()
      this.sql.run(`INSERT INTO _vault_secrets (id, secret, name, description) VALUES (?, ?, ?, ?)`, [
        id, String(arg(0, 'new_secret')), (arg(1, 'new_name') as string | null) ?? null, String(arg(2, 'new_description') ?? ''),
      ])
      return { t: 'uuid', v: id }
    }
    if (name === 'update_secret') {
      this.sql.run(`UPDATE _vault_secrets SET secret = coalesce(?, secret), name = coalesce(?, name), description = coalesce(?, description),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, [
        (arg(1, 'new_secret') as string | null) ?? null, (arg(2, 'new_name') as string | null) ?? null, (arg(3, 'new_description') as string | null) ?? null,
        String(arg(0, 'secret_id')),
      ])
      return { t: 'void', v: null }
    }
    throw new DbError('42883', `function vault.${name} does not exist`)
  }
}

// ---------------------------------------------------------------- triggers

/** A business trigger run by the interpreter (when no TypeScript port exists). */
function interpretedTrigger(fnName: string): TriggerImpl | undefined {
  const f = catalog.get(fnName)?.[0]
  if (!f || f.lang !== 'plpgsql') return undefined
  const run = (e: Parameters<NonNullable<TriggerImpl['before']>>[0]): Values | null | void => {
    const engine = new PgEngine(e.env.sql, e.env.ctx, e.env.role)
    const tg = e.trigger as TriggerMeta
    const newRow = e.new ? tableRow(e.table, e.new) : null
    const oldRow = e.old ? tableRow(e.table, e.old) : null
    if (tg.when && !whenHolds(engine, tg.when, newRow, oldRow)) return undefined
    const vars: Record<string, Variable> = {
      new: { type: e.table, value: newRow },
      old: { type: e.table, value: oldRow },
      tg_op: { type: 'text', value: e.op },
      tg_name: { type: 'text', value: tg.name },
      tg_table_name: { type: 'text', value: e.table },
      tg_relname: { type: 'text', value: e.table },
      tg_table_schema: { type: 'text', value: 'public' },
      tg_when: { type: 'text', value: tg.timing },
      tg_level: { type: 'text', value: 'ROW' },
      tg_argv: { type: 'text[]', value: tg.args },
      tg_nargs: { type: 'int', value: tg.args.length },
    }
    const result = engine.invoke(f, [], undefined, vars)
    if (tg.timing !== 'BEFORE') return undefined
    const r = result.v
    if (r === null || r === undefined) return null
    if (!(r instanceof PgRow)) throw new DbError('42804', 'a BEFORE trigger must return a row or NULL')
    const out: Values = {}
    for (const [k, v] of Object.entries(r.values)) out[k] = v === JNULL ? JNULL : plainValue(v)
    return out
  }
  return { before: run, after: (e) => void run(e) }
}

const whenCache = new Map<string, Expr>()
function whenHolds(engine: PgEngine, when: string, newRow: PgRow | null, oldRow: PgRow | null): boolean {
  let e = whenCache.get(when)
  if (!e) {
    const p = new Parser(lex(when), when)
    e = p.expr()
    whenCache.set(when, e)
  }
  const vars: Vars = {
    lookup: (parts) => {
      const row = parts[0] === 'new' ? newRow : parts[0] === 'old' ? oldRow : null
      if (!row || parts.length !== 2) return null
      return { t: row.types[parts[1]], v: row.values[parts[1]] }
    },
  }
  return new Evaluator(engine, vars).truth(new Evaluator(engine, vars).eval(e))
}

setTriggerFallback(interpretedTrigger)

// Views whose Postgres definition the converter could not translate: compiled per request.
const viewAsts = new Map<string, Query>()
const compiledViews = new WeakMap<Context, Map<string, string>>()
setViewCompiler((name, ctx, role) => {
  const pg = view(name)?.pg
  if (!pg) return undefined
  let perCtx = compiledViews.get(ctx)
  if (!perCtx) {
    perCtx = new Map()
    compiledViews.set(ctx, perCtx)
  }
  const key = `${role}:${name}`
  const done = perCtx.get(key)
  if (done) return done
  let ast = viewAsts.get(name)
  if (!ast) {
    const text = pg.trim().replace(/;$/, '')
    ast = new Parser(lex(text), text).query()
    viewAsts.set(name, ast)
  }
  const engine = new PgEngine(ctx.sql, ctx, role)
  const sql = new Compiler(engine, NO_VARS, [], { literal: true }).query(ast, null).sql
  perCtx.set(key, sql)
  return sql
})

/** Raised by the engine for constructs it cannot run; surfaced as feature_not_supported. */
export function asDbError(e: unknown): unknown {
  if (e instanceof NotSupported) return new DbError('0A000', `NOT_SUPPORTED: ${e.message}`)
  return e
}

export { cast }

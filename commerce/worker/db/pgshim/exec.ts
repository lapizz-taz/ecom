// Test adapter: runs the Postgres test suite's SQL (supabase/tests/db) against the
// Cloudflare database. Session commands set who is asking; calls to database
// functions go to their TypeScript ports; table SQL is translated to SQLite and run
// with the caller's row security; writes go through the data layer so triggers,
// checks and the audit trail behave as in production. Test-only: never bundled.
import { randomUUID } from 'node:crypto'
import { match, readType, render, rewrite, splitTop, tokenize, type Token } from '../../../scripts/pg-sqlite/translate.mjs'
import { decode, toTimestamp, type SqlValue } from '../codec.ts'
import { Context } from '../context.ts'
import { DbError } from '../errors.ts'
import { quoteId } from '../ident.ts'
import { fn as fnMeta, schema, table, type ColumnMeta } from '../meta.ts'
import { fill, mentioned, secure, type DbRole } from '../policy.ts'
import { callRpc } from '../rpc/index.ts'
import type { Row, Sql } from '../sql.ts'
import { insert, keyWhere, remove, update, type Key, type Values, type WriteEnv } from '../writer.ts'

export interface QueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number
  command: string
}

type Tok = Token & { name?: string }

const lower = (t: Tok | undefined) => (t && t.t === 'id' ? String(t.v) : '')
const isKw = (t: Tok | undefined, ...kw: string[]) => !!t && t.t === 'id' && !t.quoted && kw.includes(String(t.v))

/** Postgres array text {a,"b c"} → items. */
function pgArray(text: string): Array<string | null> {
  const inner = text.trim().replace(/^\{|\}$/g, '')
  if (!inner) return []
  return JSON.parse(`[${inner.split(',').map((x) => {
    const v = x.trim()
    if (v.toUpperCase() === 'NULL') return 'null'
    return JSON.stringify(v.replace(/^"|"$/g, ''))
  }).join(',')}]`)
}

function castValue(v: unknown, type: string, array: boolean): unknown {
  if (v === null || v === undefined) return null
  if (array) {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? (v.trim().startsWith('[') ? JSON.parse(v) : pgArray(v)) : [v]
    return list.map((x: unknown) => castValue(x, type, false))
  }
  switch (type) {
    case 'jsonb': case 'json':
      return typeof v === 'string' ? JSON.parse(v) : v
    case 'uuid': return String(v).toLowerCase()
    case 'integer': case 'int': case 'int4': case 'bigint': case 'int8': case 'smallint':
      return Math.trunc(Number(v))
    case 'numeric': case 'double precision': case 'real': case 'float8': return Number(v)
    case 'boolean': case 'bool': return v === true || v === 't' || v === 'true' || v === 1 || v === '1'
    case 'text': case 'character varying': case 'varchar': return typeof v === 'object' ? JSON.stringify(v) : String(v)
    case 'timestamp with time zone': case 'timestamptz': return v instanceof Date ? v.toISOString() : toTimestamp(v)
    case 'date': return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
    default: return typeof v === 'object' && !(v instanceof Date) ? v : v instanceof Date ? v.toISOString() : String(v)
  }
}

/** A JS value bound into SQLite. */
function bind(v: unknown): SqlValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return v as SqlValue
}

function stripParens(t: Tok[]): Tok[] {
  while (t.length >= 2 && t[0].t === '(' && match(t, 0) === t.length - 1) t = t.slice(1, -1)
  return t
}

/** Splits a statement list on top-level semicolons. */
function statements(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ';' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const JSON_PRODUCERS = new Set(['array_agg', 'jsonb_agg', 'json_agg', 'to_jsonb', 'row_to_json', 'jsonb_build_object', 'json_build_object', 'jsonb_build_array', 'jsonb_object_agg'])

export class Session {
  role: 'postgres' | 'service_role' | 'authenticated' | 'anon' = 'postgres'
  claims: Record<string, unknown> = {}
  settings = new Map<string, string>()
  replica = false

  constructor(readonly sql: Sql) {}

  context(): Context {
    const headers = (() => {
      try {
        return JSON.parse(this.settings.get('request.headers') || '{}') as Record<string, string>
      } catch {
        return {}
      }
    })()
    const role = this.role === 'postgres' ? 'service_role' : this.role
    const c = this.claims
    const ctx = new Context(this.sql, {
      role,
      uid: role === 'authenticated' ? ((c.sub as string | undefined) ?? null) : null,
      sessionId: (c.session_id as string | undefined) ?? null,
      email: (c.email as string | undefined) ?? null,
      merchantHeader: headers['x-merchant-id'] ?? null,
      merchantSetting: this.settings.get('app.merchant_id') || null,
      userAgent: headers['user-agent'] ?? null,
      ip: headers['x-forwarded-for'] ?? null,
    })
    for (const [k, v] of this.settings) if (k.startsWith('app.') && v) ctx.flags.set(k.slice(4), v)
    return ctx
  }

  private dbRole(): DbRole {
    return this.role === 'postgres' ? 'service_role' : this.role
  }

  query(text: string, params: unknown[] = []): QueryResult {
    let last: QueryResult = { rows: [], rowCount: 0, command: '' }
    for (const st of statements(text)) last = this.one(st, params)
    return last
  }

  private one(text: string, params: unknown[]): QueryResult {
    const tokens = tokenize(text) as Tok[]
    const head = lower(tokens[0])
    const empty = (command: string): QueryResult => ({ rows: [], rowCount: 0, command })
    if (head === 'begin' || head === 'commit' || head === 'start') return empty(head.toUpperCase())
    if (head === 'savepoint') {
      this.sql.script(`SAVEPOINT ${lower(tokens[1])}`)
      return empty('SAVEPOINT')
    }
    if (head === 'release') {
      this.sql.script(`RELEASE ${lower(tokens[tokens.length - 1])}`)
      return empty('RELEASE')
    }
    if (head === 'rollback') {
      if (isKw(tokens[1], 'to')) this.sql.script(`ROLLBACK TO ${lower(tokens[tokens.length - 1])}`)
      return empty('ROLLBACK')
    }
    if (head === 'reset' && isKw(tokens[1], 'role')) {
      this.role = 'postgres'
      return empty('RESET')
    }
    if (head === 'set') {
      const rest = tokens.slice(isKw(tokens[1], 'local', 'session') ? 2 : 1)
      if (isKw(rest[0], 'role')) this.role = lower(rest[1]) as Session['role']
      else if (lower(rest[0]) === 'session_replication_role') this.replica = lower(rest[rest.length - 1]) === 'replica'
      return empty('SET')
    }
    if (head === 'select' || head === 'with') return this.select(tokens, params)
    if (head === 'insert') return this.insert(tokens, params)
    if (head === 'update') return this.update(tokens, params)
    if (head === 'delete') return this.remove(tokens, params)
    throw new Error(`pgshim: unsupported statement: ${text.slice(0, 120)}`)
  }

  // ---------------------------------------------------------------- values

  /** A function call at tokens[i] ([public .] name '('), or null. */
  private callAt(t: Tok[], i: number): { start: number; name: string; open: number } | null {
    if (t[i]?.t !== 'id') return null
    if (lower(t[i]) === 'public' && t[i + 1]?.t === '.' && t[i + 2]?.t === 'id' && t[i + 3]?.t === '(') return { start: i, name: lower(t[i + 2]), open: i + 3 }
    if (t[i - 1]?.t === '.') return null
    const name = lower(t[i])
    if (t[i + 1]?.t === '(' && (fnMeta(name) || ['set_config', 'current_setting'].includes(name))) return { start: i, name, open: i + 1 }
    return null
  }

  /** Evaluates an expression to a JS value (simple forms here, the rest in SQLite). */
  private evalExpr(tokens: Tok[], params: unknown[], ctx: Context): unknown {
    let t = stripParens(tokens)
    // trailing ::type
    let cast: { name: string; array: boolean } | null = null
    const castAt = t.findIndex((x, i) => x.t === 'op' && x.v === '::' && i > 0 && t.slice(0, i).every((y) => y.t !== 'op' || y.v !== '::') && i === lastTop(t))
    if (castAt > 0) {
      const ty = readType(t, castAt + 1)
      if (ty.end === t.length) {
        cast = { name: ty.name, array: ty.array }
        t = stripParens(t.slice(0, castAt))
      }
    }
    const apply = (v: unknown) => (cast ? castValue(v, cast.name, cast.array) : v)
    if (t.length === 1) {
      const x = t[0]
      if (x.t === 'param') return apply(params[Number(x.v) - 1])
      if (x.t === 'str') return apply(x.v)
      if (x.t === 'num') return apply(Number(x.v))
      if (x.t === 'value') return apply(x.v)
      if (isKw(x, 'null')) return null
      if (isKw(x, 'true')) return apply(true)
      if (isKw(x, 'false')) return apply(false)
    }
    if (t.length >= 2 && isKw(t[0], 'array') && t[1].t === '[' && match(t, 1) === t.length - 1) {
      const items = t.length === 3 ? [] : splitTop(t.slice(2, -1)).map((it) => this.evalExpr(it, params, ctx))
      return cast ? castValue(items, cast.name, true) : items
    }
    const call = this.callAt(t, 0)
    if (call && match(t, call.open) === t.length - 1) return apply(this.call(call.name, t.slice(call.open + 1, -1), params, ctx))
    if (t.length === 3 && t[0].t === 'id' && lower(t[0]) === 'now' && t[1].t === '(') return apply(ctx.now)
    if (t.length === 3 && lower(t[0]) === 'gen_random_uuid') return apply(randomUUID())
    // Anything else: let SQLite work it out.
    const evaluated = this.inline(t, params, ctx)
    const row = this.run(`SELECT ${this.sqlite(evaluated.tokens, ctx)} AS v`, [...params.map(bind), ...evaluated.values])[0]
    return apply(row?.v ?? null)
  }

  /** Calls a database function with Postgres-style arguments (positional or name => value). */
  private call(name: string, argTokens: Tok[], params: unknown[], ctx: Context): unknown {
    const parts = argTokens.length ? splitTop(argTokens) as Tok[][] : []
    if (name === 'set_config') {
      const [k, v] = parts.map((p) => this.evalExpr(p, params, ctx))
      this.settings.set(String(k), v === null ? '' : String(v))
      return v
    }
    if (name === 'current_setting') {
      const [k] = parts.map((p) => this.evalExpr(p, params, ctx))
      return this.settings.get(String(k)) ?? null
    }
    const meta = fnMeta(name)
    if (!meta) throw new DbError('42883', `function ${name} does not exist`)
    const args: Record<string, unknown> = {}
    parts.forEach((p, i) => {
      const named = p.findIndex((x) => x.t === 'op' && (x.v === '=>' || x.v === ':='))
      if (named === 1 || (p[1]?.t === 'op' && p[1].v === '=' && p[2]?.t === 'op' && p[2].v === '>')) {
        const key = lower(p[0])
        const valueTokens = p[1].v === '=>' ? p.slice(2) : p.slice(3)
        args[key] = this.evalExpr(valueTokens, params, ctx)
      } else {
        const a = meta.args[i]
        if (!a) throw new DbError('42883', `function ${name} has no argument ${i + 1}`)
        args[a.name] = this.evalExpr(p, params, ctx)
      }
    })
    // Postgres parses text arguments into the declared types (jsonb, arrays).
    for (const a of meta.args) {
      const v = args[a.name]
      if (typeof v === 'string' && (a.type === 'jsonb' || a.type === 'json')) args[a.name] = JSON.parse(v)
      if (typeof v === 'string' && a.type.endsWith('[]')) args[a.name] = v.trim().startsWith('[') ? JSON.parse(v) : pgArray(v)
    }
    const result = callRpc(this.sql, ctx, name, args)
    return result === undefined ? null : result
  }

  /** Replaces function calls (outside FROM) by their values. */
  private inline(tokens: Tok[], params: unknown[], ctx: Context): { tokens: Tok[]; values: SqlValue[] } {
    const out: Tok[] = []
    const values: SqlValue[] = []
    for (let i = 0; i < tokens.length; i++) {
      const prev = out[out.length - 1]
      const call = isKw(prev, 'from', 'join') ? null : this.callAt(tokens, i)
      if (!call) {
        out.push(tokens[i])
        continue
      }
      const close = match(tokens, call.open)
      let v = this.call(call.name, tokens.slice(call.open + 1, close), params, ctx)
      // (public.fn(…)).field
      if (prev?.t === '(' && tokens[close + 1]?.t === ')' && tokens[close + 2]?.t === '.' && tokens[close + 3]?.t === 'id') {
        out.pop()
        v = v && typeof v === 'object' ? (v as Values)[lower(tokens[close + 3])] ?? null : null
        i = close + 3
      } else i = close
      values.push(bind(v))
      out.push({ t: 'value', v, name: call.name } as Tok)
    }
    return { tokens: out, values }
  }

  /** Token list → SQLite text: function values become ?N after the statement's own parameters. */
  private sqlite(tokens: Tok[], ctx: Context, paramCount = Infinity): string {
    let n = 0
    const base = Number.isFinite(paramCount) ? paramCount : this.paramBase
    const t = jsonbConcat(tokens).map((x) => (x.t === 'value' ? ({ t: 'raw', v: `?${base + ++n}` } as Tok) : x))
    return fill(render(rewrite(t, { context: true, functions: new Set(), bare: true }), { bare: true }), ctx)
  }

  private paramBase = 0

  private run(text: string, params: SqlValue[]): Row[] {
    return this.sql.all(text, params)
  }

  private read(text: string, params: SqlValue[], ctx: Context): Row[] {
    return this.run(this.role === 'authenticated' || this.role === 'anon' ? secure(text, ctx, this.dbRole()) : text, params)
  }

  // ---------------------------------------------------------------- SELECT

  private select(tokens: Tok[], params: unknown[]): QueryResult {
    const ctx = this.context()
    this.paramBase = params.length
    const fromAt = topIndex(tokens, 'from')
    // FROM public.fn(…) [alias]
    const fromCall = fromAt > 0 ? this.callAt(tokens, fromAt + 1) : null
    if (fromCall) return this.selectFromFunction(tokens, fromAt, fromCall, params, ctx)

    const { tokens: t, values } = this.inline(tokens, params, ctx)
    const items = splitTop(t.slice(1, fromAt > 0 ? fromAt - (tokens.length - t.length) : t.length)) as Tok[][]
    if (fromAt < 0 && items.every((it) => simpleItem(it))) {
      const row: Record<string, unknown> = {}
      for (const it of items) {
        const { expr, alias } = splitAlias(it)
        row[alias ?? defaultName(expr)] = this.evalSimple(expr, params, ctx)
      }
      return { rows: [row], rowCount: 1, command: 'SELECT' }
    }
    const named = addAliases(t)
    const text = this.sqlite(named, ctx, params.length)
    const rows = this.read(text, [...params.map(bind), ...values], ctx)
    return { rows: this.decodeRows(rows, named), rowCount: rows.length, command: 'SELECT' }
  }

  /** A select item made only of a value or literal with ->> / -> / casts. */
  private evalSimple(expr: Tok[], params: unknown[], ctx: Context): unknown {
    let v: unknown
    let i = 0
    const t = stripParens(expr)
    if (t[0]?.t === 'value') { v = t[0].v; i = 1 } else return this.evalExpr(t, params, ctx)
    while (i < t.length) {
      const op = t[i]
      if (op.t === 'op' && (op.v === '->>' || op.v === '->')) {
        const key = this.evalExpr([t[i + 1]], params, ctx)
        const obj = typeof v === 'string' ? JSON.parse(v) : v
        let next: unknown = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[String(key)] : null
        if (next === undefined) next = null
        v = op.v === '->>' && next !== null ? (typeof next === 'object' ? JSON.stringify(next) : String(next)) : next
        i += 2
      } else if (op.t === 'op' && op.v === '::') {
        const ty = readType(t, i + 1)
        v = castValue(v, ty.name, ty.array)
        i = ty.end
      } else return this.evalExpr(t, params, ctx)
    }
    return v
  }

  private selectFromFunction(tokens: Tok[], fromAt: number, call: { start: number; name: string; open: number }, params: unknown[], ctx: Context): QueryResult {
    const close = match(tokens, call.open)
    const result = this.call(call.name, tokens.slice(call.open + 1, close), params, ctx)
    let rows: Array<Record<string, unknown>>
    const asRow = (r: unknown) => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : { [call.name]: r })
    if (Array.isArray(result)) rows = result.map(asRow)
    else rows = result === null ? [] : [asRow(result)]
    // alias after the call
    let j = close + 1
    if (isKw(tokens[j], 'as')) j++
    const alias = tokens[j]?.t === 'id' && !isKw(tokens[j], 'where', 'order', 'limit', 'group', 'join', 'left', 'cross', 'on') ? lower(tokens[j++]) : call.name
    const items = splitTop(tokens.slice(1, fromAt)) as Tok[][]
    const rest = tokens.slice(j)
    // Simple projections in JS.
    if (rest.length === 0 && items.every((it) => projectable(it, alias))) {
      const out = rows.map((r) => {
        const o: Record<string, unknown> = {}
        for (const it of items) {
          const { expr, alias: as } = splitAlias(it)
          const e = stripParens(expr)
          if (e.length === 1 && e[0].t === 'op' && e[0].v === '*') Object.assign(o, r)
          else if (e.length === 3 && lower(e[0]) === alias && e[2].t === 'op' && e[2].v === '*') Object.assign(o, r)
          else if (['to_jsonb', 'row_to_json', 'to_json'].includes(lower(e[0])) && e[1]?.t === '(') o[as ?? lower(e[0])] = r
          else {
            const { col, cast } = columnRef(e)
            o[as ?? col] = cast ? castValue(r[col] ?? null, cast.name, cast.array) : r[col] ?? null
          }
        }
        return o
      })
      return { rows: out, rowCount: out.length, command: 'SELECT' }
    }
    // Otherwise run it in SQLite over the rows.
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    const src: Tok = { t: 'raw', v: `(SELECT ${keys.length ? keys.map((k) => `json_extract(value, '$."${k}"') AS ${quoteId(k)}`).join(', ') : 'NULL AS _'} FROM json_each(?${params.length + 1})) AS ${quoteId(alias)}` }
    const t = [...tokens.slice(0, call.start), src, ...rest]
    const named = addAliases(t)
    const text = this.sqlite(named, ctx, params.length + 1)
    const raw = this.run(text, [...params.map(bind), JSON.stringify(rows)])
    const kinds = new Map(keys.map((k) => [k, rows.find((r) => r[k] !== null && r[k] !== undefined)?.[k]]))
    const out = this.decodeRows(raw, named).map((r) => {
      for (const [k, v] of Object.entries(r)) {
        const sample = kinds.get(k)
        if (typeof sample === 'boolean' && (v === 0 || v === 1)) r[k] = v === 1
        if (sample && typeof sample === 'object' && typeof v === 'string') r[k] = JSON.parse(v)
      }
      return r
    })
    return { rows: out, rowCount: out.length, command: 'SELECT' }
  }

  /** Decodes SQLite rows: columns of known tables by their type, JSON-producing expressions parsed. */
  private decodeRows(rows: Row[], tokens: Tok[]): Array<Record<string, unknown>> {
    const tables = [...mentioned(render(tokens as Token[], { bare: true }))]
    const cols = new Map<string, ColumnMeta>()
    for (const name of tables) {
      for (const [c, m] of Object.entries(table(name)?.columns ?? schema.views[name]?.columns ?? {})) if (!cols.has(c)) cols.set(c, m)
    }
    const jsonCols = new Set<string>()
    const fromAt = topIndex(tokens, 'from')
    for (const it of splitTop(tokens.slice(1, fromAt > 0 ? fromAt : tokens.length)) as Tok[][]) {
      const { expr, alias } = splitAlias(it)
      if (expr.some((x) => x.t === 'id' && JSON_PRODUCERS.has(lower(x)))) jsonCols.add(alias ?? defaultName(expr))
    }
    return rows.map((r) => {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) {
        if (jsonCols.has(k) && typeof v === 'string') o[k] = JSON.parse(v)
        else o[k] = cols.has(k) ? decode(v, cols.get(k)) : v
      }
      return o
    })
  }

  // ---------------------------------------------------------------- writes

  private env(ctx: Context): WriteEnv {
    return { sql: this.sql, ctx, role: this.dbRole() }
  }

  private target(tokens: Tok[], at: number): { name: string; end: number; auth: boolean } {
    let i = at
    let auth = false
    if (lower(tokens[i]) === 'public' && tokens[i + 1]?.t === '.') i += 2
    else if (lower(tokens[i]) === 'auth' && tokens[i + 1]?.t === '.') {
      i += 2
      auth = true
    }
    const name = lower(tokens[i])
    return { name: auth && name === 'users' ? 'users' : name, end: i + 1, auth }
  }

  private returning(name: string, keys: Key[], items: Tok[] | null, ctx: Context): Array<Record<string, unknown>> {
    if (!items || !keys.length) return []
    const t = table(name)!
    const w = keyWhere(t, quoteId(name), keys)
    const named = addAliases([{ t: 'id', v: 'select' }, ...items, { t: 'id', v: 'from' }, { t: 'raw', v: `main.${quoteId(name)} AS ${quoteId(name)}` }] as Tok[])
    const text = `${this.sqlite(named, ctx, 0)} WHERE ${w.sql.replaceAll('?', '?1')}`
    return this.decodeRows(this.run(text, w.params), named)
  }

  private insert(tokens: Tok[], params: unknown[]): QueryResult {
    const ctx = this.context()
    this.paramBase = params.length
    const { name, end, auth } = this.target(tokens, 2)
    let i = end
    if (isKw(tokens[i], 'as')) i += 2
    else if (tokens[i]?.t === 'id' && !isKw(tokens[i], 'values', 'select', 'default')) i++
    let cols: string[] = []
    if (tokens[i]?.t === '(') {
      const close = match(tokens, i)
      cols = (splitTop(tokens.slice(i + 1, close)) as Tok[][]).map((c) => lower(c[0]))
      i = close + 1
    }
    const conflictAt = topIndex(tokens, 'on', i)
    const returningAt = topIndex(tokens, 'returning', i)
    const sourceEnd = [conflictAt, returningAt].filter((x) => x > 0).sort((a, b) => a - b)[0] ?? tokens.length
    const source = tokens.slice(i, sourceEnd)
    let rows: unknown[][]
    if (isKw(source[0], 'values')) {
      rows = (splitTop(source.slice(1)) as Tok[][]).map((r) => (splitTop(stripParens(r)) as Tok[][]).map((v) => (isKw(v[0], 'default') && v.length === 1 ? undefined : this.evalExpr(v, params, ctx))))
    } else {
      const res = this.select(source, params)
      rows = res.rows.map((r) => Object.values(r))
    }
    const t = auth ? null : table(name)
    if (!auth && !t) throw new DbError('42P01', `relation "${name}" does not exist`)
    const records = rows.map((r) => {
      const rec: Values = {}
      cols.forEach((c, k) => {
        if (r[k] === undefined) return
        let v = r[k]
        const meta = t?.columns[c]
        if (meta && (meta.type === 'json') && typeof v === 'string') v = JSON.parse(v)
        if (meta && meta.type === 'array' && typeof v === 'string') v = v.trim().startsWith('[') ? JSON.parse(v) : pgArray(v)
        rec[c] = v
      })
      return rec
    })
    if (auth) return this.insertAuthUsers(records)
    let opts: Parameters<typeof insert>[3] = {}
    if (conflictAt > 0) {
      let k = conflictAt + 2
      let onConflict: string[] | undefined
      if (tokens[k]?.t === '(') {
        const close = match(tokens, k)
        onConflict = (splitTop(tokens.slice(k + 1, close)) as Tok[][]).map((c) => lower(c[0]))
        k = close + 1
      }
      while (k < tokens.length && !isKw(tokens[k], 'do')) k++
      opts = { onConflict, resolution: isKw(tokens[k + 1], 'nothing') ? 'ignore' : 'merge' }
    }
    const env = this.env(ctx)
    const keys = this.replica ? this.rawInsert(name, records) : insert(env, name, records, opts)
    const items = returningAt > 0 ? tokens.slice(returningAt + 1) : null
    const out = this.returning(name, keys, items, ctx)
    return { rows: out, rowCount: keys.length, command: 'INSERT' }
  }

  private rawInsert(name: string, records: Values[]): Key[] {
    const t = table(name)!
    return records.map((rec) => {
      const cols = Object.keys(rec)
      const r = this.run(`INSERT INTO main.${quoteId(name)} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
        cols.map((c) => bind(rec[c])))[0]
      return t.pk.map((c) => r[c] as SqlValue)
    })
  }

  private insertAuthUsers(records: Values[]): QueryResult {
    for (const r of records) {
      const app = (r.raw_app_meta_data ?? {}) as Values
      this.run(`INSERT INTO users (id, email, phone, clerk_user_id, user_metadata, app_metadata, email_confirmed_at, banned_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [String(r.id ?? randomUUID()).toLowerCase(), r.email ? String(r.email).toLowerCase() : null, (r.phone as string) ?? null,
        typeof app.clerk_user_id === 'string' ? app.clerk_user_id : null, JSON.stringify(r.raw_user_meta_data ?? {}), JSON.stringify(app),
        r.email_confirmed_at ? toTimestamp(r.email_confirmed_at) : null, r.banned_until ? toTimestamp(r.banned_until) : null])
    }
    return { rows: [], rowCount: records.length, command: 'INSERT' }
  }

  /** Rows a WHERE picks (on the table itself, before row security), with computed SET values. */
  private pick(name: string, alias: string, where: Tok[] | null, extra: Array<{ col: string; expr: Tok[] }>, params: unknown[], ctx: Context): Array<{ key: Key; set: Values }> {
    const t = table(name)!
    const { tokens: w, values } = this.inline(where ?? [], params, ctx)
    const exprs: Tok[] = []
    const vals = [...values]
    extra.forEach((e, k) => {
      const inl = this.inline(e.expr, params, ctx)
      vals.push(...inl.values)
      exprs.push({ t: ',' } as Tok, { t: '(' } as Tok, ...inl.tokens, { t: ')' } as Tok, { t: 'raw', v: `AS __v${k}` } as Tok)
    })
    // value placeholders are numbered in order of appearance: where first, then set expressions
    const head: Tok[] = [{ t: 'raw', v: `SELECT ${t.pk.map((c, k) => `${quoteId(alias)}.${quoteId(c)} AS __k${k}`).join(', ')}` } as Tok, ...exprs.slice(0)]
    // put set expressions before where so placeholder order matches vals order
    const ordered = [...head, { t: 'raw', v: `FROM main.${quoteId(name)} AS ${quoteId(alias)}` } as Tok, ...(where ? [{ t: 'id', v: 'where' } as Tok, ...w] : [])]
    const reorderedVals = [...vals.slice(values.length), ...vals.slice(0, values.length)]
    const text = this.sqlite(ordered, ctx, params.length)
    const rows = this.run(this.role === 'authenticated' || this.role === 'anon' ? secure(text, ctx, this.dbRole()) : text, [...params.map(bind), ...reorderedVals])
    return rows.map((r) => ({
      key: t.pk.map((_, k) => r[`__k${k}`] as SqlValue),
      set: Object.fromEntries(extra.map((e, k) => [e.col, decode(r[`__v${k}`], t.columns[e.col])])),
    }))
  }

  private update(tokens: Tok[], params: unknown[]): QueryResult {
    const ctx = this.context()
    this.paramBase = params.length
    const { name, end, auth } = this.target(tokens, 1)
    if (auth) return this.updateAuthUsers(tokens, end, params, ctx)
    let i = end
    let alias = name
    if (isKw(tokens[i], 'as')) i++
    if (tokens[i]?.t === 'id' && !isKw(tokens[i], 'set')) alias = lower(tokens[i++])
    if (!isKw(tokens[i], 'set')) throw new Error('pgshim: UPDATE without SET')
    const whereAt = topIndex(tokens, 'where', i)
    const returningAt = topIndex(tokens, 'returning', i)
    const setEnd = [whereAt, returningAt].filter((x) => x > 0).sort((a, b) => a - b)[0] ?? tokens.length
    const assignments = (splitTop(tokens.slice(i + 1, setEnd)) as Tok[][]).map((a) => {
      const eq = a.findIndex((x) => x.t === 'op' && x.v === '=')
      return { col: lower(a[eq - 1]), expr: a.slice(eq + 1) }
    })
    const where = whereAt > 0 ? tokens.slice(whereAt + 1, returningAt > 0 ? returningAt : tokens.length) : null
    const picked = this.pick(name, alias, where, assignments, params, ctx)
    const env = this.env(ctx)
    const keys: Key[] = []
    for (const p of picked) {
      if (this.replica) {
        const cols = Object.keys(p.set)
        const t = table(name)!
        const w = keyWhere(t, quoteId(name), [p.key])
        this.run(`UPDATE main.${quoteId(name)} AS ${quoteId(name)} SET ${cols.map((c) => `${quoteId(c)} = ?`).join(', ')} WHERE ${w.sql}`,
          [...cols.map((c) => bind(encodeFor(t.columns[c], p.set[c]))), ...w.params])
        keys.push(p.key)
      } else keys.push(...update(env, name, p.set, { keys: [p.key] }))
    }
    const items = returningAt > 0 ? tokens.slice(returningAt + 1) : null
    return { rows: this.returning(name, keys, items, ctx), rowCount: keys.length, command: 'UPDATE' }
  }

  private updateAuthUsers(tokens: Tok[], end: number, params: unknown[], ctx: Context): QueryResult {
    // update auth.users set col = value[, …] where id = …  (raw: accounts have no row security)
    const whereAt = topIndex(tokens, 'where', end)
    const sets = (splitTop(tokens.slice(end + 1, whereAt > 0 ? whereAt : tokens.length)) as Tok[][]).map((a) => {
      const eq = a.findIndex((x) => x.t === 'op' && x.v === '=')
      return { col: lower(a[eq - 1]), value: this.evalExpr(a.slice(eq + 1), params, ctx) }
    })
    const map: Record<string, string> = { raw_user_meta_data: 'user_metadata', raw_app_meta_data: 'app_metadata' }
    const where = whereAt > 0 ? this.sqlite(tokens.slice(whereAt + 1), ctx, params.length) : '1'
    const cols = sets.map((s) => map[s.col] ?? s.col)
    const n = this.sql.run(`UPDATE users SET ${cols.map((c, k) => `${c} = ?${params.length + k + 1}`).join(', ')} WHERE ${where}`,
      [...params.map(bind), ...sets.map((s) => bind(s.value))])
    return { rows: [], rowCount: n, command: 'UPDATE' }
  }

  private remove(tokens: Tok[], params: unknown[]): QueryResult {
    const ctx = this.context()
    this.paramBase = params.length
    const { name, end, auth } = this.target(tokens, 2)
    if (auth) {
      const whereAt = topIndex(tokens, 'where', end)
      const n = this.sql.run(`DELETE FROM users WHERE ${whereAt > 0 ? this.sqlite(tokens.slice(whereAt + 1), ctx, params.length) : '1'}`, params.map(bind))
      return { rows: [], rowCount: n, command: 'DELETE' }
    }
    let i = end
    let alias = name
    if (isKw(tokens[i], 'as')) i++
    if (tokens[i]?.t === 'id' && !isKw(tokens[i], 'where', 'returning')) alias = lower(tokens[i++])
    const whereAt = topIndex(tokens, 'where', i)
    const returningAt = topIndex(tokens, 'returning', i)
    const where = whereAt > 0 ? tokens.slice(whereAt + 1, returningAt > 0 ? returningAt : tokens.length) : null
    const picked = this.pick(name, alias, where, [], params, ctx)
    const removed = picked.length ? remove(this.env(ctx), name, { keys: picked.map((p) => p.key) }) : []
    let rows: Array<Record<string, unknown>> = []
    if (returningAt > 0) {
      const items = splitTop(tokens.slice(returningAt + 1)) as Tok[][]
      rows = removed.map((r) => Object.fromEntries(items.map((it) => {
        const { expr, alias: as } = splitAlias(it)
        const { col } = columnRef(stripParens(expr))
        return [as ?? col, r[col] ?? null]
      })))
    }
    return { rows, rowCount: removed.length, command: 'DELETE' }
  }
}

// ---------------------------------------------------------------- token helpers

function encodeFor(col: ColumnMeta | undefined, v: unknown): unknown {
  if (!col) return v
  if (col.type === 'bool') return v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : v
  return v
}

/** Index of the last top-level token (for a trailing ::cast). */
function lastTop(t: Tok[]): number {
  let depth = 0
  let last = -1
  t.forEach((x, i) => {
    if (x.t === '(' || x.t === '[') depth++
    if (x.t === ')' || x.t === ']') depth--
    if (depth === 0 && x.t === 'op' && x.v === '::') last = i
  })
  return last
}

/** Index of a top-level keyword, or -1. */
function topIndex(t: Tok[], kw: string, from = 0): number {
  let depth = 0
  for (let i = 0; i < t.length; i++) {
    const x = t[i]
    if (x.t === '(' || x.t === '[') depth++
    if (x.t === ')' || x.t === ']') depth--
    if (i >= from && depth === 0 && isKw(x, kw)) return i
  }
  return -1
}

function splitAlias(item: Tok[]): { expr: Tok[]; alias: string | null } {
  const n = item.length
  if (n >= 3 && isKw(item[n - 2], 'as') && item[n - 1].t === 'id') return { expr: item.slice(0, -2), alias: String(item[n - 1].v) }
  return { expr: item, alias: null }
}

/** Postgres' default column name for an expression. */
function defaultName(expr: Tok[]): string {
  let t = stripParens(expr)
  const cast = lastTop(t)
  if (cast > 0 && readType(t, cast + 1).end === t.length) t = stripParens(t.slice(0, cast))
  if (t.length === 1 && t[0].t === 'value') return (t[0] as Tok).name ?? '?column?'
  if (t.length === 1 && t[0].t === 'id') return lower(t[0])
  if (t.length === 3 && t[0].t === 'id' && t[1].t === '.' && t[2].t === 'id') return lower(t[2])
  if (t[0]?.t === 'id' && t[1]?.t === '(' && match(t, 1) === t.length - 1) return lower(t[0])
  if (isKw(t[0], 'case')) return 'case'
  if (t[0]?.t === 'value') return (t[0] as Tok).name ?? '?column?'
  return '?column?'
}

/** Adds Postgres' default names (AS "…") to select items that have none. */
function addAliases(t: Tok[]): Tok[] {
  const fromAt = topIndex(t, 'from')
  const head = t.slice(0, 1)
  const listEnd = fromAt > 0 ? fromAt : t.length
  let start = 1
  if (isKw(t[1], 'distinct')) {
    head.push(t[1])
    start = 2
  }
  const items = splitTop(t.slice(start, listEnd)) as Tok[][]
  const out: Tok[] = [...head]
  items.forEach((it, k) => {
    if (k) out.push({ t: ',' } as Tok)
    const { expr, alias } = splitAlias(it)
    const star = expr.length === 1 && expr[0].t === 'op' && expr[0].v === '*'
    const tableStar = expr.length === 3 && expr[2].t === 'op' && expr[2].v === '*'
    out.push(...expr)
    if (!star && !tableStar) out.push({ t: 'raw', v: `AS "${(alias ?? defaultName(expr)).replaceAll('"', '""')}"` } as Tok)
  })
  return [...out, ...t.slice(listEnd)]
}

function simpleItem(it: Tok[]): boolean {
  const { expr } = splitAlias(it)
  const t = stripParens(expr)
  if (t[0]?.t !== 'value' && !(t.length === 1 && ['str', 'num', 'param'].includes(t[0].t))) return false
  for (let i = 1; i < t.length; i++) {
    const x = t[i]
    if (x.t === 'op' && (x.v === '->>' || x.v === '->')) { i++; continue }
    if (x.t === 'op' && x.v === '::') { i = readType(t, i + 1).end - 1; continue }
    return false
  }
  return true
}

function columnRef(e: Tok[]): { col: string; cast: { name: string; array: boolean } | null } {
  let t = e
  let cast: { name: string; array: boolean } | null = null
  const c = lastTop(t)
  if (c > 0) {
    const ty = readType(t, c + 1)
    cast = { name: ty.name, array: ty.array }
    t = t.slice(0, c)
  }
  return { col: lower(t[t.length - 1]), cast }
}

function projectable(it: Tok[], alias: string): boolean {
  const { expr } = splitAlias(it)
  const e = stripParens(expr)
  if (e.length === 1 && (e[0].t === 'id' || (e[0].t === 'op' && e[0].v === '*'))) return true
  if (e.length === 3 && lower(e[0]) === alias && e[1].t === '.') return true
  if (['to_jsonb', 'row_to_json', 'to_json'].includes(lower(e[0])) && e.length === 4 && lower(e[2]) === alias) return true
  const c = lastTop(e)
  if (c > 0 && readType(e, c + 1).end === e.length) return projectable(e.slice(0, c), alias)
  return false
}

/** jsonb || '{…}'::jsonb (or || jsonb_build_object(…)) → json_patch(…). */
function jsonbConcat(t: Tok[]): Tok[] {
  const out = [...t]
  for (let i = 0; i < out.length; i++) {
    if (!(out[i].t === 'op' && out[i].v === '||')) continue
    const right = out[i + 1]
    let rEnd = -1
    if (right?.t === 'str' && out[i + 2]?.t === 'op' && out[i + 2].v === '::' && ['jsonb', 'json'].includes(lower(out[i + 3]))) rEnd = i + 3
    else if (right?.t === 'id' && ['jsonb_build_object', 'json_build_object'].includes(lower(right)) && out[i + 2]?.t === '(') rEnd = match(out, i + 2)
    if (rEnd < 0) continue
    let lStart = i - 1
    if (out[lStart]?.t === ')') lStart = match(out, lStart)
    while (lStart >= 2 && out[lStart - 1]?.t === '.' && out[lStart - 2]?.t === 'id') lStart -= 2
    if (out[lStart - 1]?.t === 'id' && out[lStart]?.t === '(' && !isKw(out[lStart - 1], 'and', 'or', 'not', 'in', 'select', 'where')) lStart--
    const left = out.slice(lStart, i)
    const rightToks = out.slice(i + 1, rEnd + 1)
    out.splice(lStart, rEnd - lStart + 1, { t: 'raw', v: 'json_patch(' } as Tok, ...left, { t: ',' } as Tok, ...rightToks, { t: 'raw', v: ')' } as Tok)
    i = lStart
  }
  return out
}

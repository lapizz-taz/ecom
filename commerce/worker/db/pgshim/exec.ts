// Test adapter: runs the Postgres test suite's SQL (supabase/tests/db) against the
// Cloudflare database through the Postgres engine (worker/db/pg). Session commands
// (SET ROLE, savepoints) are handled here; everything else is the engine's job.
// Results come back the way the `pg` driver returns them. Test-only: never bundled.
import { Context, type Identity } from '../context.ts'
import { DbError } from '../errors.ts'
import { asDbError, PgEngine } from '../pg/engine.ts'
import { lex } from '../pg/lex.ts'
import { Parser } from '../pg/parse.ts'
import { execStatement } from '../pg/query.ts'
import { BIGINT, FLOAT, NO_VARS, type Typed } from '../pg/runtime.ts'
import { Interval, JNULL, PgRow, toText } from '../pg/values.ts'
import type { DbRole } from '../policy.ts'
import type { Sql } from '../sql.ts'

export interface QueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number
  command: string
}

export type SessionRole = 'postgres' | 'service_role' | 'authenticated' | 'anon'

export class Session {
  role: SessionRole = 'postgres'
  ctx: Context

  constructor(readonly sql: Sql) {
    this.ctx = this.fresh()
  }

  /** A new transaction: fixed now(), settings cleared, the database owner without a JWT. */
  fresh(): Context {
    this.role = 'postgres'
    this.ctx = new Context(this.sql, { role: 'service_role', uid: null, sessionId: null, system: true })
    return this.ctx
  }

  get identity(): Identity {
    return this.ctx.identity
  }

  private dbRole(): DbRole {
    return this.role === 'postgres' ? 'service_role' : this.role
  }

  query(text: string, params: unknown[] = []): QueryResult {
    const p = new Parser(lex(text), text, {})
    let last: QueryResult = { rows: [], rowCount: 0, command: '' }
    for (;;) {
      while (p.eatPunct(';')) { /* empty statements */ }
      if (p.peek().k === 'eof') return last
      last = this.statement(p, text, params)
    }
  }

  private statement(p: Parser, text: string, params: unknown[]): QueryResult {
    const word = p.peek().v
    const empty = (command: string): QueryResult => ({ rows: [], rowCount: 0, command })
    const skipToEnd = () => {
      while (!p.isPunct(';') && p.peek().k !== 'eof') p.i++
    }
    switch (word) {
      case 'begin': case 'commit': case 'start':
        skipToEnd()
        return empty(word.toUpperCase())
      case 'savepoint': {
        p.i++
        this.sql.script(`SAVEPOINT ${p.name()}`)
        return empty('SAVEPOINT')
      }
      case 'release': {
        p.i++
        p.eatKw('savepoint')
        this.sql.script(`RELEASE ${p.name()}`)
        return empty('RELEASE')
      }
      case 'rollback': {
        p.i++
        if (p.eatKw('to')) {
          p.eatKw('savepoint')
          this.sql.script(`ROLLBACK TO ${p.name()}`)
          this.ctx.reset()
        } else skipToEnd()
        return empty('ROLLBACK')
      }
      case 'reset': {
        p.i++
        if (p.eatKw('role')) this.setRole('postgres')
        else skipToEnd()
        return empty('RESET')
      }
      case 'set': {
        p.i++
        if (!p.eatKw('local')) p.eatKw('session')
        if (p.eatKw('role')) {
          this.setRole(p.name() as SessionRole)
          return empty('SET')
        }
        const name = p.name()
        if (!p.eatKw('to')) p.expectOp('=')
        const value = p.next().v
        if (name === 'session_replication_role') this.ctx.flags.set('__replica', value === 'replica' ? '1' : '')
        else this.ctx.settings.set(name, value)
        skipToEnd()
        return empty('SET')
      }
    }
    const st = p.statement()
    if (!p.isPunct(';') && p.peek().k !== 'eof') p.fail('expected ";"')
    const engine = new PgEngine(this.sql, this.ctx, this.dbRole())
    const typedParams = params.map(paramOf)
    try {
      // a failed statement leaves nothing behind (Postgres statement atomicity)
      const res = this.sql.transaction(() => execStatement(engine, st, NO_VARS, typedParams))
      const rows = res.rows.map((r) => {
        const o: Record<string, unknown> = {}
        res.cols.forEach((c, i) => {
          o[c.name] = driverValue(r[i], c.t, c.s)
        })
        return o
      })
      return { rows, rowCount: res.command === 'SELECT' ? rows.length : res.count, command: res.command }
    } catch (e) {
      const err = asDbError(e)
      if (err instanceof DbError) throw err
      throw err
    } finally {
      void text
    }
  }

  private setRole(role: SessionRole): void {
    this.role = role
    this.ctx.reset()
  }
}

/** A query parameter as the pg driver would send it (text), typed loosely. */
function paramOf(v: unknown): Typed {
  if (v === null || v === undefined) return { t: 'unknown', v: null }
  if (typeof v === 'number') return { t: Number.isInteger(v) ? 'int' : 'numeric', v }
  if (typeof v === 'boolean') return { t: 'bool', v }
  if (v instanceof Date) return { t: 'timestamptz', v: v.toISOString() }
  if (Array.isArray(v)) return { t: 'text[]', v: v.map((x) => (x === null ? null : typeof x === 'object' ? JSON.stringify(x) : String(x))) }
  if (typeof v === 'object') return { t: 'unknown', v: JSON.stringify(v) }
  return { t: 'unknown', v: String(v) }
}

/** Values in the shape the pg driver returns them. */
export function driverValue(v: unknown, t: string, s?: number): unknown {
  if (v === null || v === undefined) return null
  if (v === JNULL) return null
  // numeric arrives as text with its display scale ('990.00'); float8 as a number
  if (t === 'numeric') return typeof v === 'number' ? (s === FLOAT ? v : toText(v, 'numeric', s)) : v
  if (t === 'int' && s === BIGINT && typeof v === 'number') return String(v)
  if (t === 'timestamptz' || t === 'timestamp') return new Date(t === 'timestamp' ? `${String(v)}Z` : String(v))
  if (t === 'date') {
    const [y, m, d] = String(v).split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  if (v instanceof PgRow) return toText(v, t)
  if (v instanceof Interval) return v.toString()
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (t.endsWith('[]') && Array.isArray(v)) {
    const et = t.slice(0, -2)
    return v.map((x) => driverValue(x, et))
  }
  return v
}

// Runs compiled SQL as the current role: the tables it reads are replaced by their
// row-security-filtered copies (policy.ts shadow) and views are inlined.
import type { SqlValue } from '../codec.ts'
import { DbError } from '../errors.ts'
import { shadow } from '../policy.ts'
import type { Row } from '../sql.ts'
import type { Engine } from './runtime.ts'

const debug = typeof process !== 'undefined' && Boolean(process.env?.PGENGINE_DEBUG)

export function secureSql(sql: string, engine: Engine): string {
  const ctes = shadow(sql, engine.ctx, engine.role)
  if (!ctes.length) return sql
  const m = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(sql)
  if (m) return `WITH ${m[1] ? 'RECURSIVE ' : ''}${ctes.join(', ')}, ${sql.slice(m[0].length)}`
  return `WITH ${ctes.join(', ')} ${sql}`
}

export function runSql(engine: Engine, sql: string, params: SqlValue[]): Row[] {
  const text = secureSql(sql, engine)
  try {
    return engine.sql.all(text, params)
  } catch (e) {
    // Internal errors keep the statement for whoever debugs them (tests, PGENGINE_DEBUG).
    if (debug && e instanceof DbError && !['P0001', '23505', '23503', '23514', '23502', '42501'].includes(e.code)) throw new DbError(e.code, `${e.message}: ${e.details}\n${text}\n${JSON.stringify(params).slice(0, 500)}`)
    throw e
  }
}

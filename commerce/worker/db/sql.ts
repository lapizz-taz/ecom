// The SQLite connection the data layer runs on: the Durable Object's own SQLite
// storage in production, Node's built-in SQLite in tests. Both are synchronous, so a
// business operation runs start to finish inside one transaction with nothing else
// interleaving — the guarantee stock and money updates need.
import type { SqlValue } from './codec.ts'
import { fromSqlite } from './errors.ts'
import { table } from './meta.ts'

export type Row = Record<string, unknown>

export interface Sql {
  /** One statement; its rows. */
  all(query: string, params?: readonly SqlValue[]): Row[]
  /** One statement; the number of rows it inserted, updated or deleted. */
  run(query: string, params?: readonly SqlValue[]): number
  /** Statements without parameters (migrations); a string may hold several. */
  script(sql: string | readonly string[]): void
  /**
   * All or nothing: if fn throws, everything it wrote is undone. A nested call is a
   * savepoint, so an inner failure that the caller catches undoes only the inner part
   * (like a plpgsql BEGIN … EXCEPTION block).
   */
  transaction<T>(fn: () => T): T
}

/** The unique constraint name for a set of columns, for Postgres-style messages. */
function uniqueName(tableName: string, columns: string[]): string | undefined {
  const t = table(tableName)
  if (!t) return undefined
  if (t.pk.length === columns.length && t.pk.every((c, i) => c === columns[i])) return `${tableName}_pkey`
  return `${tableName}_${columns.join('_')}_key`
}

const wrap = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (e) {
    throw fromSqlite(e, { unique: uniqueName })
  }
}

/** The Durable Object's SQLite storage (nested transactionSync calls are savepoints). */
export function durableSql(storage: DurableObjectStorage): Sql {
  const sql = storage.sql
  return {
    all: (query, params = []) => wrap(() => sql.exec(query, ...params).toArray() as Row[]),
    run: (query, params = []) => wrap(() => {
      sql.exec(query, ...params)
      return Number(sql.exec('SELECT changes() AS n').one().n)
    }),
    // One exec per statement: a Durable Object accepts at most 100 KB of SQL per call.
    script: (text) => wrap(() => { for (const st of typeof text === 'string' ? [text] : text) sql.exec(st) }),
    transaction: (fn) => storage.transactionSync(fn),
  }
}

/** Anything with Node's DatabaseSync shape (node:sqlite), used by tests and tools. */
export interface SyncDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number | bigint } }
  exec(sql: string): void
}

export function nodeSql(db: SyncDatabase): Sql {
  let depth = 0
  let savepoint = 0
  return {
    all: (query, params = []) => wrap(() => db.prepare(query).all(...params) as Row[]),
    run: (query, params = []) => wrap(() => Number(db.prepare(query).run(...params).changes)),
    script: (text) => wrap(() => { for (const st of typeof text === 'string' ? [text] : text) db.exec(st) }),
    transaction<T>(fn: () => T): T {
      const name = `sp${++savepoint}`
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
      depth++
      try {
        const result = fn()
        db.exec(depth === 1 ? 'COMMIT' : `RELEASE ${name}`)
        return result
      } catch (e) {
        db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`)
        throw e
      } finally {
        depth--
      }
    },
  }
}

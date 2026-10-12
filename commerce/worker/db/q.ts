// What ported database functions use to read and write. Reads go through the same
// row-security shadowing Postgres applied to the function's owner (app_owner keeps
// store isolation; postgres-owned and service calls see everything), and writes go
// through the writer, so triggers, checks and the audit trail still apply.
import { decode, type SqlValue } from './codec.ts'
import { DbError } from './errors.ts'
import { quoteId } from './ident.ts'
import { table, type ColumnMeta } from './meta.ts'
import { secure } from './policy.ts'
import type { Row } from './sql.ts'
import { insert, remove, update, type InsertOptions, type Key, type Values, type Where, type WriteEnv } from './writer.ts'

export class Q {
  constructor(readonly env: WriteEnv) {}

  get ctx() {
    return this.env.ctx
  }

  get now() {
    return this.env.ctx.now
  }

  /** Raw rows (SQLite values: booleans 0/1, JSON as text). */
  raw(query: string, params: readonly SqlValue[] = []): Row[] {
    return this.env.sql.all(secure(query, this.env.ctx, this.env.role), params)
  }

  /** Rows decoded with a table's column types (columns not in the table are left as they are). */
  rows<T = Values>(query: string, params: readonly SqlValue[] = [], as?: string): T[] {
    const cols: Record<string, ColumnMeta> = as ? table(as)?.columns ?? {} : {}
    return this.raw(query, params).map((r) => {
      const out: Values = {}
      for (const [k, v] of Object.entries(r)) out[k] = decode(v, Object.hasOwn(cols, k) ? cols[k] : undefined)
      return out as T
    })
  }

  one<T = Values>(query: string, params: readonly SqlValue[] = [], as?: string): T | null {
    return this.rows<T>(query, params, as)[0] ?? null
  }

  /** The first column of the first row (undefined → null). */
  value<T = unknown>(query: string, params: readonly SqlValue[] = []): T | null {
    const r = this.raw(query, params)[0]
    return r ? ((Object.values(r)[0] ?? null) as T) : null
  }

  exists(query: string, params: readonly SqlValue[] = []): boolean {
    return this.raw(`SELECT EXISTS (${query}) AS e`, params)[0].e === 1
  }

  insert(name: string, rows: Values | Values[], opts?: InsertOptions): Key[] {
    return insert(this.env, name, Array.isArray(rows) ? rows : [rows], opts)
  }

  /** Inserts one row and returns it decoded. */
  insertOne<T = Values>(name: string, row: Values, opts?: InsertOptions): T {
    const [key] = this.insert(name, row, opts)
    if (!key) throw new DbError('XX000', `insert into ${name} returned nothing`)
    return this.byKey<T>(name, key)!
  }

  update(name: string, set: Values, where: Where): Key[] {
    return update(this.env, name, set, where)
  }

  remove(name: string, where: Where): Values[] {
    return remove(this.env, name, where)
  }

  byKey<T = Values>(name: string, key: Key): T | null {
    const t = table(name)!
    return this.one<T>(`SELECT * FROM ${quoteId(name)} WHERE ${t.pk.map((c) => `${quoteId(c)} = ?`).join(' AND ')}`, key, name)
  }

  /** A setting of the current store (public.get_setting): {} when not set. */
  setting(key: string): Record<string, unknown> {
    const v = this.value<string>('SELECT value FROM settings WHERE key = ? AND merchant_id = ?', [key, this.ctx.merchantId()])
    return v ? (JSON.parse(v) as Record<string, unknown>) : {}
  }
}

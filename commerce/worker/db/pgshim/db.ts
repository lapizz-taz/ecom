// Drop-in replacement for supabase/tests/support/db.ts when the Postgres test suite
// runs against the Cloudflare database (vitest project "cfdb"). Same exports; each
// test file gets its own in-memory database with the schema and reference data, and
// inTx rolls everything back after each test, as before.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migrate } from '../migrate.ts'
import { nodeSql } from '../sql.ts'
import { Session, type QueryResult } from './exec.ts'

export const ADMIN_URL = 'sqlite::memory:'
export const MERCHANT_1 = '00000000-0000-4000-8000-000000000001'

const seed = readFileSync(resolve(import.meta.dirname, '..', 'generated', 'seed.sql'), 'utf8')

/** The Postgres client surface the tests use (query, release). */
export class ShimClient {
  constructor(readonly session: Session) {}

  async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult & { rows: R[] }> {
    try {
      return this.session.query(text, params) as QueryResult & { rows: R[] }
    } catch (e) {
      // Postgres errors carry the message the tests match on.
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  release() {}
}

export type Db = ShimClient

let database: { db: DatabaseSync; session: Session } | null = null

function open() {
  if (!database) {
    const db = new DatabaseSync(':memory:')
    const sql = nodeSql(db)
    migrate(sql)
    sql.transaction(() => sql.script(seed))
    database = { db, session: new Session(sql) }
  }
  return database
}

export function testDatabaseUrl(name = 'commerce_test'): string {
  return `sqlite:${name}`
}

export async function createTestDatabase(): Promise<string> {
  open()
  return ADMIN_URL
}

export function getPool() {
  const { session } = open()
  return { connect: async () => new ShimClient(session), end: async () => {} }
}

export async function closePool(): Promise<void> {}

/** Runs `fn` inside a transaction that is always rolled back. */
export async function inTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, session } = open()
  session.role = 'postgres'
  session.claims = {}
  session.settings.clear()
  session.replica = false
  db.exec('BEGIN')
  try {
    return await fn(new ShimClient(session))
  } finally {
    db.exec('ROLLBACK')
  }
}

async function setHeaders(db: Db, merchantId: string | null): Promise<void> {
  db.session.settings.set('request.headers', JSON.stringify(merchantId ? { 'x-merchant-id': merchantId } : {}))
}

export async function asSystem(db: Db, merchantId: string | null = MERCHANT_1): Promise<void> {
  db.session.role = 'postgres'
  db.session.claims = {}
  db.session.settings.set('request.jwt.claims', '')
  db.session.settings.set('app.merchant_id', merchantId ?? '')
  await setHeaders(db, null)
}

export async function asService(db: Db, merchantId: string | null = MERCHANT_1): Promise<void> {
  db.session.role = 'service_role'
  db.session.claims = { role: 'service_role' }
  db.session.settings.set('app.merchant_id', '')
  await setHeaders(db, merchantId)
}

export async function asUser(db: Db, userId: string, email = 'user@example.com', merchantId: string | null = MERCHANT_1): Promise<void> {
  db.session.role = 'authenticated'
  db.session.claims = { sub: userId, role: 'authenticated', email }
  db.session.settings.set('app.merchant_id', '')
  await setHeaders(db, merchantId)
}

export async function asAnon(db: Db, merchantId: string | null = MERCHANT_1): Promise<void> {
  db.session.role = 'anon'
  db.session.claims = { role: 'anon' }
  db.session.settings.set('app.merchant_id', '')
  await setHeaders(db, merchantId)
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query(sql, params)
  if (res.rows.length !== 1) throw new Error(`expected one row, got ${res.rows.length}: ${sql}`)
  return res.rows[0] as T
}

export async function value<T = unknown>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const row = await one<Record<string, T>>(db, sql, params)
  return Object.values(row)[0] as T
}

export async function expectError(db: Db, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await db.query('savepoint expect_error')
  try {
    await db.query(sql, params)
  } catch (error) {
    await db.query('rollback to savepoint expect_error')
    const message = (error as Error).message
    if (!pattern.test(message)) throw new Error(`expected error matching ${pattern}, got: ${message}`)
    return
  }
  await db.query('rollback to savepoint expect_error')
  throw new Error(`expected error matching ${pattern}, but the statement succeeded: ${sql}`)
}

export const num = (v: unknown): number => Number(v)

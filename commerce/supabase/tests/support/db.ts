import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import pg from 'pg'

// Integration tests run against a disposable PostgreSQL database. Point
// TEST_DATABASE_URL at a server where the user may create databases; the
// suite creates `<db>_commerce_test`, applies a Supabase stub + every
// migration, and drops nothing else.
export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'

const SUPABASE_DIR = resolve(__dirname, '..', '..')

export function testDatabaseUrl(name = 'commerce_test'): string {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  return url.toString()
}

export async function createTestDatabase(name = 'commerce_test', withSeed = false): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${name} with (force)`)
    await admin.query(`create database ${name}`)
  } finally {
    await admin.end()
  }

  const url = testDatabaseUrl(name)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(readFileSync(join(SUPABASE_DIR, 'tests', 'support', 'supabase-stub.sql'), 'utf8'))
    const migrations = readdirSync(join(SUPABASE_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    for (const file of migrations) {
      try {
        await client.query(readFileSync(join(SUPABASE_DIR, 'migrations', file), 'utf8'))
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`)
      }
    }
    if (withSeed) {
      await client.query(readFileSync(join(SUPABASE_DIR, 'seed.sql'), 'utf8'))
    }
  } finally {
    await client.end()
  }
  return url
}

export type Db = pg.PoolClient

let pool: pg.Pool | undefined

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.COMMERCE_TEST_DB_URL ?? testDatabaseUrl(), max: 4 })
  }
  return pool
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = undefined
}

/** Runs `fn` inside a transaction that is always rolled back. */
export async function inTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    return await fn(client)
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
}

/** Database owner with no JWT: migrations, SQL editor, pg_cron. */
export async function asSystem(db: Db): Promise<void> {
  await db.query(`reset role; select set_config('request.jwt.claims', '', true)`)
}

/** Edge functions using the service-role key. */
export async function asService(db: Db): Promise<void> {
  await db.query('set local role service_role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })])
}

/** A signed-in user (staff or customer) calling through PostgREST. */
export async function asUser(db: Db, userId: string, email = 'user@example.com'): Promise<void> {
  await db.query('set local role authenticated')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated', email }),
  ])
}

/** An anonymous storefront visitor. */
export async function asAnon(db: Db): Promise<void> {
  await db.query('set local role anon')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
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

/** Asserts that `sql` fails with a message matching `pattern` (uses a savepoint). */
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

// Test helpers: a fresh Cloudflare-database schema in Node's built-in SQLite, with the
// reference data the Postgres migrations seed, and callers acting as different people.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, type Identity } from './context.ts'
import { migrate } from './migrate.ts'
import { handleRest, type RestResponse } from './rest/index.ts'
import { nodeSql, type Sql } from './sql.ts'

export const MERCHANT_1 = '00000000-0000-4000-8000-000000000001'

const seed = readFileSync(resolve(import.meta.dirname, 'generated', 'seed.sql'), 'utf8')

export function freshDatabase(): Sql {
  const db = new DatabaseSync(':memory:')
  const sql = nodeSql(db)
  migrate(sql)
  sql.transaction(() => sql.script(seed))
  return sql
}

class Rollback extends Error {}

/** Runs fn and undoes everything it wrote. */
export function rolledBack<T>(sql: Sql, fn: () => T): T {
  let result: T
  try {
    sql.transaction(() => {
      result = fn()
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  return result!
}

export function context(sql: Sql, identity: Partial<Identity> & Pick<Identity, 'role'>): Context {
  return new Context(sql, { uid: null, sessionId: null, ...identity })
}

export const asService = (sql: Sql, merchant: string | null = MERCHANT_1) => context(sql, { role: 'service_role', merchantHeader: merchant })
export const asAnon = (sql: Sql, merchant: string | null = MERCHANT_1) => context(sql, { role: 'anon', merchantHeader: merchant })
export const asUser = (sql: Sql, uid: string, extra: Partial<Identity> = {}) => context(sql, { role: 'authenticated', uid, ...extra })

/** A second business, with its own owner role. */
export function createMerchant(sql: Sql, name = 'Second Store'): string {
  const id = randomUUID()
  sql.run('INSERT INTO merchants (id, name, number, slug, status) VALUES (?, ?, ?, ?, ?)', [id, name, 900 + Math.floor(Math.random() * 1000), `store-${id.slice(0, 8)}`, 'ACTIVE'])
  sql.run("INSERT INTO roles (id, merchant_id, code, name, is_system, rank) VALUES (?, ?, 'OWNER', 'Owner', 1, 100)", [randomUUID(), id])
  sql.run("INSERT INTO roles (id, merchant_id, code, name, is_system, rank) VALUES (?, ?, 'VIEWER', 'Viewer', 1, 10)", [randomUUID(), id])
  return id
}

/** A staff member of a business with one of its roles. */
export function createStaff(sql: Sql, roleCode: string, merchant = MERCHANT_1, email = `${roleCode.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`): string {
  const id = randomUUID()
  sql.run('INSERT INTO users (id, email, clerk_user_id, user_metadata) VALUES (?, ?, ?, ?)', [id, email, `user_${id.slice(0, 8)}`, JSON.stringify({ full_name: `Test ${roleCode}` })])
  const role = sql.all('SELECT id FROM roles WHERE merchant_id = ? AND code = ?', [merchant, roleCode])[0]
  if (!role) throw new Error(`no role ${roleCode} in ${merchant}`)
  sql.run('INSERT INTO profiles (id, merchant_id, role_id, email, full_name, is_active) VALUES (?, ?, ?, ?, ?, 1)', [id, merchant, role.id as string, email, `Test ${roleCode}`])
  return id
}

export interface Call {
  status: number
  body: unknown
  headers: Record<string, string>
}

/** One /rest/v1 request, as supabase-js would send it. */
export function rest(sql: Sql, ctx: Context, method: string, target: string, opts: { body?: unknown; prefer?: string; accept?: string } = {}): Call {
  const [path, search = ''] = target.split('?')
  const res: RestResponse = handleRest(sql, ctx, {
    method, path, search,
    headers: { prefer: opts.prefer, accept: opts.accept },
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  })
  return { status: res.status, headers: res.headers, body: res.body === null ? null : JSON.parse(res.body) }
}

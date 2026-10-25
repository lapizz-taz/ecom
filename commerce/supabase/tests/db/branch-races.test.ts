// Two staff moving stock between branches at the same moment, as real transactions on two
// connections, in a database of its own (like stock-race.test.ts): a transfer never moves more than
// its source branch holds, the central branch included, and two transfers of the same products in a
// different item order wait for each other instead of deadlocking.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, createTestDatabase, MERCHANT_1, value, type Db } from '../support/db'
import { createProduct, createStaff } from '../support/fixtures'

const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool

beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_branch_race'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

async function committed<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.query('begin')
  try {
    const out = await work()
    await db.query('commit')
    return out
  } catch (e) {
    await db.query('rollback')
    throw e
  }
}

let admin: string
let central: string

/** Branch stock on, with a central warehouse and the named stores; returns the stores' ids. */
async function branches(db: Db, ...names: string[]): Promise<string[]> {
  return committed(db, async () => {
    if (!admin) admin = await createStaff(db, 'ADMIN')
    await asUser(db, admin)
    const on = await value<{ branches: Array<{ id: string; is_central: boolean }> }>(db, `select public.branches_enable(true)`)
    central = on.branches.find((b) => b.is_central)!.id
    const ids: string[] = []
    for (const name of names) ids.push((await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name })])).id)
    return ids
  })
}

const items = (...lines: Array<[string, number]>) => JSON.stringify(lines.map(([variant_id, quantity]) => ({ variant_id, quantity })))

/** Starts a transfer in an open transaction (the caller commits or rolls back). */
async function startTransfer(db: Db, from: string, to: string, lines: string): Promise<void> {
  await db.query('begin')
  await asUser(db, admin)
  await db.query(`select public.branch_transfer($1, $2, $3)`, [from, to, lines])
}

/** A whole transfer in its own transaction: 'moved', or the error it ended with. */
async function transfer(db: Db, from: string, to: string, lines: string): Promise<string> {
  try {
    await startTransfer(db, from, to, lines)
    await db.query('commit')
    return 'moved'
  } catch (e) {
    await db.query('rollback')
    return (e as Error).message
  }
}

/** Returns once the connection is waiting for a lock, or its work has ended (whichever is first). */
async function waitingOrDone(watcher: Db, pid: number, work: Promise<unknown>): Promise<void> {
  let done = false
  work.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 100 && !done; i++) {
    if (await value<boolean>(watcher, `select coalesce((select wait_event_type = 'Lock' from pg_stat_activity where pid = $1), false)`, [pid])) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function stock(db: Db, variant: string) {
  return committed(db, async () => {
    await asUser(db, admin)
    const r = await value<{ items: Array<{ variant_id: string; total: number; branches: Record<string, number> }> }>(db, `select public.branch_stock_list(null, 200, 0)`)
    return r.items.find((i) => i.variant_id === variant)!
  })
}

async function withThree(test: (a: Db, b: Db, watcher: Db) => Promise<void>) {
  const a = (await pool.connect()) as Db
  const b = (await pool.connect()) as Db
  const watcher = (await pool.connect()) as Db
  try {
    await test(a, b, watcher)
  } finally {
    a.release()
    b.release()
    watcher.release()
  }
}

describe.skipIf(onEngine)('stock moved between branches at the same moment', () => {
  it('two transfers out of the central branch never move more than it holds', () =>
    withThree(async (a, b, watcher) => {
      const [banani, mirpur] = await branches(a, 'Banani store', 'Mirpur store')
      const { variantIds: [v] } = await committed(a, () => createProduct(a, { price: 500, stock: 10 }))

      // One manager is moving 8 of the 10 to Banani; another moves 8 to Mirpur before that is saved.
      await startTransfer(a, central, banani, items([v, 8]))
      const pid = await value<number>(b, 'select pg_backend_pid()')
      const second = transfer(b, central, mirpur, items([v, 8]))
      await waitingOrDone(watcher, pid, second)
      await a.query('commit')

      expect(await second).toMatch(/only 2 in stock/)
      const s = await stock(a, v)
      expect([s.total, s.branches[central], s.branches[banani], s.branches[mirpur] ?? 0]).toEqual([10, 2, 8, 0])
    }))

  it('a transfer waiting for one product does not sit on another (no deadlock between two transfers)', () =>
    withThree(async (a, b, watcher) => {
      const [gulshan, dhanmondi] = await branches(a, 'Gulshan store', 'Dhanmondi store')
      const [{ variantIds: [v1] }, { variantIds: [v2] }] = await committed(a, async () =>
        [await createProduct(a, { price: 400, stock: 20 }), await createProduct(a, { price: 400, stock: 20 })])
      const [low, high] = [v1, v2].sort()
      expect(await transfer(a, central, gulshan, items([low, 10], [high, 10]))).toBe('moved')

      // Another transfer out of Gulshan is busy with the lower product; this one lists the higher first.
      await startTransfer(a, gulshan, central, items([low, 1]))
      const pid = await value<number>(b, 'select pg_backend_pid()')
      const second = transfer(b, gulshan, dhanmondi, items([high, 3], [low, 3]))
      await waitingOrDone(watcher, pid, second)

      // While it waits, the higher product is free for anyone else.
      const higherFree = await committed(watcher, async () => {
        await asSystem(watcher, MERCHANT_1)
        return watcher.query(`select 1 from public.branch_stock where branch_id = $1 and variant_id = $2 for update nowait`, [gulshan, high])
          .then(() => 'free', (e: Error) => e.message)
      }).catch((e: Error) => e.message)
      await a.query('commit')

      expect(higherFree).toBe('free')
      expect(await second).toBe('moved')
      const [sl, sh] = [await stock(a, low), await stock(a, high)]
      expect([sl.branches[gulshan], sl.branches[dhanmondi], sh.branches[gulshan], sh.branches[dhanmondi]]).toEqual([6, 3, 7, 3])
    }))
})

// Two web orders holding the same products in opposite cart order used to deadlock: each locked
// its first product's stock row and then waited for the other's. Every stock-moving function now
// locks the rows it needs in one fixed order (by variant id) first. This proves the order on real
// connections: while the lower variant is held elsewhere, an order for [higher, lower] must wait
// without holding the higher row. Runs outside the rolled-back test transaction and cleans up.
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, closePool, getPool, value, type Db } from '../support/db'
import { createProduct, orderPayload } from '../support/fixtures'

afterAll(closePool)

/** The Cloudflare engine runs one statement at a time: there are no row locks to order there. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

async function waitUntilBlocked(watcher: Db, pid: number, order: Promise<unknown>): Promise<void> {
  // An order that ends (placed or refused) before it waits is reported as it is, not as a timeout.
  let settled: string | null = null
  order.then(() => { settled = 'the order was placed without waiting' }, (e: Error) => { settled = `the order failed: ${e.message}` })
  for (let i = 0; i < 200; i++) {
    const waiting = await value<boolean>(watcher, `select coalesce((select wait_event_type = 'Lock' from pg_stat_activity where pid = $1), false)`, [pid])
    if (waiting) return
    if (settled) throw new Error(settled)
    await new Promise((r) => setTimeout(r, 50))
  }
  const state = await value<string>(watcher, `select coalesce((select coalesce(wait_event_type, '') || '/' || coalesce(wait_event, '') || ' ' || state from pg_stat_activity where pid = $1), 'gone')`, [pid])
  throw new Error(`the order never waited for the held stock row (${state})`)
}

describe.skipIf(onEngine)('stock rows are locked in one fixed order', () => {
  it('an order waiting for one product does not sit on another product (no deadlock)', async () => {
    const holder = (await getPool().connect()) as Db
    const buyer = (await getPool().connect()) as Db
    const prober = (await getPool().connect()) as Db
    const products: string[] = []
    let pending: Promise<unknown> | null = null
    try {
      await holder.query('begin')
      for (let i = 0; i < 2; i++) products.push((await createProduct(holder, { price: 300, stock: 20 })).productId)
      await holder.query('commit')

      await prober.query('begin')
      await asSystem(prober)
      const [low, high] = (await prober.query<{ variant_id: string }>(
        `select variant_id from public.inventory where product_id = any($1::uuid[]) order by variant_id`, [products])).rows.map((r) => r.variant_id)
      await prober.query('commit')

      // Someone else is busy with the lower product.
      await holder.query('begin')
      await asSystem(holder)
      await holder.query(`select 1 from public.inventory where variant_id = $1 for update`, [low])

      // A customer's cart lists the higher product first.
      await buyer.query('begin')
      await asSystem(buyer)
      const pid = await value<number>(buyer, 'select pg_backend_pid()')
      pending = buyer.query(`select id from public._create_order($1, 'STOREFRONT')`,
        [JSON.stringify(orderPayload({ phone: '01711000777', items: [{ variantId: high, quantity: 1 }, { variantId: low, quantity: 1 }] }))])
      pending.catch(() => undefined)
      await waitUntilBlocked(prober, pid, pending)

      // While it waits, the higher product is still free: it took nothing out of order.
      await prober.query('begin')
      await asSystem(prober)
      await expect(prober.query(`select 1 from public.inventory where variant_id = $1 for update nowait`, [high])).resolves.toBeTruthy()
      await prober.query('rollback')

      // Once the other work finishes, the order goes through with both lines reserved.
      await holder.query('rollback')
      const placed = await pending as { rows: Array<{ id: string }> }
      pending = null
      expect(await value<number>(buyer, `select count(*)::int from public.stock_reservations where order_id = $1`, [placed.rows[0].id])).toBe(2)
      await buyer.query('rollback')
    } finally {
      await holder.query('rollback').catch(() => undefined)
      if (pending) await pending.catch(() => undefined)
      await buyer.query('rollback').catch(() => undefined)
      await prober.query('rollback').catch(() => undefined)
      if (products.length) {
        // Stock history refuses deletes (as it should), so the clean-up runs with triggers off.
        await holder.query('begin')
        await asSystem(holder)
        await holder.query(`set local session_replication_role = replica`)
        await holder.query(`delete from public.inventory_movements where product_id = any($1::uuid[])`, [products])
        await holder.query(`delete from public.inventory where product_id = any($1::uuid[])`, [products])
        await holder.query(`delete from public.product_variants where product_id = any($1::uuid[])`, [products])
        await holder.query(`delete from public.products where id = any($1::uuid[])`, [products])
        await holder.query('commit')
      }
      holder.release()
      buyer.release()
      prober.release()
    }
  })
})

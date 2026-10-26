import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'
import { PHONE_A, callEach, callable, createMerchant, crossLinksSql, label, snapshotSql, storeIds, type Call, type Target } from '../support/sweep'

afterAll(closePool)

/**
 * Sweeps over every function the API exposes (and, for roles, every table and view):
 *  - cross-store: store B (its owner, or a visitor on its store) calls each function with store A's
 *    ids. No call may change a row of store A, answer with store A's private data, or save a row
 *    that points into store A.
 *  - roles: the Call role and the Moderator call each function with their own store's ids and read
 *    each table; no answer may carry a cost, a profit or an expense (nor, for the Moderator, a customer).
 * Ids are picked from the argument names (`p_order_id` → the order, `p_category_id` → a category, …);
 * json arguments carry the same ids under the usual keys; text arguments named like a phone or a
 * search get the customer's phone. Every function runs twice: ids only, then with every other
 * argument filled with a plausible value, so calls get past "x is required".
 */

/** The sweeps read the Postgres catalogs (pg_proc, pg_constraint, information_schema), which the
 *  Cloudflare engine does not have; the focused tests run there too. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

const MARK = 'IDORMARK'

describe('cross-store sweep', () => {
  it.skipIf(onEngine)('lets no store reach another store\'s rows through any function it may call', { timeout: 900_000 }, () =>
    inTx(async (db) => {
      // Store A (Merchant #1) with private data that carries a marker.
      const product = await createProduct(db, { name: `${MARK} product`, price: 500, cost: 200 })
      const order = await createOrder(db, { phone: PHONE_A, name: `${MARK} Customer`, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      const ownerA = await createStaff(db, 'OWNER')
      await asSystem(db)
      await db.query(`update public.orders set customer_note = $1 where id = $2`, [`${MARK} note`, order.id])
      const ids = await storeIds(db, MERCHANT_1)
      const a: Target = { order: order.id, product: product.productId, variant: product.variantIds[0], customer: order.customer_id, owner: ownerA, merchant: MERCHANT_1 }
      const privateIds = new Set([a.order, a.customer, ...Object.entries(ids).filter(([t]) => /order|customer|payment|ledger|message|conversation/.test(t)).map(([, id]) => id)])

      // Store B and who calls from it.
      const m2 = await createMerchant(db)
      const ownerB = await createStaff(db, 'OWNER', undefined, m2)

      await asSystem(db)
      const snapshot = await snapshotSql(db)
      const before = await value<string>(db, snapshot, [MERCHANT_1])
      const crossLinks = await crossLinksSql(db)
      expect(await value<string>(db, crossLinks)).toBe('')
      await db.query(`set local statement_timeout = '5s'`)

      const problems: string[] = []
      const check = (who: string) => async (c: Call) => {
        const leaked = [MARK, PHONE_A, ...privateIds].filter((m) => !c.inputs.includes(m) && c.out?.includes(m))
        if (leaked.length) problems.push(`${who} ${label(c)} ${c.failed ? 'error' : 'answer'} shows store A data (${leaked.join(', ')}): ${c.out?.slice(0, 400)}`)
        if (c.failed) return
        await db.query('reset role')
        if (await value<string>(db, snapshot, [MERCHANT_1]) !== before) problems.push(`${who} ${label(c)} changed store A's rows`)
        const links = await value<string>(db, crossLinks)
        if (links) problems.push(`${who} ${label(c)} saved a row that points into store A: ${links}`)
      }

      await asUser(db, ownerB, 'owner-b@example.com', m2)
      const owner = await callEach(db, await callable(db, 'authenticated'), ids, a, check('owner of store B'))
      await asSystem(db)
      const anonFns = await callable(db, 'anon')
      await asAnon(db, m2)
      const visitor = await callEach(db, anonFns, ids, a, check('visitor on store B'))

      await asSystem(db)
      expect(await value<string>(db, snapshot, [MERCHANT_1])).toBe(before)
      // The sweep reached enough of the API to mean something.
      expect(owner.calls).toBeGreaterThan(2000)
      expect(owner.answered).toBeGreaterThan(300)
      expect(visitor.calls).toBeGreaterThan(50)
      expect(problems).toEqual([])
      expect((await one<{ n: number }>(db, `select count(*)::int as n from public.orders where id = $1 and merchant_id = $2`, [a.order, MERCHANT_1])).n).toBe(1)
    }))

  it('answers "order not found" when a note, production order, kept advance or fraud check names another store\'s order', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { phone: '01711999002', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['CONFIRMED'])
      const ownerA = await createStaff(db, 'OWNER')
      const m2 = await createMerchant(db)
      const ownerB = await createStaff(db, 'OWNER', undefined, m2)

      await asUser(db, ownerB, 'owner-b@example.com', m2)
      await expectError(db, `select public.add_order_note($1, 'Call me')`, [order.id], /NOT_FOUND/)
      await expectError(db, `select public.admin_create_production_order($1)`, [order.id], /NOT_FOUND/)
      await expectError(db, `select public.retain_order_advance($1, 'Keep it')`, [order.id], /NOT_FOUND/)
      await expectError(db, `select public.record_fraud_check($1)`, [JSON.stringify({ phone: '01711999002', order_id: order.id, provider: 'internal' })], /NOT_FOUND/)

      // A fraud check of store B pinned to store A's order would have blocked deleting that order (a store reset does).
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.fraud_checks where order_id = $1 and merchant_id <> $2`, [order.id, MERCHANT_1])).toBe(0)

      // The store's own staff still can.
      await asUser(db, ownerA, 'owner-a@example.com')
      expect((await one<{ order_id: string }>(db, `select order_id from public.add_order_note($1, 'Customer asked for evening delivery')`, [order.id])).order_id).toBe(order.id)
      expect((await one<{ order_id: string }>(db, `select order_id from public.record_fraud_check($1)`, [JSON.stringify({ phone: '01711999002', order_id: order.id, provider: 'internal' })])).order_id).toBe(order.id)
      expect((await one<{ order_id: string }>(db, `select order_id from public.admin_create_production_order($1)`, [order.id])).order_id).toBe(order.id)
    }))
})

describe('role sweep', () => {
  // Amounts no other figure in the store produces: the unit cost, the gross profit of the one
  // delivered order (9,000 − 4,321.77) and an expense.
  const COST = '4321.77'
  const PROFIT = '4678.23'
  const EXPENSE = '3333.33'
  const CUSTOMER = 'CUSTMARK'

  it.skipIf(onEngine)('shows the Call role no cost, profit or expense, and the Moderator no customer either, through any function, table or view', { timeout: 900_000 }, () =>
    inTx(async (db) => {
      const product = await createProduct(db, { name: 'Sweep product', price: 9000, cost: Number(COST), stock: 5 })
      const order = await createOrder(db, { phone: PHONE_A, name: `${CUSTOMER} Customer`, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      const rent = await value<string>(db, `select id from public.finance_categories where code = 'RENT'`)
      await asUser(db, await createStaff(db, 'FINANCE_MANAGER'))
      await db.query(`select public.create_finance_transaction($1)`, [JSON.stringify({ type: 'EXPENSE', category_id: rent, amount: Number(EXPENSE), txn_date: new Date().toISOString().slice(0, 10) })])
      // The owner does see them (the markers are where the sweep looks).
      await asUser(db, owner)
      expect(JSON.stringify(await value(db, `select public.order_cost_summary($1)`, [order.id]))).toContain(COST)

      await asSystem(db)
      const ids = await storeIds(db, MERCHANT_1)
      const a: Target = { order: order.id, product: product.productId, variant: product.variantIds[0], customer: order.customer_id, owner, merchant: MERCHANT_1 }
      const fns = await callable(db, 'authenticated')
      const relations = (await db.query<{ t: string; cols: string[] }>(
        `select c.relname as t, array_agg(a.attname::text order by a.attnum) as cols
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and has_table_privilege('authenticated', c.oid, 'select')
          group by c.relname order by 1`,
      )).rows
      await db.query(`set local statement_timeout = '5s'`)

      const problems: string[] = []
      for (const [role, forbidden] of [['CALL', [COST, PROFIT, EXPENSE]], ['MODERATOR', [COST, PROFIT, EXPENSE, CUSTOMER, PHONE_A]]] as const) {
        const user = await createStaff(db, role)
        await asUser(db, user)
        const shows = (out: string | null, inputs: string[] = []) => forbidden.filter((m) => !inputs.includes(m) && out?.includes(m))
        await callEach(db, fns, ids, a, async (c) => {
          const seen = shows(c.out, c.inputs)
          if (seen.length) problems.push(`${role} ${label(c)} ${c.failed ? 'error' : 'answer'} shows ${seen.join(', ')}: ${c.out?.slice(0, 300)}`)
        })
        // Tables and views the API serves: the whole row, or column by column where some are closed.
        await db.query('savepoint read')
        for (const r of relations) {
          const tryRead = async (sql: string): Promise<string | null | undefined> => {
            try {
              return (await db.query<{ out: string | null }>(sql)).rows[0]?.out ?? null
            } catch {
              await db.query('rollback to savepoint read')
              return undefined
            }
          }
          const whole = await tryRead(`select string_agg(to_jsonb(x)::text, E'\\n') as out from (select * from public."${r.t}" limit 200) x`)
          const outs = [whole]
          if (whole === undefined) {
            for (const col of r.cols) outs.push(await tryRead(`select string_agg(x::text, E'\\n') as out from (select "${col}" as x from public."${r.t}" limit 200) s`))
          }
          for (const out of outs) {
            const seen = shows(out ?? null)
            if (seen.length) problems.push(`${role} reads ${r.t}: shows ${seen.join(', ')}`)
          }
        }
        await db.query('release savepoint read')
        await asSystem(db)
      }
      expect(problems).toEqual([])
    }))

  it('needs the right to see orders to duplicate one (a copy shows the customer)', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 5 })
      const order = await createOrder(db, { phone: '01711999003', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, await createStaff(db, 'MODERATOR'))
      await expectError(db, `select public.admin_duplicate_order($1)`, [order.id], /PERMISSION_DENIED|orders.view/)
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      expect((await one<{ customer_phone: string }>(db, `select customer_phone from public.admin_duplicate_order($1)`, [order.id])).customer_phone).toBe('01711999003')
    }))
})

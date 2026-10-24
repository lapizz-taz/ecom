import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

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
const PHONE_A = '01711999001'

interface Fn {
  name: string
  argnames: string[]
  argtypes: string[]
  ndefaults: number
}

type Ids = Record<string, string>

interface Target { order: string; product: string; variant: string; customer: string; owner: string; merchant: string }

interface Call { fn: string; pick: string; filled: boolean; inputs: string[]; out: string | null; failed: boolean }

async function createMerchant(db: Db): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  return id
}

/** Functions in the exposed schema that `role` may call (no triggers, no polymorphic or variadic arguments). */
async function callable(db: Db, role: string): Promise<Fn[]> {
  const res = await db.query<{ name: string; argnames: string[] | null; argmodes: string[] | null; argtypes: string[] | null; ndefaults: number }>(
    `select p.proname as name, p.proargnames as argnames, p.proargmodes::text[] as argmodes, p.pronargdefaults as ndefaults,
            (select array_agg(format_type(t, null) order by i) from unnest(p.proargtypes) with ordinality u(t, i)) as argtypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.provariadic = 0
        and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and not exists (select 1 from unnest(p.proargtypes) t where t in ('anyelement'::regtype, 'anyarray'::regtype, 'anynonarray'::regtype, 'anycompatible'::regtype, 'internal'::regtype))
        and has_function_privilege($1, p.oid, 'execute')
      order by p.proname, p.oid`,
    [role],
  )
  return res.rows.map((r) => {
    const types = r.argtypes ?? []
    // proargnames covers every argument (in and out); keep the input ones, in order.
    const names = (r.argnames ?? []).filter((_, i) => !r.argmodes || ['i', 'b'].includes(r.argmodes[i]))
    return { name: r.name, argtypes: types, argnames: types.map((_, i) => names[i] ?? ''), ndefaults: r.ndefaults }
  })
}

/** One id of the store for every table that has a merchant and a uuid id. */
async function storeIds(db: Db, merchant: string): Promise<Ids> {
  const tables = await db.query<{ t: string }>(
    `select c.table_name as t from information_schema.columns c
       join information_schema.columns m on m.table_schema = c.table_schema and m.table_name = c.table_name and m.column_name = 'merchant_id'
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'id' and c.data_type = 'uuid'`,
  )
  const ids: Ids = {}
  for (const { t } of tables.rows) {
    const r = await db.query<{ id: string }>(`select id from public.${t} where merchant_id = $1 limit 1`, [merchant])
    if (r.rows[0]) ids[t] = r.rows[0].id
  }
  return ids
}

/** One fingerprint over every row of a store (the database owner reads past row security). */
async function snapshotSql(db: Db): Promise<string> {
  const tables = await db.query<{ t: string }>(
    `select c.table_name as t from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'merchant_id' order by 1`,
  )
  const parts = tables.rows.map(({ t }) => `select '${t}' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from public.${t} x where merchant_id = $1`)
  return `select md5(string_agg(t || ':' || h, ',' order by t)) from (${parts.join(' union all ')}) s`
}

/** Names every foreign key along which a row of one store points at a row of another (none may). */
async function crossLinksSql(db: Db): Promise<string> {
  const fks = await db.query<{ child: string; col: string; parent: string; pcol: string }>(
    `select c.relname as child, a.attname as col, p.relname as parent, pa.attname as pcol
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class p on p.oid = k.confrelid
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = k.confkey[1]
      where k.contype = 'f' and n.nspname = 'public' and array_length(k.conkey, 1) = 1 and p.relnamespace = n.oid
        and exists (select 1 from pg_attribute m where m.attrelid = c.oid and m.attname = 'merchant_id' and not m.attisdropped)
        and exists (select 1 from pg_attribute m where m.attrelid = p.oid and m.attname = 'merchant_id' and not m.attisdropped)
      order by 1, 2`,
  )
  const parts = fks.rows.map((f) => `select '${f.child}.${f.col}' as link where exists (select 1 from public.${f.child} c join public.${f.parent} p on p.${f.pcol} = c.${f.col} where c.merchant_id is distinct from p.merchant_id)`)
  return `select coalesce(string_agg(link, ', '), '') as links from (${parts.join(' union all ')}) s`
}

/** The store's id for an argument named like `p_<thing>_id`, or null to try the common ones. */
function idFor(arg: string, ids: Ids, a: Target): string | null {
  const base = arg.replace(/^_?p_/, '').replace(/_?ids?$/, '')
  if (/merchant|store|shop|business/.test(base)) return a.merchant
  if (/user|staff|member|employee|owner|agent|assignee/.test(base)) return a.owner
  if (/order_item|item/.test(base)) return ids.order_items ?? a.order
  if (/variant/.test(base)) return a.variant
  if (/product/.test(base)) return a.product
  if (/customer|contact/.test(base)) return a.customer
  if (/order/.test(base)) return a.order
  for (const t of [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies'), `order_${base}s`, `${base.replace(/^order_/, '')}s`]) {
    if (ids[t]) return ids[t]
  }
  return null
}

/**
 * Calls every function in `fns` as the current role, with the target store's ids, ids only and then
 * filled. `check` runs after each call inside a savepoint that is rolled back afterwards (so it may
 * change role and read), and is told whether the call failed (then it must not query).
 */
async function callEach(db: Db, fns: Fn[], ids: Ids, a: Target, check: (c: Call) => Promise<void>): Promise<{ calls: number; answered: number }> {
  const enums = new Map((await db.query<{ type: string; first: string }>(
    `select format_type(t.oid, null) as type, (select enumlabel from pg_enum e where e.enumtypid = t.oid order by enumsortorder limit 1) as first
       from pg_type t where t.typtype = 'e'`,
  )).rows.map((r) => [r.type, r.first]))
  const now = new Date().toISOString()
  const text = (arg: string) => (/phone|mobile|search|query|^_?p_q$|term|keyword/.test(arg) ? PHONE_A : null)
  const fill = (type: string, arg: string): unknown => {
    if (/^(integer|smallint|bigint|numeric|double precision|real)$/.test(type)) return 1
    if (type === 'boolean') return true
    if (type === 'date') return now.slice(0, 10)
    if (type.startsWith('timestamp')) return now
    if (type === 'interval') return '1 day'
    if (type === 'inet') return '127.0.0.1'
    if (type === 'text' || type === 'character varying' || type === 'citext') return text(arg) ?? 'audit'
    if (type === 'text[]') return ['audit']
    if (type === 'integer[]') return [1]
    if (enums.has(type)) return enums.get(type)
    if (type.endsWith('[]') && enums.has(type.slice(0, -2))) return [enums.get(type.slice(0, -2))]
    return null
  }
  const json = (id: string) => JSON.stringify({
    id, ids: [id], order_id: a.order, order_ids: [a.order], product_id: a.product, product_ids: [a.product],
    variant_id: a.variant, customer_id: a.customer, merchant_id: a.merchant, user_id: a.owner,
    items: [{ variant_id: a.variant, product_id: a.product, quantity: 1 }],
    phone: PHONE_A, search: PHONE_A, q: PHONE_A, query: PHONE_A,
  })
  const tryIds = [a.order, a.product, a.variant, a.customer]

  let calls = 0
  let answered = 0
  await db.query('savepoint sweep')
  for (const fn of fns) {
    const unknownUuid = fn.argtypes.some((t, i) => (t === 'uuid' || t === 'uuid[]') && !idFor(fn.argnames[i], ids, a))
    const tries = unknownUuid || fn.argtypes.includes('jsonb') || fn.argtypes.includes('json') ? tryIds : [a.order]
    const named = fn.argnames.every(Boolean)
    const firstDefault = fn.argtypes.length - fn.ndefaults
    for (const [filled, pick] of [false, true].flatMap((f) => tries.map((t) => [f, t] as const))) {
      const params: unknown[] = []
      const args: string[] = []
      const inputs: string[] = []
      fn.argtypes.forEach((type, i) => {
        const arg = fn.argnames[i]
        let v: unknown = null
        if (type === 'uuid' || type === 'uuid[]') {
          const id = idFor(arg, ids, a) ?? pick
          inputs.push(id)
          v = type === 'uuid' ? id : [id]
        } else if (type === 'jsonb' || type === 'json') {
          v = json(pick)
          inputs.push(pick, PHONE_A, a.order, a.product, a.variant, a.customer, a.owner)
        } else if (type === 'text' || type === 'character varying' || type === 'citext') {
          v = text(arg)
        }
        if (v === null && filled) v = fill(type, arg)
        if (v === PHONE_A) inputs.push(PHONE_A)
        if (v === null && named && i >= firstDefault) return
        const ref = v === null ? `null::${type}` : (params.push(v), `$${params.length}::${type}`)
        args.push(named ? `"${arg}" => ${ref}` : ref)
      })
      const sql = `select string_agg(r::text, E'\\n') as out from (select public."${fn.name}"(${args.join(', ')}) as r) s`
      calls += 1
      let out: string | null = null
      let failed = false
      try {
        out = (await db.query<{ out: string | null }>(sql, params)).rows[0]?.out ?? null
        answered += 1
      } catch (e) {
        failed = true
        out = e instanceof Error ? e.message : String(e)
      }
      await check({ fn: fn.name, pick, filled, inputs, out, failed })
      await db.query('rollback to savepoint sweep')
    }
  }
  await db.query('release savepoint sweep')
  return { calls, answered }
}

const label = (c: Call) => `${c.fn}(${c.pick}${c.filled ? ', filled' : ''})`

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

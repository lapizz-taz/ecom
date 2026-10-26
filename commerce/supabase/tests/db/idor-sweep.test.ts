import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'
import { PHONE_A, callEach, callable, createMerchant, crossLinksSql, label, snapshotSql, storeIds, type Call, type Target } from '../support/sweep'

afterAll(closePool)

/**
 * Ids of another store, tried by everyone who is not that store (cross-store-sweep.test.ts does it
 * for store B's owner and a visitor on store B):
 *  - every built-in staff role of store B, since some functions take a different path by role;
 *  - every platform role limited to store B (Super Admin → staff → "assigned stores only"), since a
 *    platform function only keeps them to their stores when it checks the store it acts on.
 * Each calls every function it may call with store A's ids (ids only, then filled). No call may
 * change a row of store A (its own row in merchants included), answer with store A's private data,
 * or save a row that points into store A.
 */

/** The sweep reads the Postgres catalogs, which the Cloudflare engine does not have. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

const MARK = 'IDORMARK'
/** Store A's name: public on its storefront, so only functions closed to visitors must not show it. */
const NAME = 'NAMEMARK Shop'
const STORE_ROLES = ['VIEWER', 'CALL', 'MODERATOR', 'PRODUCTION_MANAGER', 'INVENTORY_MANAGER', 'FINANCE_MANAGER', 'ORDER_MANAGER', 'MANAGER']
const PLATFORM_ROLES = ['OPERATIONS_MANAGER', 'SUPPORT_AGENT', 'BILLING_MANAGER', 'TECHNICAL_SUPPORT', 'PBX_ADMIN', 'VIEWER']

/** Store A (Merchant #1) with private data that carries a marker, and store B. */
async function twoStores(db: Db) {
  const product = await createProduct(db, { name: `${MARK} product`, price: 500, cost: 200 })
  const order = await createOrder(db, { phone: PHONE_A, name: `${MARK} Customer`, items: [{ variantId: product.variantIds[0], quantity: 1 }] })
  const ownerA = await createStaff(db, 'OWNER')
  await asUser(db, ownerA)
  await db.query(`select public.support_ticket_create($1)`, [JSON.stringify({ kind: 'BUG', subject: `${MARK} ticket`, body: `${MARK} the labels print blank` })])
  await asSystem(db)
  await db.query(`update public.orders set customer_note = $1 where id = $2`, [`${MARK} note`, order.id])
  await db.query(`update public.merchants set name = $1 where id = $2`, [NAME, MERCHANT_1])
  const ids = await storeIds(db, MERCHANT_1)
  const a: Target = { order: order.id, product: product.productId, variant: product.variantIds[0], customer: order.customer_id, owner: ownerA, merchant: MERCHANT_1 }
  const privateIds = new Set([a.order, a.customer, ...Object.entries(ids).filter(([t]) => /order|customer|payment|ledger|message|conversation|ticket|invoice/.test(t)).map(([, id]) => id)])
  const m2 = await createMerchant(db)
  return { ids, a, privateIds, m2 }
}

/** Checks after each call: nothing of store A shown, changed or pointed at. */
async function guard(db: Db, privateIds: Set<string>) {
  await asSystem(db)
  const snapshot = await snapshotSql(db)
  const merchantRow = `select md5(m::text) from public.merchants m where id = $1`
  const crossLinks = await crossLinksSql(db)
  const before = [await value<string>(db, snapshot, [MERCHANT_1]), await value<string>(db, merchantRow, [MERCHANT_1])]
  expect(await value<string>(db, crossLinks)).toBe('')
  const open = new Set((await callable(db, 'anon')).map((f) => f.name))
  await db.query(`set local statement_timeout = '5s'`)
  // One line per function and kind of problem, naming who hit it and one example.
  const found = new Map<string, { who: Set<string>; example: string }>()
  const note = (who: string, c: Call, what: string, example = '') => {
    const key = `${c.fn}: ${what}`
    const f = found.get(key) ?? { who: new Set<string>(), example: example.slice(0, 160) }
    f.who.add(who)
    found.set(key, f)
  }
  const check = (who: string) => async (c: Call) => {
    const markers = [MARK, PHONE_A, ...privateIds, ...(open.has(c.fn) ? [] : [NAME])]
    const leaked = markers.filter((m) => !c.inputs.includes(m) && c.out?.includes(m))
    if (leaked.length) note(who, c, `${c.failed ? 'error' : 'answer'} shows store A data (${leaked.join(', ')})`, c.out ?? '')
    if (c.failed) return
    await db.query('reset role')
    if (await value<string>(db, snapshot, [MERCHANT_1]) !== before[0]) note(who, c, "changed store A's rows", label(c))
    if (await value<string>(db, merchantRow, [MERCHANT_1]) !== before[1]) note(who, c, 'changed store A itself (merchants row)', label(c))
    const links = await value<string>(db, crossLinks)
    if (links) note(who, c, `saved a row that points into store A: ${links}`)
  }
  const problems = () => [...found].map(([k, f]) => `${k} — ${[...f.who].join(', ')}${f.example ? ` — ${f.example}` : ''}`).sort()
  const unchanged = async () => {
    await asSystem(db)
    return [await value<string>(db, snapshot, [MERCHANT_1]), await value<string>(db, merchantRow, [MERCHANT_1])]
  }
  return { problems, check, before, unchanged }
}

describe('IDOR sweep', () => {
  it.skipIf(onEngine)('no staff role of another store reaches a store\'s rows through any function', { timeout: 1_800_000 }, () =>
    inTx(async (db) => {
      const { ids, a, privateIds, m2 } = await twoStores(db)
      const g = await guard(db, privateIds)
      const fns = await callable(db, 'authenticated')
      const reached: Record<string, { calls: number; answered: number }> = {}
      for (const role of STORE_ROLES) {
        const user = await createStaff(db, role, undefined, m2)
        await asUser(db, user, `${role.toLowerCase()}-b@example.com`, m2)
        reached[role] = await callEach(db, fns, ids, a, g.check(`${role} of store B`))
      }
      expect(await g.unchanged()).toEqual(g.before)
      for (const role of STORE_ROLES) expect(reached[role].calls, role).toBeGreaterThan(2000)
      expect(reached.MANAGER.answered).toBeGreaterThan(200)
      expect(g.problems()).toEqual([])
    }))

  it('an employee limited to some stores previews and sends announcements only to them', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const limited = await createPlatformStaff(db, 'OPERATIONS_MANAGER', { scope: 'ASSIGNED', merchants: [m2] })
      const everyone = await createPlatformStaff(db, 'OPERATIONS_MANAGER')
      const draft = async (audience: Record<string, unknown>) =>
        value<{ id: string }>(db, `select public.platform_announcement_save($1)`, [JSON.stringify({ kind: 'GENERAL', title: 'Courier rates change', body: 'Steadfast charges change on the 1st.', audience })])
      const preview = (audience: Record<string, unknown>) =>
        value<{ count: number; sample: Array<{ id: string; name?: string }> }>(db, `select public.platform_announcement_preview($1, 'GENERAL')`, [JSON.stringify(audience)])

      await asUser(db, limited, 'ops-b@platform.example', null)
      const mine = await preview({ type: 'ALL' })
      expect(mine.sample.map((s) => s.id)).toEqual([m2])
      expect(mine.count).toBe(1)
      for (const audience of [{ type: 'ALL' }, { type: 'MERCHANTS', merchants: [MERCHANT_1] }, { type: 'MERCHANTS', merchants: [m2, MERCHANT_1] }]) {
        const d = await draft(audience)
        await asSystem(db, null)
        const count = await value<number>(db, `select count(*)::int from public._platform_announcement_audience($1)`, [JSON.stringify(audience)])
        await asUser(db, limited, 'ops-b@platform.example', null)
        await expectError(db, `select public.platform_announcement_send($1, $2, 'Monthly notice')`, [d.id, count], /only to the stores assigned to you/)
      }
      const ok = await draft({ type: 'MERCHANTS', merchants: [m2] })
      expect(await value(db, `select public.platform_announcement_send($1, 1, 'Monthly notice')`, [ok.id])).toMatchObject({ status: 'SENT', delivered: 1 })

      // An employee who sees every store is not affected.
      await asUser(db, everyone, 'ops@platform.example', null)
      const all = await preview({ type: 'ALL' })
      expect(all.sample.map((s) => s.id)).toEqual(expect.arrayContaining([MERCHANT_1, m2]))
      const d = await draft({ type: 'ALL' })
      expect(await value(db, `select public.platform_announcement_send($1, $2, 'Monthly notice')`, [d.id, all.count])).toMatchObject({ status: 'SENT' })
    }))

  it('the bulk feature preview names only the stores the employee may change', () =>
    inTx(async (db) => {
      const m2 = await createMerchant(db)
      const limited = await createPlatformStaff(db, 'OPERATIONS_MANAGER', { scope: 'ASSIGNED', merchants: [m2] })
      await asUser(db, limited, 'ops-b@platform.example', null)
      const p = await value<{ items: Array<Record<string, unknown>> }>(db, `select public.platform_feature_bulk_preview($1, 'sms', true)`, [[MERCHANT_1, m2]])
      expect(p.items.find((i) => i.id === MERCHANT_1)).toEqual({ id: MERCHANT_1, allowed: false })
      expect(p.items.find((i) => i.id === m2)).toMatchObject({ id: m2, allowed: true, name: expect.any(String), number: expect.any(Number) })
    }))

  it.skipIf(onEngine)('no platform employee limited to other stores reaches a store\'s rows through any function', { timeout: 1_800_000 }, () =>
    inTx(async (db) => {
      const { ids, a, privateIds, m2 } = await twoStores(db)
      const g = await guard(db, privateIds)
      const fns = await callable(db, 'authenticated')
      const reached: Record<string, { calls: number; answered: number }> = {}
      for (const role of PLATFORM_ROLES) {
        const user = await createPlatformStaff(db, role, { scope: 'ASSIGNED', merchants: [m2] })
        await asUser(db, user, `${role.toLowerCase()}@platform.example`, null)
        reached[role] = await callEach(db, fns, ids, a, g.check(`platform ${role} (store B only)`))
      }
      expect(await g.unchanged()).toEqual(g.before)
      for (const role of PLATFORM_ROLES) expect(reached[role].calls, role).toBeGreaterThan(2000)
      // The employees do reach the platform functions (they are not all refused for want of a store).
      expect(reached.OPERATIONS_MANAGER.answered).toBeGreaterThan(50)
      expect(g.problems()).toEqual([])
    }))
})

// The whole order status matrix, generated from the transition table: every reachable
// status is tried against every other status. Allowed moves succeed (or fail only on a
// stated precondition), everything else is refused as INVALID_TRANSITION, final statuses
// accept nothing, roles are checked on the staff function, and a repeated move changes
// nothing twice.
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, inventory, transition } from '../support/fixtures'

afterAll(closePool)

// Every value of the order_status enum (checked against the catalog by the first test).
const STATUSES = ['PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PROCESSING',
  'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY',
  'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'CANCELLED', 'PENDING_CANCEL', 'LOST', 'REJECTED_FRAUD', 'PRE_ORDER'] as const
type Status = (typeof STATUSES)[number]

/** Statuses that, by the table, lead nowhere: only Super Edit's override may leave them. */
const FINAL: Status[] = ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED']

let phone = 1000
const nextPhone = () => `0171${String(++phone).padStart(7, '0')}`

/** A fresh order moved to `status` along the allowed route, booking a courier before it ships. */
async function orderAt(db: Db, variantId: string, courier: string, status: Status): Promise<string | null> {
  await asSystem(db)
  const o = await createOrder(db, { phone: nextPhone(), items: [{ variantId, quantity: 1 }] })
  if (status === 'PENDING') return o.id
  // Cast to text[]: node-pg hands an enum array back as its text form otherwise.
  const path = await value<string[] | null>(db, `select public._order_status_path('PENDING'::public.order_status, $1::public.order_status)::text[]`, [status])
  if (!path) return null
  for (const step of path) {
    if (step === 'SHIPPED') {
      await asSystem(db)
      await value(db, `select id from public.assign_courier($1, $2, $3, 70, null, $3)`, [o.id, courier, `CN-${o.id.slice(0, 8)}`])
    }
    await transition(db, o.id, step)
  }
  return o.id
}

/** Tries one move under a savepoint; returns 'ok', or the error message. */
async function attempt(db: Db, orderId: string, to: Status): Promise<string> {
  await db.query('savepoint matrix_try')
  try {
    await asSystem(db)
    await db.query(`select public._transition_order($1, $2::public.order_status, 'matrix')`, [orderId, to])
    await db.query('rollback to savepoint matrix_try')
    return 'ok'
  } catch (e) {
    await db.query('rollback to savepoint matrix_try')
    return (e as Error).message
  }
}

describe('order status matrix', () => {
  it('every allowed move works or names its precondition; every other move is refused; final statuses accept nothing', () =>
    inTx(async (db) => {
      await asSystem(db)
      const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost) values ('Matrix Courier', 'pathao', false, 70) returning id`)
      const p = await createProduct(db, { price: 500, cost: 200, stock: 1000 })
      const allowed = new Set((await db.query(`select from_status, to_status from public.order_status_transitions`)).rows
        .map((r: { from_status: string; to_status: string }) => `${r.from_status}>${r.to_status}`))
      expect(allowed.size).toBeGreaterThanOrEqual(80)

      const reachable: Status[] = []
      const unreachable: Status[] = []
      const reasons: Record<string, string> = {}
      const preconditions: string[] = []
      const wrong: string[] = []
      for (const from of STATUSES) {
        await db.query('savepoint matrix_reach')
        const id = await orderAt(db, p.variantIds[0], courier, from).catch((e: Error) => { reasons[from] = e.message.slice(0, 120); return null })
        if (!id) { await db.query('rollback to savepoint matrix_reach'); unreachable.push(from); continue }
        await db.query('release savepoint matrix_reach')
        reachable.push(from)
        for (const to of STATUSES) {
          if (to === from) continue
          const result = await attempt(db, id, to)
          const isAllowed = allowed.has(`${from}>${to}`)
          if (isAllowed) {
            if (result !== 'ok') {
              // An allowed move may still need something first (a courier, the returned items); never a silent no-op.
              if (/^VALIDATION:/.test(result)) preconditions.push(`${from}>${to}: ${result.slice(0, 80)}`)
              else wrong.push(`${from}>${to} allowed but failed: ${result.slice(0, 100)}`)
            }
          } else if (!/INVALID_TRANSITION/.test(result)) {
            wrong.push(`${from}>${to} not allowed but ${result === 'ok' ? 'succeeded' : `failed with: ${result.slice(0, 100)}`}`)
          }
        }
      }
      expect(wrong).toEqual([])
      // The route finder reaches every status from a plain order, so the whole matrix was walked.
      expect(unreachable.map((s) => `${s}: ${reasons[s]}`)).toEqual([])
      expect(reachable.length).toBe(STATUSES.length)
      expect(STATUSES.length).toBe(await value<number>(db, `select cardinality(enum_range(null::public.order_status))`))
      // Final statuses: nothing leads out of them.
      for (const s of FINAL) expect([...allowed].filter((k) => k.startsWith(`${s}>`))).toEqual([])
      // The preconditions seen are only the ones the product promises.
      for (const line of preconditions) expect(line).toMatch(/assign a courier|came back|picked|never picked|returning instead|cancel the order/)
    }))

  it('roles: viewers cannot move orders, order managers can, cancelling needs a reason, fraud decisions need fraud.review', () =>
    inTx(async (db) => {
      await asSystem(db)
      const p = await createProduct(db, { price: 500, cost: 200, stock: 100 })
      const viewer = await createStaff(db, 'VIEWER')
      const finance = await createStaff(db, 'FINANCE_MANAGER')
      const manager = await createStaff(db, 'ORDER_MANAGER')
      const o = await createOrder(db, { phone: nextPhone(), items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await transition(db, o.id, 'CONFIRMED')

      await asUser(db, viewer)
      await expectError(db, `select public.transition_order_status($1, 'PROCESSING')`, [o.id], /PERMISSION_DENIED|orders\.status/)
      await asUser(db, finance)
      await expectError(db, `select public.transition_order_status($1, 'PROCESSING')`, [o.id], /PERMISSION_DENIED|orders\.status/)
      await asUser(db, manager)
      expect(await value(db, `select status from public.transition_order_status($1, 'PROCESSING')`, [o.id])).toBe('PROCESSING')
      await expectError(db, `select public.transition_order_status($1, 'CANCELLED')`, [o.id], /cancellation reason is required/)
      await expectError(db, `select public.transition_order_status($1, 'PARTIALLY_DELIVERED')`, [o.id], /which items came back|INVALID_TRANSITION/)
      expect(await value(db, `select status from public.transition_order_status($1, 'CANCELLED', 'customer changed their mind')`, [o.id])).toBe('CANCELLED')
      // The stock reserved for it is back.
      const inv = await inventory(db, p.variantIds[0])
      expect(inv.reserved).toBe(0)
      expect(inv.on_hand).toBe(100)
    }))

  it('a repeated move is refused and leaves stock and money exactly as the first one did', () =>
    inTx(async (db) => {
      await asSystem(db)
      const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost) values ('Twice Courier', 'pathao', false, 60) returning id`)
      const p = await createProduct(db, { price: 800, cost: 300, stock: 10 })
      const o = await createOrder(db, { phone: nextPhone(), items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      for (const s of ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP']) await transition(db, o.id, s)
      await value(db, `select id from public.assign_courier($1, $2, 'CN-TWICE', 60)`, [o.id, courier])
      await transition(db, o.id, 'SHIPPED')
      await transition(db, o.id, 'DELIVERED')
      const snapshot = async () => ({
        inv: await inventory(db, p.variantIds[0]),
        movements: await value<number>(db, `select count(*)::int from public.inventory_movements m join public.order_items i on i.variant_id = m.variant_id where i.order_id = $1`, [o.id]),
        money: await value<number>(db, `select count(*)::int from public.finance_transactions where order_id = $1`, [o.id]),
        history: await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1`, [o.id]),
      })
      const before = await snapshot()
      expect(before.inv.on_hand).toBe(8)
      expect(before.inv.reserved).toBe(0)
      expect(before.money).toBeGreaterThan(0)
      // The same status again (a courier callback delivered twice) is accepted and changes nothing.
      expect(await value(db, `select status from public._transition_order($1, 'DELIVERED', 'again')`, [o.id])).toBe('DELIVERED')
      expect(await snapshot()).toEqual(before)
      // Going backwards is refused and changes nothing either.
      await expectError(db, `select public._transition_order($1, 'SHIPPED', 'again')`, [o.id], /INVALID_TRANSITION/)
      await expectError(db, `select public._transition_order($1, 'READY_TO_SHIP', 'again')`, [o.id], /INVALID_TRANSITION/)
      expect(await snapshot()).toEqual(before)
    }))
})

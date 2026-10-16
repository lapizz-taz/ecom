import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, MERCHANT_1, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createPlatformStaff, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type Overview = { enabled: boolean; stats: { total: number; stores: number; warehouses: number; central: string }; branches: Array<{ id: string; name: string; is_central: boolean; units: number }> }
const overview = (db: Db) => value<Overview>(db, `select public.branches_overview()`)
const stockOf = async (db: Db, variant: string) => {
  const r = await value<{ items: Array<{ variant_id: string; total: number; branches: Record<string, number> }> }>(db, `select public.branch_stock_list(null, 200, 0)`)
  return r.items.find((i) => i.variant_id === variant)!
}

describe('branch stock', () => {
  it('starts with a central branch holding everything, then splits stock by setup and transfers without changing the total', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const v = p.variantIds[0]
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const first = await value<Overview>(db, `select public.branches_enable(true)`)
      expect(first.enabled).toBe(true)
      expect(first.stats).toMatchObject({ total: 1, warehouses: 1, central: 'Main warehouse' })
      const central = first.branches[0].id

      const dhanmondi = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Dhanmondi store', code: 'dmd', kind: 'STORE' })])
      const uttara = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Uttara store', kind: 'STORE' })])
      expect((await overview(db)).stats).toMatchObject({ total: 3, stores: 2, warehouses: 1 })

      // Branch Stock Setup: 8 at Dhanmondi comes out of the central branch.
      await value(db, `select public.branch_stock_set($1, $2)`, [dhanmondi.id, JSON.stringify([{ variant_id: v, on_hand: 8 }])])
      let s = await stockOf(db, v)
      expect(s.total).toBe(20)
      expect(s.branches[central]).toBe(12)
      expect(s.branches[dhanmondi.id]).toBe(8)

      // Transfers check what the source branch has.
      await expectError(db, `select public.branch_transfer($1, $2, $3)`, [dhanmondi.id, uttara.id, JSON.stringify([{ variant_id: v, quantity: 9 }])], /only 8 in stock/)
      await value(db, `select public.branch_transfer($1, $2, $3, 'Weekend stock')`, [dhanmondi.id, uttara.id, JSON.stringify([{ variant_id: v, quantity: 3 }])])
      s = await stockOf(db, v)
      expect([s.total, s.branches[central], s.branches[dhanmondi.id], s.branches[uttara.id]]).toEqual([20, 12, 5, 3])
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.branch_transfers where note = 'Weekend stock'`)).toBe(1)
    }))

  it('takes a shipped order\'s stock from the branch that ships it, and other movements from the chosen branch', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      const v = p.variantIds[0]
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await value(db, `select public.branches_enable(true)`)
      const store = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Mirpur store' })])
      await value(db, `select public.branch_stock_set($1, $2)`, [store.id, JSON.stringify([{ variant_id: v, on_hand: 4 }])])

      const order = await createOrder(db, { phone: '01733000001', items: [{ variantId: v, quantity: 2 }] })
      await asUser(db, admin)
      expect(await value(db, `select public.orders_set_branch(array[$1]::uuid[], $2)`, [order.id, store.id])).toBe(1)
      await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED'])
      await asUser(db, admin)
      let s = await stockOf(db, v)
      expect(s.total).toBe(8)
      expect(s.branches[store.id]).toBe(2)
      await asSystem(db)
      expect(await value(db, `select branch_id from public.inventory_movements where reference_id = $1 and on_hand_change < 0 limit 1`, [order.id])).toBe(store.id)

      // A shipped order keeps its branch.
      await asUser(db, admin)
      expect(await value(db, `select public.orders_set_branch(array[$1]::uuid[], null)`, [order.id])).toBe(0)

      // An adjustment made for a branch lands there.
      await asSystem(db)
      await db.query(`select set_config('app.inventory_branch', $1, true)`, [store.id])
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', 3, 0, 0, 'ADJUSTMENT', null, 'Count', 'found 3')`, [v])
      await db.query(`select set_config('app.inventory_branch', '', true)`)
      await asUser(db, admin)
      s = await stockOf(db, v)
      expect(s.total).toBe(11)
      expect(s.branches[store.id]).toBe(5)
    }))

  it('deletes only an empty branch, never the central one; staff without the permissions are refused', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const o = await value<Overview>(db, `select public.branches_enable(true)`)
      const central = o.branches[0].id
      const empty = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Pop-up stall' })])
      const used = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Gulshan store' })])
      await value(db, `select public.branch_stock_set($1, $2)`, [used.id, JSON.stringify([{ variant_id: p.variantIds[0], on_hand: 1 }])])
      await expectError(db, `select public.branch_delete($1)`, [central], /another central branch/)
      await expectError(db, `select public.branch_delete($1)`, [used.id], /close it instead/)
      await expectError(db, `select public.branch_save($1)`, [JSON.stringify({ id: used.id, name: 'Gulshan store', is_active: false })], /move this branch/)
      await db.query(`select public.branch_delete($1)`, [empty.id])

      const staff = await createStaff(db, 'CALL')
      await value(db, `select public.branch_staff_set($1, array[$2]::uuid[])`, [used.id, staff])
      await asUser(db, staff)
      await expectError(db, `select public.branch_save($1)`, [JSON.stringify({ name: 'Mine' })], /settings\.manage|PERMISSION/)
      await expectError(db, `select public.branch_transfer($1, $2, '[]')`, [used.id, central], /inventory\.adjust|PERMISSION/)
    }))

  it('reports orders and stock per branch, unassigned orders counting for the central branch', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 10 })
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      const o = await value<Overview>(db, `select public.branches_enable(true)`)
      const store = await value<{ id: string }>(db, `select to_jsonb(public.branch_save($1))`, [JSON.stringify({ name: 'Banani store' })])
      const a = await createOrder(db, { phone: '01733000011', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01733000012', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, admin)
      await value(db, `select public.orders_set_branch(array[$1]::uuid[], $2)`, [b.id, store.id])
      await advanceOrder(db, a.id, ['CONFIRMED'])
      await advanceOrder(db, b.id, ['CONFIRMED'])
      await asUser(db, admin)
      const r = await value<Array<{ branch_id: string; orders: number }>>(db, `select public.branch_report(current_date - 1, current_date)`)
      expect(r.find((x) => x.branch_id === o.branches[0].id)?.orders).toBe(1)
      expect(r.find((x) => x.branch_id === store.id)?.orders).toBe(1)

      // Super Admin sees the store's branches, read-only.
      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      await asUser(db, superId, 'staff@platform.example', null)
      const seen = await value<{ enabled: boolean; branches: Array<{ name: string; is_central: boolean }> }>(db, `select public.platform_merchant_branches($1)`, [MERCHANT_1])
      expect(seen.enabled).toBe(true)
      expect(seen.branches.map((x) => [x.name, x.is_central])).toEqual([['Main warehouse', true], ['Banani store', false]])
      await asUser(db, admin)
      await expectError(db, `select public.platform_merchant_branches($1)`, [MERCHANT_1], /PERMISSION|platform/i)
    }))
})

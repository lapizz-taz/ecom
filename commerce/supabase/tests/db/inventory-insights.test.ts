import { afterAll, describe, expect, it } from 'vitest'
import { asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
const insight = async (db: Db, variantId: string, args: number[] = [7, 30, 60]) => {
  const r = await value<{ items: Array<Record<string, any>> }>(db, `select public.inventory_insights($1, $2, $3)`, args)
  return r.items.find((i) => i.variant_id === variantId)!
}

describe('Inventory insights', () => {
  it('turns recent sales into a daily rate, days of stock left and a suggested reorder; ABC by revenue', () =>
    inTx(async (db) => {
      const fast = await createProduct(db, { price: 1000, cost: 400, stock: 12 })
      const slow = await createProduct(db, { price: 100, cost: 40, stock: 50 })
      for (let i = 0; i < 6; i++) {
        const o = await createOrder(db, { phone: phone(), items: [{ variantId: fast.variantIds[0], quantity: 1 }] })
        await advanceOrder(db, o.id, ['CONFIRMED'])
      }
      const s = await createOrder(db, { phone: phone(), items: [{ variantId: slow.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, s.id, ['CONFIRMED'])

      await asUser(db, await createStaff(db, 'OWNER'))
      const f = await insight(db, fast.variantIds[0])
      // 6 sold in 7, 30 and 90 days: 0.4*6/7 + 0.4*6/30 + 0.2*6/90
      expect(Number(f.daily)).toBeCloseTo(0.4 * 6 / 7 + 0.4 * 6 / 30 + 0.2 * 6 / 90, 2)
      expect(f).toMatchObject({ sold_7: 6, sold_30: 6, sold_90: 6, available: 6, incoming: 0 })
      expect(Number(f.cover_days)).toBeCloseTo(6 / Number(f.daily), 0)
      expect(f.status).toBe('LOW') // about 14 days of cover: under lead time + a week, over the lead time
      expect(f.suggest).toBe(Math.max(Math.ceil(Number(f.daily) * 37) - 6, 0))
      expect(f.abc).toBe('A')
      expect((await insight(db, slow.variantIds[0])).abc).not.toBe('A')

      // A longer lead time asks for more.
      expect((await insight(db, fast.variantIds[0], [21, 30, 60])).suggest).toBeGreaterThan(f.suggest)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      const can = await value<boolean>(db, `select public.has_permission('inventory.view')`).catch(() => false)
      if (!can) await expectError(db, `select public.inventory_insights()`, [], /permission|required|denied/i)
    }))
})

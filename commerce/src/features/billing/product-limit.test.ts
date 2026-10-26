import { describe, expect, it } from 'vitest'
import { productLimitState, productLimitText } from './product-limit'

const plan = (products: number, limit?: number) => ({
  limits: limit == null ? {} : { products: limit },
  usage: { stores: 1, staff: 1, products, orders_per_month: 0 },
  subscription: { plan: { name: 'Starter', code: 'STARTER', description: null } } as never,
})

describe('product limit notice', () => {
  it('stays hidden under the limit and on plans without one', () => {
    expect(productLimitState(plan(99, 100))).toBeNull()
    expect(productLimitState(plan(5000))).toBeNull()
  })

  it('says when the limit is reached, and that synced products keep coming in', () => {
    const s = productLimitState(plan(100, 100))!
    expect(s).toEqual({ used: 100, limit: 100, plan: 'Starter', over: false })
    expect(productLimitText(s)).toContain("You've reached the 100 products your Starter plan includes")
    expect(productLimitText(s)).toContain('keep syncing')
  })

  it('says by how much a store is over (products synced from Shopify or WooCommerce)', () => {
    const s = productLimitState(plan(520, 100))!
    expect(s.over).toBe(true)
    expect(productLimitText(s)).toContain('This store has 520 products; your Starter plan includes 100.')
  })
})

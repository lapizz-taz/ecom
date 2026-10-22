import { describe, expect, it } from 'vitest'
import { cartBlocker } from './use-cart-quote'

describe('cartBlocker', () => {
  it('turns the server refusing the cart into a message', () => {
    expect(cartBlocker({ code: '22023', message: 'VALIDATION: you can order at most 20 of Linen Shirt' })).toBe('You can order at most 20 of Linen Shirt')
    expect(cartBlocker({ message: 'VALIDATION: a product in the cart no longer exists' })).toBe('A product in the cart no longer exists')
  })

  it('does not block checkout for network trouble or no error', () => {
    expect(cartBlocker(new TypeError('Failed to fetch'))).toBeNull()
    expect(cartBlocker({ code: '500', message: 'Internal error' })).toBeNull()
    expect(cartBlocker(null)).toBeNull()
  })
})

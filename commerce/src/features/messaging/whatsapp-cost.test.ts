import { describe, expect, it } from 'vitest'
import { estimateCost, pricePerMessage, taka, whatsappCategory } from './whatsapp-cost'

describe('WhatsApp costs', () => {
  it('cart reminders and review requests are Marketing, order updates Utility', () => {
    expect(whatsappCategory('CART_REMINDER')).toBe('MARKETING')
    expect(whatsappCategory('REVIEW_REQUEST')).toBe('MARKETING')
    for (const e of ['ORDER_CREATED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'PAYMENT_RECEIVED', 'TEST']) expect(whatsappCategory(e)).toBe('UTILITY')
  })

  it('shows taka per message and the month in whole taka', () => {
    expect(pricePerMessage('UTILITY')).toBe('৳0.52')
    expect(pricePerMessage('MARKETING')).toBe('৳10')
    expect(taka(estimateCost({ UTILITY: 1000, MARKETING: 10 }))).toBe('৳627')
  })
})

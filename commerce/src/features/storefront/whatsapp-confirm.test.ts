import { describe, expect, it } from 'vitest'
import { orderConfirmationMessage, waNumber } from './whatsapp-confirm'

describe('WhatsApp confirmation', () => {
  it('turns local numbers into wa.me format', () => {
    expect(waNumber('01712-345678')).toBe('8801712345678')
    expect(waNumber('+880 1712 345678')).toBe('8801712345678')
    expect(waNumber('008801712345678')).toBe('8801712345678')
    expect(waNumber('')).toBeNull()
    expect(waNumber('123')).toBeNull()
  })

  it('writes the order details into the message', () => {
    const text = orderConfirmationMessage('Isolation', {
      order_number: 'ISO-10060', customer_name: 'Rahim', total_amount: 530, amount_due_now: 55, cod_amount: 475,
      shipping_area: 'Dhanmondi', shipping_district: 'Dhaka',
    } as never, '01711000001')
    expect(text).toContain('Order: ISO-10060')
    expect(text).toContain('Phone: 01711000001')
    expect(text).toContain('Pay now: ৳55')
    expect(text).toContain('Due on delivery: ৳475')
    expect(text).toContain('Delivery to: Dhanmondi, Dhaka')
  })
})

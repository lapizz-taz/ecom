import { describe, expect, it } from 'vitest'
import { EMAIL_DEFAULTS, MESSAGE_EVENTS, SAMPLE_DATA, WHATSAPP_DEFAULTS, WHATSAPP_VARIABLES } from './defaults.ts'
import { htmlToText, liquidError, renderLiquid } from './liquid.ts'
import { exampleValues, fillWhatsapp, paramValue, templateName, toPositional, whatsappProblems } from './whatsapp-template.ts'

describe('default emails', () => {
  it('every event has an email that renders with the sample order', () => {
    for (const e of MESSAGE_EVENTS) {
      const d = EMAIL_DEFAULTS[e]
      expect(liquidError(d.template), e).toBeNull()
      expect(liquidError(d.subject), e).toBeNull()
      const html = renderLiquid(d.template, SAMPLE_DATA)
      expect(html, e).toMatch(/^<!doctype html>/)
      expect(html, e).toContain('ORD-1042')
      expect(html, e).not.toMatch(/\{\{|\{%/)
      expect(renderLiquid(d.subject, SAMPLE_DATA, { mode: 'text' }), e).toContain('ORD-1042')
    }
  })

  it('the order confirmation lists the items, totals, address and the button in the store colour', () => {
    const html = renderLiquid(EMAIL_DEFAULTS.ORDER_CREATED.template, { ...SAMPLE_DATA, shop: { ...(SAMPLE_DATA.shop as object), accent_color: '#2142e7' } })
    for (const s of ['Cotton panjabi', 'L / White', '৳950', '৳1,310', 'To pay on delivery', '৳1,255', 'Mirpur', 'background:#2142e7']) expect(html).toContain(s)
    const text = htmlToText(html)
    expect(text).toContain('Thank you for your order!')
    expect(text).toContain('View your order (https://yourstore.com/track-order?order=ORD-1042)')
  })

  it('leaves out what an order does not have', () => {
    const data = { ...SAMPLE_DATA, shipment: { courier: null, tracking_number: null, tracking_url: null }, order: { ...(SAMPLE_DATA.order as object), cod_amount: 0, status_url: null } }
    const html = renderLiquid(EMAIL_DEFAULTS.ORDER_SHIPPED.template, data)
    expect(html).toContain('handed to the courier')
    expect(html).not.toContain('Tracking number')
    expect(html).not.toContain('Track your parcel')
    expect(html).not.toContain('ready to pay')
  })
})

describe('WhatsApp templates', () => {
  it('every default follows Meta\'s rules', () => {
    for (const e of MESSAGE_EVENTS) expect(whatsappProblems(WHATSAPP_DEFAULTS[e]), e).toEqual([])
  })

  it('catches what Meta rejects', () => {
    expect(whatsappProblems('{{customer_first_name}}, your order is ready')).toContain('Start the message with words, not a placeholder (Meta rule).')
    expect(whatsappProblems('Your order is ready - {{store_name}}')).toContain('End the message with words, not a placeholder (Meta rule).')
    expect(whatsappProblems('Hi {{customer_first_name}} {{order_number}} is ready for you today')).toContain('Put words between two placeholders (Meta rule).')
    expect(whatsappProblems('Hi {{nope}}, thanks a lot for shopping')).toEqual(['Unknown placeholder: {{nope}}.'])
    expect(whatsappProblems('Hi {{customer_name, thanks for shopping with us')).toContain('A placeholder is not written as {{name}}.')
    expect(whatsappProblems('Pay {{total}} for {{order_number}} by {{store_phone}} now')).toContain('Too many placeholders for a message this short: add more words (Meta rule).')
    expect(whatsappProblems('x'.repeat(1025))[0]).toMatch(/up to 1024/)
  })

  it('numbers the placeholders for Meta and fills values', () => {
    const { text, params } = toPositional('Hi {{customer_first_name}}, order {{order_number}} for {{customer_first_name}} is ready.')
    expect(text).toBe('Hi {{1}}, order {{2}} for {{3}} is ready.')
    expect(params).toEqual(['customer_first_name', 'order_number', 'customer_first_name'])
    expect(exampleValues(params)).toEqual(['Rahim', 'ISO-1042', 'Rahim'])
    expect(templateName('ORDER_SHIPPED', 2)).toBe('ff_order_shipped_v2')
    expect(paramValue('a\nb\t c     d')).toBe('a b  c   d')
    expect(paramValue('')).toBe('-')
    expect(fillWhatsapp('Hi {{customer_first_name}}!', { customer_first_name: 'Rahim' })).toBe('Hi Rahim!')
    expect(WHATSAPP_VARIABLES.every((v) => v.example.length > 0)).toBe(true)
  })
})

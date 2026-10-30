import { describe, expect, it } from 'vitest'
import {
  EMAIL_DEFAULTS, EMAIL_DEFAULTS_BN, LANGUAGES, MESSAGE_EVENTS, messageDefaults, REPLY_TEXTS, SAMPLE_DATA, SAMPLE_SUMMARY, SMS_DEFAULTS, SUMMARY_EMAIL,
  WHATSAPP_BUTTONS, WHATSAPP_CONFIRM_TEXT, WHATSAPP_DEFAULTS, WHATSAPP_DEFAULTS_BN, WHATSAPP_VARIABLES,
} from './defaults.ts'
import { htmlToText, liquidError, renderLiquid } from './liquid.ts'
import { exampleValues, fillWhatsapp, paramValue, templateName, toPositional, whatsappProblems } from './whatsapp-template.ts'

const noReply = { ...SAMPLE_DATA, order: { ...(SAMPLE_DATA.order as object), reply_url: null } }

describe('default emails', () => {
  it('every event has an email in English and Bangla that renders with the sample order', () => {
    for (const lang of LANGUAGES) {
      for (const e of MESSAGE_EVENTS) {
        const d = messageDefaults(lang).email[e]
        expect(liquidError(d.template), e).toBeNull()
        expect(liquidError(d.subject), e).toBeNull()
        const html = renderLiquid(d.template, SAMPLE_DATA)
        expect(html, e).toMatch(/^<!doctype html>/)
        expect(html, e).toContain(`<html lang="${lang}">`)
        expect(html, e).not.toMatch(/\{\{|\{%/)
        if (e === 'CART_REMINDER') continue
        expect(html, e).toContain('ORD-1042')
        expect(renderLiquid(d.subject, SAMPLE_DATA, { mode: 'text' }), e).toContain('ORD-1042')
      }
    }
  })

  it('the order confirmation lists the items, totals, address and the button in the store colour', () => {
    const html = renderLiquid(EMAIL_DEFAULTS.ORDER_CREATED.template, { ...noReply, shop: { ...(SAMPLE_DATA.shop as object), accent_color: '#2142e7' } })
    for (const s of ['Cotton panjabi', 'L / White', '৳950', '৳1,310', 'To pay on delivery', '৳1,255', 'Mirpur', 'background:#2142e7']) expect(html).toContain(s)
    const text = htmlToText(html)
    expect(text).toContain('Thank you for your order!')
    expect(text).toContain('We will call you shortly to confirm it')
    expect(text).toContain('View your order (https://yourstore.com/track-order?order=ORD-1042)')
  })

  it('asks the customer to confirm when the order has a confirm page', () => {
    const text = htmlToText(renderLiquid(EMAIL_DEFAULTS.ORDER_CREATED.template, SAMPLE_DATA))
    expect(text).toContain('Please confirm it below')
    expect(text).toContain('Confirm your order (https://fullfilio.com/order-confirm/sample)')
    expect(text).toContain('Cancel it here (https://fullfilio.com/order-confirm/sample?action=cancel)')
    expect(text).not.toContain('View your order')
    const bn = htmlToText(renderLiquid(EMAIL_DEFAULTS_BN.ORDER_CREATED.template, SAMPLE_DATA))
    expect(bn).toContain('অর্ডার কনফার্ম করুন (https://fullfilio.com/order-confirm/sample)')
    expect(bn).toContain('প্রিয় Rahim')
  })

  it('the cart reminder shows the cart and links back to it', () => {
    const data = { ...SAMPLE_DATA, order: {} }
    const text = htmlToText(renderLiquid(EMAIL_DEFAULTS.CART_REMINDER.template, data))
    for (const s of ['Your cart is waiting', 'Cotton panjabi', 'Leather belt', '৳1,250', 'Finish your order (https://yourstore.com/cart?restore=sample)']) expect(text).toContain(s)
    expect(text).not.toMatch(/Order\s+ORD/)
  })

  it('the review request links to the store\'s review page, and has no button without one', () => {
    expect(htmlToText(renderLiquid(EMAIL_DEFAULTS.REVIEW_REQUEST.template, SAMPLE_DATA))).toContain('Write a review (https://www.facebook.com/yourstore/reviews)')
    const none = { ...SAMPLE_DATA, shop: { ...(SAMPLE_DATA.shop as object), review_url: null } }
    expect(renderLiquid(EMAIL_DEFAULTS.REVIEW_REQUEST.template, none)).not.toContain('Write a review')
  })

  it('the owner\'s daily summary renders in both languages', () => {
    for (const lang of LANGUAGES) {
      const html = renderLiquid(SUMMARY_EMAIL[lang].template, SAMPLE_SUMMARY)
      expect(html).not.toMatch(/\{\{|\{%/)
      for (const s of ['22 Oct 2026', '64', '৳81,250', '৳11,230', '৳6,400', 'https://fullfilio.com/admin']) expect(html, lang).toContain(s)
      expect(renderLiquid(SUMMARY_EMAIL[lang].subject, SAMPLE_SUMMARY, { mode: 'text' })).toContain('Your Store')
    }
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
  it('every default, English and Bangla, follows Meta\'s rules', () => {
    for (const e of MESSAGE_EVENTS) expect(whatsappProblems(WHATSAPP_DEFAULTS[e]), e).toEqual([])
    for (const e of MESSAGE_EVENTS) expect(whatsappProblems(WHATSAPP_DEFAULTS_BN[e]), e).toEqual([])
    for (const l of LANGUAGES) {
      expect(whatsappProblems(WHATSAPP_CONFIRM_TEXT[l]), l).toEqual([])
      // It names the buttons the customer sees.
      expect(WHATSAPP_CONFIRM_TEXT[l]).toContain(WHATSAPP_BUTTONS[l].confirm)
    }
  })

  it('the quick-reply buttons fit Meta\'s 25 characters, and every answer names the order', () => {
    for (const b of Object.values(WHATSAPP_BUTTONS)) for (const t of [b.confirm, b.cancel]) expect(t.length).toBeLessThanOrEqual(25)
    for (const texts of Object.values(REPLY_TEXTS)) for (const t of Object.values(texts)) expect(t).toContain('{{order_number}}')
  })

  it('SMS defaults exist for every event and use only known placeholders', () => {
    const known = new Set(WHATSAPP_VARIABLES.map((v) => v.name))
    for (const lang of LANGUAGES) {
      for (const e of MESSAGE_EVENTS) {
        const t = messageDefaults(lang).sms[e]
        expect(t, e).toBeTruthy()
        for (const m of t.matchAll(/\{\{([a-z_]+)\}\}/g)) expect(known.has(m[1]), `${lang} ${e} ${m[1]}`).toBe(true)
      }
    }
    expect(SMS_DEFAULTS.ORDER_CREATED).toBe('Hi {{customer_name}}, thanks for your order {{order_number}} ({{total}}). We will confirm it shortly. - {{store_name}}')
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
    expect(exampleValues(params)).toEqual(['Rahim', '1042', 'Rahim'])
    expect(templateName('ORDER_SHIPPED', 2)).toBe('ff_order_shipped_v2')
    expect(paramValue('a\nb\t c     d')).toBe('a b  c   d')
    expect(paramValue('')).toBe('-')
    expect(fillWhatsapp('Hi {{customer_first_name}}!', { customer_first_name: 'Rahim' })).toBe('Hi Rahim!')
    expect(WHATSAPP_VARIABLES.every((v) => v.example.length > 0)).toBe(true)
  })
})

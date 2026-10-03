import { describe, expect, it } from 'vitest'
import { conditionProblem, describeCondition, renderTemplate, smsParts } from './sms-text'

describe('smsParts', () => {
  // Same cases as the database test, so the page and the cost estimate agree.
  it('counts GSM text in 160 / 153 character parts', () => {
    expect(smsParts('a'.repeat(160))).toMatchObject({ encoding: 'GSM', units: 160, segments: 1, remaining: 0 })
    expect(smsParts('a'.repeat(161))).toMatchObject({ encoding: 'GSM', units: 161, segments: 2, remaining: 145 })
    expect(smsParts(`${'a'.repeat(159)}€`)).toMatchObject({ encoding: 'GSM', units: 161, segments: 2 })
    expect(smsParts('')).toMatchObject({ segments: 0 })
  })

  it('switches to Unicode for Bangla, the taka sign and emoji', () => {
    expect(smsParts('আপনার অর্ডার')).toMatchObject({ encoding: 'UNICODE', segments: 1 })
    expect(smsParts('ক'.repeat(71))).toMatchObject({ encoding: 'UNICODE', units: 71, segments: 2 })
    expect(smsParts('Total ৳1,250').encoding).toBe('UNICODE')
    expect(smsParts('Hi 😀')).toMatchObject({ encoding: 'UNICODE', units: 5 })
  })
})

describe('templates and conditions', () => {
  it('fills known variables and drops unknown ones', () => {
    expect(renderTemplate('Hi {{customer_name}}, order {{order_number}}{{nope}}.', { customer_name: 'Rahim', order_number: 'ISO-1' }))
      .toBe('Hi Rahim, order ISO-1.')
  })

  it('describes conditions in plain words', () => {
    expect(describeCondition({ field: 'payment_method', op: 'in', value: ['COD'] })).toBe('Payment is Cash on delivery')
    expect(describeCondition({ field: 'total', op: 'gte', value: 5000 }, { currency: 'Tk' })).toBe('Order total at least Tk 5,000')
    expect(describeCondition({ field: 'district', op: 'not_in', value: ['Dhaka', 'Gazipur'] })).toBe('District is not Dhaka, Gazipur')
    expect(describeCondition({ field: 'first_order', op: 'eq', value: false })).toBe('Repeat customer')
    expect(describeCondition({ field: 'courier', op: 'in', value: ['c1'] }, { couriers: [{ id: 'c1', name: 'Pathao' }] })).toBe('Courier is Pathao')
  })

  it('flags empty choices before saving', () => {
    expect(conditionProblem([{ field: 'district', op: 'in', value: [' '] }])).toMatch(/District/)
    expect(conditionProblem([{ field: 'total', op: 'gte', value: -1 }])).toMatch(/0 or more/)
    expect(conditionProblem([{ field: 'payment_method', op: 'in', value: ['COD'] }])).toBeNull()
  })
})

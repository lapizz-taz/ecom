import { describe, expect, it } from 'vitest'
import { isValidPhone, normalizePhone } from './phone'

const BD = '^01[3-9][0-9]{8}$'

describe('phone normalisation', () => {
  it('converts international formats to the local trunk form', () => {
    expect(normalizePhone('+880 1711-000222')).toBe('01711000222')
    expect(normalizePhone('008801711000222')).toBe('01711000222')
    expect(normalizePhone('8801711000222')).toBe('01711000222')
    expect(normalizePhone('01711 000 222')).toBe('01711000222')
  })

  it('validates with the configured pattern', () => {
    expect(isValidPhone('+8801711000222', BD)).toBe(true)
    expect(isValidPhone('01211000222', BD)).toBe(false)
    expect(isValidPhone('12345', BD)).toBe(false)
  })
})

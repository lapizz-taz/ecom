import { describe, expect, it } from 'vitest'
import { bdMobile, bdMobileIntl, normalizePhone, pickPhone } from './phone.ts'

// The database's own copy of these rules is checked against this file in supabase/tests/db/phone-forms.test.ts.
describe('shared phone rules', () => {
  it('repairs the forms people type', () => {
    expect(normalizePhone('1712278464')).toBe('01712278464')
    expect(normalizePhone('+880 01712278464')).toBe('01712278464')
    expect(normalizePhone('+88 01712278464')).toBe('01712278464')
    expect(normalizePhone('০১৭১২২৭৮৪৬৪')).toBe('01712278464')
    expect(normalizePhone('01712-278464 / 01812-000000')).toBe('01712278464')
  })

  it('leaves other countries and bad numbers as digits', () => {
    expect(normalizePhone('+44 7911 123456', '44')).toBe('07911123456')
    expect(normalizePhone('+1 (347) 123-4567')).toBe('13471234567')
    expect(normalizePhone('12345')).toBe('12345')
    expect(normalizePhone('')).toBe('')
    expect(normalizePhone(null)).toBe('')
  })

  it('gives Bangladeshi mobile numbers in both forms the gateways use', () => {
    expect(bdMobile('+8801712278464')).toBe('01712278464')
    expect(bdMobile('1712278')).toBeNull()
    expect(bdMobileIntl('1712278464')).toBe('8801712278464')
    expect(bdMobileIntl('+1 (347) 123-4567')).toBe('')
  })

  it('picks the first field that holds a mobile number', () => {
    expect(pickPhone('-', null, '+880 1712-278464')).toBe('+880 1712-278464')
    expect(pickPhone('', '1712278464', '01812000000')).toBe('1712278464')
    expect(pickPhone('12345', null)).toBe('12345')
    expect(pickPhone(null, undefined, ' ')).toBeNull()
  })
})

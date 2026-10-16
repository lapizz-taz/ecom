import { describe, expect, it } from 'vitest'
import { customWindow, MAX_CUSTOM_DAYS } from '../meta-ads/handler.ts'

describe('Meta Ads custom sync range', () => {
  const today = '2026-10-17'
  it('takes a range of up to 31 days ending today at the latest', () => {
    expect(customWindow('2026-10-17', '2026-10-17', today)).toEqual({ since: '2026-10-17', until: '2026-10-17' })
    expect(customWindow('2026-09-17', '2026-10-17', today)).toEqual({ since: '2026-09-17', until: '2026-10-17' })
    expect(MAX_CUSTOM_DAYS).toBe(31)
  })
  it('refuses more than 31 days, a reversed range and future dates', () => {
    expect(() => customWindow('2026-09-16', '2026-10-17', today)).toThrow(/31 days/)
    expect(() => customWindow('2026-10-10', '2026-10-01', today)).toThrow(/start date/)
    expect(() => customWindow('2026-10-17', '2026-10-18', today)).toThrow(/after today/)
  })
})

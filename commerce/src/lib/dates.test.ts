import { describe, expect, it } from 'vitest'
import { granularityFor, previousPeriod, rangeFor } from './dates'
import { formatDate } from './format'

describe('date ranges', () => {
  const now = new Date(2026, 9, 15) // 15 Oct 2026, local time

  it('builds preset ranges from local calendar dates', () => {
    expect(rangeFor('today', now)).toEqual({ from: '2026-10-15', to: '2026-10-15' })
    expect(rangeFor('7d', now)).toEqual({ from: '2026-10-09', to: '2026-10-15' })
    expect(rangeFor('month', now)).toEqual({ from: '2026-10-01', to: '2026-10-15' })
    expect(rangeFor('last_month', now)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(rangeFor('year', now)).toEqual({ from: '2026-01-01', to: '2026-10-15' })
  })

  it('picks a chart granularity from the range length', () => {
    expect(granularityFor({ from: '2026-10-01', to: '2026-10-31' })).toBe('day')
    expect(granularityFor({ from: '2026-01-01', to: '2026-04-30' })).toBe('week')
    expect(granularityFor({ from: '2025-01-01', to: '2026-10-15' })).toBe('month')
  })

  it('computes the previous period of equal length', () => {
    expect(previousPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-08-31', to: '2026-09-30' })
    expect(previousPeriod({ from: '2026-10-15', to: '2026-10-15' })).toEqual({ from: '2026-10-14', to: '2026-10-14' })
    // Crosses a year boundary
    expect(previousPeriod({ from: '2026-01-01', to: '2026-01-07' })).toEqual({ from: '2025-12-25', to: '2025-12-31' })
  })

  it('formats date-only strings as calendar dates regardless of time zone', () => {
    expect(formatDate('2026-10-01')).toBe('1 Oct 2026')
  })
})

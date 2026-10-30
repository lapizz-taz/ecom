import { describe, expect, it } from 'vitest'
import { APPROVED_PLACES, placeName, placeOf, placeTarget, stageOf, WEB_PLACES } from './status'

describe('order stages', () => {
  it('keeps unapproved orders in Web Orders and maps approved ones to their stage', () => {
    expect(stageOf('CONFIRMATION_REQUIRED', null)).toBe('WEB')
    expect(stageOf('CANCELLED', null)).toBe('WEB')
    expect(stageOf('PACKING', '2026-10-01')).toBe('PENDING')
    expect(stageOf('FAILED_DELIVERY', '2026-10-01')).toBe('RETURN_PENDING')
    expect(stageOf('RETURNING', '2026-10-01')).toBe('RETURN_PENDING')
    expect(stageOf('PARTIALLY_DELIVERED', '2026-10-01')).toBe('PARTIAL')
    expect(stageOf('CANCELLED', '2026-10-01')).toBe('CANCELLED')
  })
})

describe('Super Edit places', () => {
  it('shows each order in the place its list shows it, by the tab names', () => {
    expect(placeOf('PENDING', null)).toBe('CONFIRMATION_REQUIRED')
    expect(placeOf('FRAUD_REVIEW', null)).toBe('CONFIRMATION_REQUIRED')
    expect(placeOf('ADVANCE_REQUIRED', null)).toBe('ADVANCE_REQUIRED')
    expect(placeOf('REJECTED_FRAUD', null)).toBe('CANCELLED')
    expect(placeOf('PACKING', '2026-10-01')).toBe('PROCESSING')
    expect(placeOf('FAILED_DELIVERY', '2026-10-01')).toBe('RETURNING')
    expect(placeOf('PENDING_CANCEL', '2026-10-01')).toBe('PENDING_CANCEL')
    expect(placeOf('CANCELLED', '2026-10-01')).toBe('CANCELLED')
    for (const p of WEB_PLACES) expect(placeOf(p.to, null)).toBe(p.to)
    for (const p of APPROVED_PLACES) expect(placeOf(p.to, '2026-10-01')).toBe(p.to)
    expect([placeName('CONFIRMATION_REQUIRED'), placeName('READY_TO_SHIP'), placeName('CANCELLED')]).toEqual(['Web order', 'Approved · RTS', 'Cancelled'])
  })

  it('back to Pending from RTS goes through packing; every other place is its own status', () => {
    expect(placeTarget('PROCESSING', 'READY_TO_SHIP')).toBe('PACKING')
    expect(placeTarget('PROCESSING', 'PRE_ORDER')).toBe('PROCESSING')
    expect(placeTarget('SHIPPED', 'READY_TO_SHIP')).toBe('SHIPPED')
  })
})

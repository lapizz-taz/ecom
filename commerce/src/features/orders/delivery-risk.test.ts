import { describe, expect, it } from 'vitest'
import type { OrderCustomerRecord } from '@/services/orders'
import { deliveryRisk } from './delivery-risk'

type Check = NonNullable<OrderCustomerRecord['check']>
const check = (over: Partial<Check>): Check => ({
  id: 'c1', checked_at: '2026-10-13T10:00:00Z', provider: 'courier_history', rate: null, tier: null,
  total: 0, delivered: 0, cancelled: 0, couriers: [], verdict: null, status: 'SUCCESS', ...over,
})
const policy = { good_min: 80, mid_min: 50, min_parcels: 3 }

describe('delivery risk label', () => {
  it('Low / Medium / High follow the store\'s marks and say why', () => {
    const lines = [
      { courier: 'pathao', orders: 72, delivered: 71, cancelled: 1, source: 'sign_in' as const },
      { courier: 'redx', orders: 8, delivered: 6, cancelled: 2, source: 'bd_courier' as const },
    ]
    const low = deliveryRisk({ check: check({ rate: 96.25, tier: 'GOOD', couriers: lines }), policy })
    expect(low.level).toBe('low')
    expect(low.label).toBe('Low risk')
    expect(low.reasons).toEqual([
      '77 of 80 parcels delivered (96.3%) — Pathao, RedX',
      '3 parcels cancelled or returned at the door',
      "At or above the store's Good mark of 80%",
    ])
    expect(deliveryRisk({ check: check({ rate: 60, tier: 'MID', couriers: lines }), policy }).label).toBe('Medium risk')
    const high = deliveryRisk({ check: check({ rate: 30, tier: 'LOW', couriers: lines }), policy })
    expect(high).toMatchObject({ level: 'high', label: 'High risk' })
    expect(high.reasons.at(-1)).toBe("Below the store's Medium mark of 50%")
  })

  it('too little history is Insufficient data — never a made-up percentage', () => {
    const none = deliveryRisk({ check: check({ tier: 'NEW', couriers: [{ courier: 'pathao', orders: 0, delivered: 0, cancelled: 0 }] }), policy })
    expect(none).toEqual({ level: 'insufficient', label: 'Insufficient data', reasons: ['No parcels on record with the couriers checked'] })
    const few = deliveryRisk({ check: check({ rate: 100, tier: 'NEW', couriers: [{ courier: 'redx', orders: 2, delivered: 2, cancelled: 0 }] }), policy })
    expect(few.level).toBe('insufficient')
    expect(few.reasons.at(-1)).toBe('Fewer than 3 parcels on record — not enough to judge')
  })

  it('a check that could not run is Verification unavailable, not low risk', () => {
    expect(deliveryRisk({ check: null, last_failure: { at: 'x', error: 'BD Courier: did not answer in time' }, policy }))
      .toEqual({ level: 'unavailable', label: 'Verification unavailable', reasons: ['The courier check could not run: BD Courier: did not answer in time'] })
    expect(deliveryRisk({ check: check({ status: 'ERROR', tier: 'ERROR' }), policy }).level).toBe('unavailable')
    expect(deliveryRisk({ check: null, policy }).level).toBe('unchecked')
  })

  it('shows partial checks, rate-only couriers and fraud reports as evidence', () => {
    const r = deliveryRisk({
      check: check({
        rate: 92.5, tier: 'GOOD', notes: ['BD Courier: Could not reach BD Courier'],
        couriers: [
          { courier: 'steadfast', orders: 0, delivered: 0, cancelled: 0, rate_only: true, success_ratio: 92.5, parcel_range: '100+', fraud_reports: 2 },
          { courier: 'carrybee', orders: 0, delivered: 0, cancelled: 0, notice: 'Carrybee answered HTTP 400: Business is not verified' },
        ],
      }),
      policy,
    })
    expect(r.level).toBe('low')
    expect(r.reasons).toEqual([
      'Steadfast reports only its own rate: 92.5% delivered, volume 100+ (no parcel counts)',
      'Steadfast: 2 fraud reports by other merchants',
      'Not reached: BD Courier: Could not reach BD Courier; CarryBee: Carrybee answered HTTP 400: Business is not verified',
      "At or above the store's Good mark of 80%",
    ])
  })

  it('a newer failed attempt is shown alongside the last good record', () => {
    const r = deliveryRisk({
      check: check({ rate: 99, tier: 'GOOD', couriers: [{ courier: 'pathao', orders: 10, delivered: 10, cancelled: 0 }] }),
      last_failure: { at: 'y', error: 'Courier sign-ins: took too long' }, policy,
    })
    expect(r.reasons).toContain('A newer check failed: Courier sign-ins: took too long')
  })
})

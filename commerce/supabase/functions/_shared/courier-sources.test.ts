import { describe, expect, it, vi } from 'vitest'
import type { CourierHistorySummary } from './fraud/courier-history.ts'
import { CourierSourcesProvider, mergeCourierSummaries } from './fraud/courier-sources.ts'

const bd: CourierHistorySummary = {
  service: 'bdcourier',
  couriers: [
    { courier: 'pathao', name: 'Pathao', orders: 0, delivered: 0, cancelled: 0 },
    { courier: 'steadfast', name: 'SteadFast', orders: 37, delivered: 32, cancelled: 5 },
    { courier: 'carrybee', name: 'CarryBee', orders: 2, delivered: 2, cancelled: 0 },
  ],
  total: 39, delivered: 34, cancelled: 5, success_ratio: 87.18, ratio_source: 'provider', name_on_record: 'Mahmuda', parcel_floor: 39,
  verdict: { label: 'Safe', level: 'good', action: null, reasons: [] },
}
const panel: CourierHistorySummary = {
  couriers: [
    { courier: 'pathao', name: 'Pathao', orders: 72, delivered: 71, cancelled: 1, success_ratio: null, notice: null },
    { courier: 'redx', name: 'RedX', orders: 0, delivered: 0, cancelled: 0, success_ratio: null, notice: 'RedX rejected the phone or password' },
  ],
  total: 72, delivered: 71, cancelled: 1, success_ratio: 98.61, ratio_source: 'counts', name_on_record: null, parcel_floor: 72,
}

describe('BD Courier + courier sign-ins merged per courier', () => {
  it("a courier's own panel replaces BD Courier's line for that courier; BD Courier keeps the rest", () => {
    const m = mergeCourierSummaries(bd, panel)!
    const by = Object.fromEntries(m.couriers.map((c) => [c.courier, c]))
    expect(by.pathao).toMatchObject({ orders: 72, delivered: 71, cancelled: 1, name: 'Pathao' })
    expect(by.steadfast).toMatchObject({ orders: 37, delivered: 32 })
    expect(by.carrybee).toMatchObject({ orders: 2 })
    // RedX failed on the panel and BD Courier has no RedX line: the failure shows on its own line.
    expect(by.redx.notice).toContain('RedX rejected')
    expect(m).toMatchObject({ total: 111, delivered: 105, cancelled: 6, ratio_source: 'counts', name_on_record: 'Mahmuda', parcel_floor: 111 })
    expect(m.success_ratio).toBeCloseTo(94.59, 1)
    expect(m.verdict?.label).toBe('Safe')
    expect(m.couriers[0].courier).toBe('pathao')
  })

  it('a failed panel line never replaces a BD Courier line, and nothing changes when the panel adds nothing', () => {
    const failedSteadfast: CourierHistorySummary = { ...panel, couriers: [{ courier: 'steadfast', orders: 0, delivered: 0, cancelled: 0, notice: 'Steadfast login page did not load' }] }
    const m = mergeCourierSummaries(bd, failedSteadfast)!
    expect(m.couriers.find((c) => c.courier === 'steadfast')).toEqual({ ...bd.couriers[1], source: 'bd_courier' })
    expect(m).toMatchObject({ total: 39, success_ratio: 87.18, ratio_source: 'provider' })
  })

  it('either side alone is used as it is, each line saying where it came from', () => {
    const alone = mergeCourierSummaries(bd, null)!
    expect({ ...alone, couriers: alone.couriers.map(({ source: _s, ...c }) => c) }).toEqual(bd)
    expect(alone.couriers.every((c) => c.source === 'bd_courier')).toBe(true)
    const signIns = mergeCourierSummaries(null, panel)!
    expect(signIns.total).toBe(panel.total)
    expect(signIns.couriers.every((c) => c.source === 'sign_in')).toBe(true)
    expect(mergeCourierSummaries(null, null)).toBeNull()
  })

  it('a sign-in that gives only a rate never replaces BD Courier\'s parcel counts, but keeps its fraud reports', () => {
    const steadfastRate: CourierHistorySummary = { ...panel, couriers: [{ courier: 'steadfast', orders: 0, delivered: 0, cancelled: 0, success_ratio: 91, rate_only: true, parcel_range: '100+', fraud_reports: 2 }] }
    const counted: CourierHistorySummary = { ...bd, couriers: bd.couriers.map((c) => (c.courier === 'steadfast' ? { ...c, rate_only: false, orders: 12, delivered: 11, cancelled: 1 } : c)) }
    const m = mergeCourierSummaries(counted, steadfastRate)!
    expect(m.couriers.find((c) => c.courier === 'steadfast')).toMatchObject({ orders: 12, delivered: 11, source: 'bd_courier', fraud_reports: 2 })
    expect(m.total).toBe(counted.total)
    // When BD Courier has only a rate too, the fresher sign-in rate is shown.
    const rateBd: CourierHistorySummary = {
      ...bd, total: 2, delivered: 2, cancelled: 0,
      couriers: bd.couriers.map((c) => (c.courier === 'steadfast' ? { ...c, orders: 0, delivered: 0, cancelled: 0, rate_only: true, parcel_range: '50+', success_ratio: 88 } : c)),
    }
    const m2 = mergeCourierSummaries(rateBd, steadfastRate)!
    expect(m2.couriers.find((c) => c.courier === 'steadfast')).toMatchObject({ success_ratio: 91, rate_only: true, parcel_range: '100+', source: 'sign_in' })
  })

  it('asks both at once; one side failing leaves a note, both failing fails the check', async () => {
    const ok = new CourierSourcesProvider({ name: 'h', lookup: vi.fn(async () => bd) }, { name: 'p', lookup: vi.fn(async () => { throw new Error('refused') }) })
    const r = await ok.checkCustomer({ phone: '01711111111' })
    expect(r).toMatchObject({ provider: 'courier_history', ok: true, counts: { total: 39, delivered: 34, returned: 5 }, courierScore: 87.18 })
    expect((r.raw as CourierHistorySummary).source_notes).toEqual(['Courier sign-ins: refused'])

    const down = new CourierSourcesProvider({ name: 'h', lookup: vi.fn(async () => { throw new Error('BD down') }) }, { name: 'p', lookup: vi.fn(async () => { throw new Error('refused') }) })
    expect(await down.checkCustomer({ phone: '01711111111' })).toMatchObject({ ok: false, error: 'BD Courier: BD down; Courier sign-ins: refused' })

    const panelOnly = new CourierSourcesProvider(null, { name: 'p', lookup: vi.fn(async () => panel) })
    expect(await panelOnly.checkCustomer({ phone: '01711111111' })).toMatchObject({ ok: true, counts: { total: 72, delivered: 71, returned: 1 }, courierScore: undefined })
  })
})

describe('the courier record is on unless the store turned it off', () => {
  it('adds BD Courier + courier sign-ins to a store that never chose, and keeps them out when switched off', async () => {
    const { checkProviderNames } = await import('./fraud/service.ts')
    expect(checkProviderNames({ providers: ['internal'] })).toEqual(['internal', 'courier_history'])
    expect(checkProviderNames({})).toEqual(['internal', 'courier_history'])
    expect(checkProviderNames({ providers: ['internal', 'courier_panel'] })).toEqual(['internal', 'courier_panel'])
    expect(checkProviderNames({ providers: ['internal', 'courier_history'], courier_record: false })).toEqual(['internal'])
  })

  it('a slow courier sign-in does not hold the check: BD Courier answers alone, with a note', async () => {
    const slow = { name: 'p', lookup: () => new Promise<CourierHistorySummary>(() => undefined) }
    const r = await new CourierSourcesProvider({ name: 'h', lookup: async () => bd }, slow, 30).lookup('01711111111')
    expect(r.total).toBe(39)
    expect(r.source_notes).toEqual(['Courier sign-ins: took too long'])
  })
})

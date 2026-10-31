import { describe, expect, it } from 'vitest'
import { activeFilters, boardFilters, boardParams, boardValues, EMPTY_BOARD, statusChoices, statusInfo, timeLabel } from './board-state'

describe('orders dashboard filters in the address', () => {
  it('reads values and drops malformed ones', () => {
    const v = boardValues(new URLSearchParams('by=delivered&from=2026-10-01&to=bad&tfrom=600&tto=2000&pay=maybe&status=DELIVERED,WEB:NO_RESPONSE&district=Dhaka'))
    expect(v).toMatchObject({ by: 'delivered', from: '2026-10-01', to: '', tfrom: '600', tto: '', pay: '', status: 'DELIVERED,WEB:NO_RESPONSE', district: 'Dhaka' })
    expect(boardValues(new URLSearchParams('by=tomorrow')).by).toBe('approved')
  })

  it('writes only what is set, keeps other parameters and goes back to the first page', () => {
    const base = new URLSearchParams('view=orders&size=100&page=4&product=old')
    const next = boardParams({ ...EMPTY_BOARD, courier: 'none', tags: 'VIP' }, base)
    expect(Object.fromEntries(next)).toEqual({ view: 'orders', size: '100', courier: 'none', tags: 'VIP' })
    expect(boardParams({ ...EMPTY_BOARD, by: 'order' }, new URLSearchParams()).get('by')).toBe('order')
  })

  it('turns values into the server filters', () => {
    const f = boardFilters({ ...EMPTY_BOARD, from: '2026-10-01', tfrom: '0', tto: '1439', status: 'RTS, SHIPPED', tags: '', pay: 'unpaid' })
    expect(f).toMatchObject({ date_by: 'approved', date_from: '2026-10-01', date_to: undefined, time_from: 0, time_to: 1439, statuses: ['RTS', 'SHIPPED'], tags: [], courier_payment: 'unpaid' })
  })

  it('counts set filters, a range once', () => {
    expect(activeFilters(EMPTY_BOARD)).toBe(0)
    expect(activeFilters({ ...EMPTY_BOARD, by: 'order' })).toBe(0)
    expect(activeFilters({ ...EMPTY_BOARD, from: '2026-10-01', to: '2026-10-02', tfrom: '60', product: 'tee' })).toBe(3)
  })
})

describe('times and statuses', () => {
  it('reads minutes as a clock time', () => {
    expect(timeLabel(0)).toBe('12:00 am')
    expect(timeLabel(810)).toBe('1:30 pm')
    expect(timeLabel(720)).toBe('12:00 pm')
    expect(timeLabel(1439)).toBe('11:59 pm')
  })

  it('names approved stages and web call statuses', () => {
    const calls = [{ code: 'NO_RESPONSE', label: 'No response', color: 'warning' }]
    expect(statusInfo('DELIVERED')).toMatchObject({ label: 'Delivered', group: 'approved', variant: 'success' })
    expect(statusInfo('WEB:NO_RESPONSE', calls)).toMatchObject({ label: 'No response', group: 'web', variant: 'warning' })
    expect(statusInfo('WEB:GOOD_NO_RESPONSE')).toMatchObject({ label: 'Good no response', group: 'web', variant: 'neutral' })
    const choices = statusChoices(calls)
    expect(choices[0].key).toBe('PENDING')
    expect(choices.at(-1)?.key).toBe('WEB:NO_RESPONSE')
  })
})

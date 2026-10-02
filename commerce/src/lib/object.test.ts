import { describe, expect, it } from 'vitest'
import { getIn, setIn } from './object'

describe('setIn / getIn', () => {
  it('sets nested values without mutating the original', () => {
    const original = { fraud: { thresholds: { medium: 30, high: 60 } }, list: [1, 2] }
    const next = setIn(original, ['fraud', 'thresholds', 'high'], 70)
    expect(next.fraud.thresholds.high).toBe(70)
    expect(next.fraud.thresholds.medium).toBe(30)
    expect(original.fraud.thresholds.high).toBe(60)
    expect(next.list).toBe(original.list)
  })

  it('updates array items and creates missing branches', () => {
    expect(setIn({ list: [1, 2, 3] }, ['list', 1], 9)).toEqual({ list: [1, 9, 3] })
    expect(setIn({}, ['a', 'b'], true)).toEqual({ a: { b: true } })
    expect(Array.isArray(setIn({ list: [{ x: 1 }] }, ['list', 0, 'x'], 2).list)).toBe(true)
  })

  it('reads nested values safely', () => {
    expect(getIn({ a: { b: [10, 20] } }, ['a', 'b', 1])).toBe(20)
    expect(getIn({ a: null }, ['a', 'b'])).toBeUndefined()
  })
})

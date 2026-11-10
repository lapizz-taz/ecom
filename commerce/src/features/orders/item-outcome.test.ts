import { describe, expect, it } from 'vitest'
import { itemOutcome, partialRecorded, recordedBack } from './item-outcome'

describe('what happened to each item', () => {
  it('partly delivered: kept, coming back (recorded), returned and damaged', () => {
    // Customer kept the M; the L was recorded as sent back but has not arrived.
    expect(itemOutcome(1, 0, 0, 0, true)).toEqual({ kept: 1, coming: 0, returned: 0, damaged: 0 })
    expect(itemOutcome(1, 0, 0, 1, true)).toEqual({ kept: 0, coming: 1, returned: 0, damaged: 0 })
    // The L arrived back in stock.
    expect(itemOutcome(1, 1, 0, 1, true)).toEqual({ kept: 0, coming: 0, returned: 1, damaged: 0 })
    // Two of three sent back, one arrived damaged so far.
    expect(itemOutcome(3, 0, 1, 2, true)).toEqual({ kept: 1, coming: 1, returned: 0, damaged: 1 })
    // Scanned back without "Partial delivery…" first.
    expect(itemOutcome(2, 1, 0, 0, true)).toEqual({ kept: 1, coming: 0, returned: 1, damaged: 0 })
  })

  it('other orders: only what came back, nothing when nothing did', () => {
    expect(itemOutcome(2, 2, 0, 0, false)).toEqual({ kept: 0, coming: 0, returned: 2, damaged: 0 })
    expect(itemOutcome(2, 0, 0, 0, false)).toBeNull()
  })

  it('knows when nothing was recorded for a partly delivered order', () => {
    expect(partialRecorded([{ returned: 0, damaged: 0, expected_back: 0 }])).toBe(false)
    expect(partialRecorded([{ returned: 0, damaged: 0, expected_back: 1 }])).toBe(true)
    expect(partialRecorded([{ returned: 1 }])).toBe(true)
  })

  it('reads the latest "Partial delivery…" record from the history', () => {
    const history = [
      { created_at: '2026-11-08T10:00:00Z', metadata: { returned_value: 900, items: [{ order_item_id: 'a', quantity: 1 }] } },
      { created_at: '2026-11-09T10:00:00Z', metadata: { returned_value: 1860, items: [{ order_item_id: 'b', quantity: 1 }] } },
      { created_at: '2026-11-10T10:00:00Z', metadata: { note: 'other' } },
    ]
    expect([...recordedBack(history)]).toEqual([['b', 1]])
    expect(recordedBack([]).size).toBe(0)
  })
})

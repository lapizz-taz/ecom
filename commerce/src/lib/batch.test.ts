import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batcher } from './batch'

describe('batcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hands over a burst of calls once, in order, after the window', () => {
    const flush = vi.fn()
    const b = batcher<number>(flush, 600)
    for (let i = 0; i < 200; i++) b.push(i)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0]).toHaveLength(200)
    expect(flush.mock.calls[0][0][199]).toBe(199)
  })

  it('starts a new window for calls after a flush, and drops pending calls on cancel', () => {
    const flush = vi.fn()
    const b = batcher<string>(flush, 100)
    b.push('a')
    vi.advanceTimersByTime(100)
    b.push('b')
    vi.advanceTimersByTime(100)
    expect(flush.mock.calls.map((c) => c[0])).toEqual([['a'], ['b']])
    b.push('c')
    b.cancel()
    vi.advanceTimersByTime(500)
    expect(flush).toHaveBeenCalledTimes(2)
  })
})

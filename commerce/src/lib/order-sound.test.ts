import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chingForOrders, orderSoundOn, setOrderSoundOn } from './order-sound'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => { items.delete(key) },
    setItem: (key, value) => { items.set(key, String(value)) },
  }
}

describe('the new-order ka-ching', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plays once per order, and says so when asked again (the notification then stays quiet)', async () => {
    const play = vi.fn(async () => true)
    expect(await chingForOrders(['a'], play)).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(await chingForOrders(['a'], play)).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('plays once for a burst of orders', async () => {
    const play = vi.fn(async () => true)
    await chingForOrders(['a', 'b', 'a'], play)
    vi.advanceTimersByTime(800)
    expect(await chingForOrders(['c'], play)).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    expect(await chingForOrders(['d'], play)).toBe(true)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('remembers nothing when it could not play here, so another tab or the notification sounds', async () => {
    const blocked = vi.fn(async () => false)
    expect(await chingForOrders(['a'], blocked)).toBe(false)
    const play = vi.fn(async () => true)
    expect(await chingForOrders(['a'], play)).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('forgets orders after ten minutes', async () => {
    const play = vi.fn(async () => true)
    await chingForOrders(['a'], play)
    vi.advanceTimersByTime(11 * 60_000)
    await chingForOrders(['a'], play)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('stays silent when turned off on this device, or with no orders', async () => {
    const play = vi.fn(async () => true)
    expect(await chingForOrders([], play)).toBe(false)
    expect(orderSoundOn()).toBe(true)
    setOrderSoundOn(false)
    expect(orderSoundOn()).toBe(false)
    expect(await chingForOrders(['a'], play)).toBe(false)
    setOrderSoundOn(true)
    expect(await chingForOrders(['a'], play)).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
  })
})

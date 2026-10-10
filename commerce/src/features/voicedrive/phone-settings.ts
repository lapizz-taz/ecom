// Phone bar preferences, kept in this browser only (they are personal and
// harmless to lose): what pops up during calls, the ring, notifications and
// where the bar sits on the screen.
import { useSyncExternalStore } from 'react'

export interface PhoneSettings {
  /** Open the caller's details on incoming and outgoing calls. */
  autoShowCustomer: boolean
  ringSound: boolean
  /** Same number, status and direction in a row shows once, with a count. */
  combineRepeated: boolean
  desktopNotifications: boolean
  /** Distance of the bar from the bottom-right corner, in pixels. */
  position: { right: number; bottom: number }
  minimized: boolean
}

export const DEFAULT_POSITION = { right: 20, bottom: 20 }
const DEFAULTS: PhoneSettings = {
  autoShowCustomer: true, ringSound: true, combineRepeated: true, desktopNotifications: false, position: DEFAULT_POSITION, minimized: false,
}
const KEY = 'vd.phone-settings'
const listeners = new Set<() => void>()

function load(): PhoneSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<PhoneSettings>
    const pos = v.position && Number.isFinite(v.position.right) && Number.isFinite(v.position.bottom) ? v.position : DEFAULT_POSITION
    return { ...DEFAULTS, ...v, position: pos }
  } catch {
    return DEFAULTS
  }
}

let current = load()

export function getPhoneSettings(): PhoneSettings {
  return current
}

export function setPhoneSettings(patch: Partial<PhoneSettings>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage blocked: kept for this visit */ }
  for (const fn of listeners) fn()
}

export function usePhoneSettings(): PhoneSettings {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, getPhoneSettings)
}

/** Keeps the bar on screen after the window shrinks or a saved position no longer fits. */
export function clampPosition(p: { right: number; bottom: number }, width: number, height: number) {
  const maxRight = Math.max(8, window.innerWidth - width - 8)
  const maxBottom = Math.max(8, window.innerHeight - height - 8)
  return { right: Math.min(Math.max(8, Math.round(p.right)), maxRight), bottom: Math.min(Math.max(8, Math.round(p.bottom)), maxBottom) }
}

interface Groupable { normalizedCustomerPhone: string | null; customerPhone: string | null; status: string; direction: string }

/** Folds runs of the same number + status + direction into one row with a count. */
export function combineRepeated<T extends Groupable>(items: T[]): Array<T & { repeat: number }> {
  const out: Array<T & { repeat: number }> = []
  for (const item of items) {
    const prev = out[out.length - 1]
    const same = prev && (prev.normalizedCustomerPhone ?? prev.customerPhone) === (item.normalizedCustomerPhone ?? item.customerPhone)
      && prev.status === item.status && prev.direction === item.direction
    if (same) prev.repeat++
    else out.push({ ...item, repeat: 1 })
  }
  return out
}

// The new-order "ka-ching": public/media/new-order.mp3 (made by scripts/make-order-sound.mjs).
// It plays while the admin is open; with the app closed or the phone locked, the notification
// (public/push-sw.js) sounds instead, with the phone's own sound, which a website cannot change.

export const ORDER_SOUND_URL = '/media/new-order.mp3'
const SETTING = 'fullfilio-order-sound'
const PLAYED = 'fullfilio-order-sound-played'
/** One ching for a burst: orders arriving this close to the last ching share it. */
const BURST_MS = 1500
/** How long an order is remembered as chinged (the notification can come later than the app's own alert). */
const REMEMBER_MS = 10 * 60_000

let ctx: AudioContext | null = null
let sound: Promise<AudioBuffer | null> | null = null

/** On unless turned off on this device (My account → App and notifications). */
export function orderSoundOn(): boolean {
  try { return localStorage.getItem(SETTING) !== 'off' } catch { return true }
}

export function setOrderSoundOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SETTING)
    else localStorage.setItem(SETTING, 'off')
  } catch { /* private mode: stays on for this visit */ }
}

function audio(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try { ctx = new Ctor() } catch { return null }
  return ctx
}

function load(c: AudioContext): Promise<AudioBuffer | null> {
  sound ??= fetch(ORDER_SOUND_URL)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((bytes) => c.decodeAudioData(bytes))
    .catch(() => { sound = null; return null })
  return sound
}

/**
 * Browsers let a page make sound only after a tap on it. Called on every tap in the admin (cheap
 * once running): the first readies the sound, later ones wake it again after the phone paused it.
 */
export function unlockOrderSound(): void {
  const c = audio()
  if (!c) return
  if (c.state !== 'running') {
    void c.resume().catch(() => undefined)
    // iPhone: something must play inside the tap itself; one silent sample is enough.
    try {
      const silence = c.createBufferSource()
      silence.buffer = c.createBuffer(1, 1, 22050)
      silence.connect(c.destination)
      silence.start(0)
    } catch { /* nothing to unlock */ }
  }
  void load(c)
}

/** True once a tap has readied the sound on this page. */
export function orderSoundReady(): boolean {
  return ctx?.state === 'running'
}

/** Plays it now. False when this page may not make sound yet (no tap) or it could not load. */
export async function playOrderSound(): Promise<boolean> {
  const c = ctx
  if (!c) return false
  if (c.state !== 'running') await c.resume().catch(() => undefined)
  if (c.state !== 'running') return false
  const buffer = await load(c)
  if (!buffer) return false
  const source = c.createBufferSource()
  source.buffer = buffer
  source.connect(c.destination)
  source.start()
  return true
}

function remembered(now: number): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(PLAYED) ?? '{}') as Record<string, number>
    return Object.fromEntries(Object.entries(all).filter(([, at]) => typeof at === 'number' && now - at < REMEMBER_MS))
  } catch {
    return {}
  }
}

function remember(ids: string[], now: number, kept: Record<string, number>): void {
  for (const id of ids) kept[id] = now
  try { localStorage.setItem(PLAYED, JSON.stringify(kept)) } catch { /* private mode: this tab only */ }
}

/** One tab at a time decides (several admin tabs would otherwise ching together). */
function oneTabAtATime(fn: () => Promise<boolean>): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks ? locks.request('fullfilio-order-sound', fn).then((played) => played) : fn()
}

/**
 * Ka-ching for orders that just came in: once per order on this browser, whichever tab or message
 * brought it, and once for a burst. Returns true when it played now or already played for these
 * orders, so a notification for them can stay quiet; false when it could not play here.
 */
export function chingForOrders(ids: string[], play: () => Promise<boolean> = playOrderSound): Promise<boolean> {
  const wanted = [...new Set(ids.filter(Boolean))]
  if (!wanted.length || !orderSoundOn()) return Promise.resolve(false)
  return oneTabAtATime(async () => {
    const now = Date.now()
    const kept = remembered(now)
    const fresh = wanted.filter((id) => !(id in kept))
    if (!fresh.length) return true
    const last = Math.max(0, ...Object.values(kept))
    if (now - last < BURST_MS) {
      remember(fresh, now, kept)
      return true
    }
    const played = await play().catch(() => false)
    if (played) remember(fresh, now, kept)
    return played
  })
}

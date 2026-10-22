// The blue glow buttons (index.css: .btn-glow in the app, .btn-3d-site on the website) carry a
// light (their ::before) that sits under the pointer: its position inside the button as
// --glow-x / --glow-y and its size from the button's height as --glow-r. The light is moved once
// per frame (requestAnimationFrame), straight to the pointer, so it never trails behind.
// Any pointer moves it, whatever the browser calls it: some mice report as a pen or touch
// (virtual machines, tablet drivers, remote desktops). A finger or pen has no hover, and iOS
// Safari shows no :active, so a press also marks the button data-glow-on until it is let go.
// The listeners run in the capture phase so nothing on the page can swallow the events first.
const GLOW = '.btn-glow, .btn-3d-site'
/** A quick tap still shows the light for a moment before it fades. */
const MIN_PRESS_MS = 220

const glowAt = (target: EventTarget | null) => (target as Element | null)?.closest?.(GLOW) as HTMLElement | null

function place(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  el.style.setProperty('--glow-x', `${Math.round(x - r.left)}px`)
  el.style.setProperty('--glow-y', `${Math.round(y - r.top)}px`)
  // A spot about one and a half times the button's height: it reads as a light on a small
  // button and does not wash out a big one.
  el.style.setProperty('--glow-r', `${Math.round(Math.min(80, Math.max(36, r.height * 1.5)))}px`)
}

export function installCursorGlow() {
  if (typeof document === 'undefined') return
  let pressed: { el: HTMLElement; at: number } | null = null
  let next: { el: HTMLElement; x: number; y: number } | null = null
  let frame = 0
  const opts = { passive: true, capture: true } as const

  const flush = () => {
    frame = 0
    if (next) place(next.el, next.x, next.y)
    next = null
  }
  const move = (e: MouseEvent) => {
    const el = glowAt(e.target) ?? pressed?.el
    if (!el) return
    next = { el, x: e.clientX, y: e.clientY }
    if (!frame) frame = requestAnimationFrame(flush)
  }
  // Entering a button places the light at once, so it never shows up somewhere else first.
  document.addEventListener('pointerover', (e) => {
    const el = glowAt(e.target)
    if (el) place(el, e.clientX, e.clientY)
  }, opts)
  document.addEventListener('pointermove', move, opts)
  // Browsers without pointer events still send mouse events.
  if (typeof window.PointerEvent === 'undefined') document.addEventListener('mousemove', move, opts)

  document.addEventListener('pointerdown', (e) => {
    const el = glowAt(e.target)
    if (!el) return
    place(el, e.clientX, e.clientY)
    if (e.pointerType === 'mouse') return // a mouse already lights it by hovering
    el.setAttribute('data-glow-on', '')
    pressed = { el, at: performance.now() }
  }, opts)

  const release = () => {
    if (!pressed) return
    const { el, at } = pressed
    pressed = null
    window.setTimeout(() => el.removeAttribute('data-glow-on'), Math.max(0, MIN_PRESS_MS - (performance.now() - at)))
  }
  document.addEventListener('pointerup', release, opts)
  document.addEventListener('pointercancel', release, opts)
}

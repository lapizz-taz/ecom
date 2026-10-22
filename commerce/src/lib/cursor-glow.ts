// The blue glow buttons (index.css: .btn-glow in the app, .btn-3d-site on the website) light up
// under the cursor: the pointer's position inside the button, as --glow-x / --glow-y.
// A mouse lights them by hovering (CSS :hover). A finger or pen has no hover, and iOS Safari
// shows no :active either, so a press marks the button data-glow-on until it is let go.
const GLOW = '.btn-glow, .btn-3d-site'
/** A quick tap still shows the light for a moment before it fades. */
const MIN_PRESS_MS = 220

function place(el: HTMLElement, e: PointerEvent) {
  const r = el.getBoundingClientRect()
  el.style.setProperty('--glow-x', `${Math.round(e.clientX - r.left)}px`)
  el.style.setProperty('--glow-y', `${Math.round(e.clientY - r.top)}px`)
}

const glowAt = (e: PointerEvent) => (e.target as Element | null)?.closest?.(GLOW) as HTMLElement | null

export function installCursorGlow() {
  if (typeof document === 'undefined') return
  let pressed: { el: HTMLElement; at: number } | null = null

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      const el = glowAt(e)
      if (el) place(el, e)
    } else if (pressed) {
      place(pressed.el, e)
    }
  }, { passive: true })

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    const el = glowAt(e)
    if (!el) return
    place(el, e)
    el.setAttribute('data-glow-on', '')
    pressed = { el, at: performance.now() }
  }, { passive: true })

  const release = () => {
    if (!pressed) return
    const { el, at } = pressed
    pressed = null
    window.setTimeout(() => el.removeAttribute('data-glow-on'), Math.max(0, MIN_PRESS_MS - (performance.now() - at)))
  }
  document.addEventListener('pointerup', release, { passive: true })
  document.addEventListener('pointercancel', release, { passive: true })
}

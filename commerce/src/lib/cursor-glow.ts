// The blue glow buttons (index.css: .btn-glow in the app, .btn-3d-site on the website) light up
// under the cursor: the pointer's position inside the button, as --glow-x / --glow-y.
const GLOW = '.btn-glow, .btn-3d-site'

export function installCursorGlow() {
  if (typeof document === 'undefined') return
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    const el = (e.target as Element | null)?.closest?.(GLOW) as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--glow-x', `${Math.round(e.clientX - r.left)}px`)
    el.style.setProperty('--glow-y', `${Math.round(e.clientY - r.top)}px`)
  }, { passive: true })
}

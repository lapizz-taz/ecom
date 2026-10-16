import { useEffect } from 'react'
import { useLocation } from 'react-router'

const TEXT = new Set(['INPUT', 'TEXTAREA'])
const KEYLESS = new Set(['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'])

function opensKeyboard(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (!TEXT.has(el.tagName)) return false
  return !(el instanceof HTMLInputElement && KEYLESS.has(el.type))
}

/**
 * On phones and tablets, a page must not open the on-screen keyboard by itself.
 * For a moment after each page change, a text field that takes focus without the
 * person touching the screen (autoFocus, a dialog focusing its first field) is let
 * go again. Tapping a field works as always; desktops are untouched.
 */
export function useNoAutoKeyboard(windowMs = 1500) {
  const { pathname } = useLocation()
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches) return
    let touched = false
    const onTouch = () => { touched = true }
    const release = (el: Element | null) => { if (!touched && opensKeyboard(el)) el.blur() }
    const onFocus = (e: FocusEvent) => release(e.target as Element)
    window.addEventListener('pointerdown', onTouch, true)
    window.addEventListener('touchstart', onTouch, true)
    window.addEventListener('focusin', onFocus, true)
    release(document.activeElement)
    const stop = window.setTimeout(() => window.removeEventListener('focusin', onFocus, true), windowMs)
    return () => {
      window.clearTimeout(stop)
      window.removeEventListener('focusin', onFocus, true)
      window.removeEventListener('pointerdown', onTouch, true)
      window.removeEventListener('touchstart', onTouch, true)
    }
  }, [pathname, windowMs])
}

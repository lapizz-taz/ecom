import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'

/**
 * Admin colour mode: light, dark or follow the system. Dark is the default
 * (black-and-grey). The choice is remembered per browser. Classes go on
 * <html> so dialogs, menus and toasts (portalled to <body>) match; the
 * storefront stays light because the classes are removed when the admin
 * unmounts.
 */
export type AdminTheme = 'light' | 'dark' | 'system'

const KEY = 'admin-theme'
const listeners = new Set<() => void>()

function read(): AdminTheme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

export function setAdminTheme(theme: AdminTheme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  current = theme
  listeners.forEach((l) => l())
}

let current: AdminTheme = typeof window === 'undefined' ? 'dark' : read()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAdminThemePreference(): AdminTheme {
  return useSyncExternalStore(subscribe, () => current, () => 'dark')
}

function systemDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/** Applies the chosen mode while the admin is mounted. */
export function useAdminTheme() {
  const theme = useAdminThemePreference()

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.add('admin')
    root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && systemDark()))
    return () => root.classList.remove('admin', 'dark')
  }, [theme])

  useEffect(() => {
    if (theme !== 'system' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => document.documentElement.classList.toggle('dark', media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])
}

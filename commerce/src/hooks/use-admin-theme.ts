import { useLayoutEffect } from 'react'

/**
 * The admin works on a dark black-and-grey surface; the storefront stays light.
 * The class goes on <html> so dialogs, menus and toasts (portalled to <body>)
 * get the same palette.
 */
export function useAdminTheme() {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.add('dark')
    return () => root.classList.remove('dark')
  }, [])
}

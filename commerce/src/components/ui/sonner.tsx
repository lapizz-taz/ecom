import { GooeyToaster } from 'goey-toast'
import 'goey-toast/styles.css'
import { useEffect, useState } from 'react'

/** Follows the dark class the admin puts on <html> (the storefront stays light). */
function useHtmlDark() {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function Toaster({ position = 'top-right' }: { position?: 'top-right' | 'top-center' | 'bottom-right' | 'bottom-center' }) {
  const dark = useHtmlDark()
  return <GooeyToaster position={position} theme={dark ? 'dark' : 'light'} closeButton preset="smooth" visibleToasts={4} offset="4.25rem" closeOnEscape swipeToDismiss />
}

export { Toaster }

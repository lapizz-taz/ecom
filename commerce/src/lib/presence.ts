import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { deviceLabel } from '@/lib/device'
import { supabase } from '@/lib/supabase'

const BEAT_MS = 60_000
const MIN_GAP_MS = 20_000

/**
 * Tells Super Admin this person is here: one heartbeat a minute while the tab is
 * visible, and one when they move to another section (at most every 20 s). The
 * server keeps only the latest beat and blanks ids in the path; nothing is sent
 * from a hidden tab.
 */
export function usePresence(area: 'admin' | 'super-admin', enabled: boolean) {
  const { pathname } = useLocation()
  const last = useRef(0)
  const path = useRef(pathname)
  path.current = pathname

  useEffect(() => {
    if (!enabled) return
    const beat = (force = false) => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (!force && now - last.current < MIN_GAP_MS) return
      last.current = now
      void supabase.rpc('presence_ping' as never, { p_area: area, p_path: path.current, p_device: deviceLabel() } as never)
        .then(({ error }) => { if (error && !/permission|PERMISSION/.test(error.message)) console.warn('presence:', error.message) })
    }
    beat(true)
    const timer = window.setInterval(() => beat(true), BEAT_MS)
    const onVisible = () => beat()
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [area, enabled])

  // A new section counts as activity too.
  useEffect(() => {
    if (!enabled || document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - last.current < MIN_GAP_MS) return
    last.current = now
    void supabase.rpc('presence_ping' as never, { p_area: area, p_path: pathname, p_device: deviceLabel() } as never)
  }, [pathname, area, enabled])
}

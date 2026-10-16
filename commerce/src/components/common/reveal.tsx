import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const DURATION_MS = 450

/**
 * Opens and closes its content by sliding the space for it open, so what sits
 * below moves down smoothly instead of jumping; while open, the space also
 * follows the content when it grows or shrinks (a loader replaced by results).
 * `gap` is the space kept under the content while it is open (it closes with
 * it). On close the last content stays visible until the slide has finished.
 */
export function Reveal({ open, children, gap = 'pb-4', className }: { open: boolean; children: ReactNode; gap?: string; className?: string }) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(false)
  const [height, setHeight] = useState(0)
  const inner = useRef<HTMLDivElement>(null)
  const last = useRef(children)
  if (open) last.current = children

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Paint the closed state once, then open, so the slide runs.
      let next = 0
      const first = requestAnimationFrame(() => { next = requestAnimationFrame(() => setExpanded(true)) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(next) }
    }
    setExpanded(false)
    const t = window.setTimeout(() => setMounted(false), DURATION_MS)
    return () => window.clearTimeout(t)
  }, [open])

  useLayoutEffect(() => {
    const el = inner.current
    if (!mounted || !el) return
    setHeight(el.offsetHeight)
    const watch = new ResizeObserver(() => setHeight(el.offsetHeight))
    watch.observe(el)
    return () => watch.disconnect()
  }, [mounted])

  if (!mounted) return null
  return (
    <div
      aria-hidden={!open || undefined}
      style={{ height: expanded ? height : 0 }}
      className={cn(
        'mb-0 overflow-hidden transition-[height,opacity,translate] duration-[450ms] ease-[var(--ease-out)] motion-reduce:transition-none',
        expanded ? 'opacity-100' : 'pointer-events-none -translate-y-1.5 opacity-0',
        className,
      )}
    >
      <div ref={inner} className={cn('flow-root', gap)}>{open ? children : last.current}</div>
    </div>
  )
}

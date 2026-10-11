import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'

/**
 * Floating bar with the actions for the selected rows. It appears at the
 * bottom of the screen while something is selected, so it stays in reach
 * however far the list is scrolled.
 */
export function BulkBar({ count, onClear, children, noun = 'selected' }: { count: number; onClear: () => void; children: ReactNode; noun?: string }) {
  if (count <= 0) return null
  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 lg:pl-[var(--shell-menu,0px)]">
      <div role="toolbar" aria-label="Actions for the selected rows"
        className="pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto rounded-2xl border bg-popover/95 p-1.5 pl-3.5 text-popover-foreground shadow-xl backdrop-blur-md duration-200 animate-in fade-in-0 slide-in-from-bottom-3 [&_[data-slot=button]]:rounded-[10px] [&_[data-slot=select-trigger]]:rounded-[10px]">
        <span className="text-sm font-medium whitespace-nowrap tabular-nums">{formatNumber(count)} {noun}</span>
        <span className="mx-1 h-5 w-px shrink-0 bg-border" />
        {children}
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear the selection" className="shrink-0"><X /></Button>
      </div>
    </div>
  )
}

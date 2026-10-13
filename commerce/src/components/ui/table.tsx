import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Gives each body cell the text of its column header (data-label), so that inside a
 * [data-stack-tables] area a table can turn into labelled stacked rows on a phone
 * (index.css) instead of scrolling sideways. Re-labels when rows change.
 */
function useCellLabels(ref: React.RefObject<HTMLTableElement | null>) {
  React.useLayoutEffect(() => {
    const table = ref.current
    if (!table || !table.closest('[data-stack-tables]')) return
    const label = () => {
      const heads: string[] = []
      for (const th of table.querySelectorAll<HTMLTableCellElement>(':scope > thead > tr:last-child > th')) {
        for (let i = 0; i < (th.colSpan || 1); i++) heads.push(th.textContent?.trim() ?? '')
      }
      for (const tr of table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr, :scope > tfoot > tr')) {
        let col = 0
        for (const td of tr.cells) {
          const text = td.colSpan > 1 ? '' : heads[col] ?? ''
          if (td.dataset.label !== text) td.dataset.label = text
          col += td.colSpan || 1
        }
      }
    }
    label()
    const observer = new MutationObserver(label)
    observer.observe(table, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [ref])
}

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  const ref = React.useRef<HTMLTableElement>(null)
  useCellLabels(ref)
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table ref={ref} data-slot="table" className={cn('w-full caption-bottom text-[13px]', className)} {...props} />
    </div>
  )
}
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-muted/45 [&_tr]:border-b', className)} {...props} />
}
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return <tfoot data-slot="table-footer" className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} />
}
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-brand-soft', className)} {...props} />
}
function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn('h-9 px-3 text-left align-middle text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  )
}
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-3 py-2.5 align-middle whitespace-nowrap first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0', className)} {...props} />
}

export { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow }

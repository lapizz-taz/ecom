import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { EmptyState, ErrorState, TableSkeleton } from './states'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  className?: string
  align?: 'left' | 'right' | 'center'
  /** Title line of the mobile card. */
  primary?: boolean
  /** Not shown on the mobile card. */
  hideOnMobile?: boolean
}

interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T) => string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  empty?: ReactNode
  rowHref?: (row: T) => string
  onRowClick?: (row: T) => void
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  footer?: ReactNode
  className?: string
  dense?: boolean
}

/**
 * Compact table on desktop; stacked cards on phones so nothing important is
 * hidden behind horizontal scrolling.
 */
export function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry, empty, rowHref, onRowClick, selected, onSelectedChange, footer, className,
}: DataTableProps<T>) {
  const navigate = useNavigate()
  const selectable = Boolean(selected && onSelectedChange)
  const allSelected = !!rows?.length && rows.every((r) => selected?.has(rowKey(r)))
  const someSelected = !!rows?.some((r) => selected?.has(rowKey(r)))

  const toggle = (id: string) => {
    if (!selected || !onSelectedChange) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectedChange(next)
  }
  const toggleAll = () => {
    if (!rows || !onSelectedChange) return
    onSelectedChange(allSelected ? new Set() : new Set(rows.map(rowKey)))
  }
  const activate = (row: T) => {
    if (onRowClick) onRowClick(row)
    else if (rowHref) navigate(rowHref(row))
  }
  const clickable = Boolean(onRowClick || rowHref)
  const align = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : '')

  let body: ReactNode
  if (error) body = <ErrorState error={error} onRetry={onRetry} />
  else if (loading && !rows) body = <TableSkeleton cols={Math.min(columns.length, 6)} />
  else if (!rows?.length) body = empty ?? <EmptyState title="Nothing here yet" />
  else {
    body = (
      <>
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {selectable && (
                  <TableHead className="w-8">
                    <Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} onCheckedChange={toggleAll} aria-label="Select all" />
                  </TableHead>
                )}
                {columns.map((c) => <TableHead key={c.key} className={cn(align(c.align), c.className)}>{c.header}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody className={cn(loading && 'opacity-60')}>
              {rows.map((row) => {
                const id = rowKey(row)
                return (
                  <TableRow key={id} data-state={selected?.has(id) ? 'selected' : undefined}
                    className={cn(clickable && 'cursor-pointer')} onClick={() => clickable && activate(row)}>
                    {selectable && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={selected?.has(id)} onCheckedChange={() => toggle(id)} aria-label="Select row" />
                      </TableCell>
                    )}
                    {columns.map((c) => <TableCell key={c.key} className={cn(align(c.align), c.className)}>{c.cell(row)}</TableCell>)}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <ul className={cn('divide-y md:hidden', loading && 'opacity-60')}>
          {rows.map((row) => {
            const id = rowKey(row)
            const primary = columns.find((c) => c.primary) ?? columns[0]
            return (
              <li key={id} className={cn('flex gap-3 px-3 py-3', clickable && 'active:bg-muted/60')} onClick={() => clickable && activate(row)}>
                {selectable && (
                  <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                    <Checkbox checked={selected?.has(id)} onCheckedChange={() => toggle(id)} aria-label="Select row" />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="font-medium">{primary.cell(row)}</div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    {columns.filter((c) => c !== primary && !c.hideOnMobile).map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{c.header}</dt>
                        <dd className="truncate">{c.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </li>
            )
          })}
        </ul>
      </>
    )
  }

  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      {body}
      {footer}
    </Card>
  )
}

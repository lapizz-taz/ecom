import { Download } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAuth } from '@/features/auth/auth-context'
import { downloadCsv } from '@/lib/csv'
import { formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface ReportColumn<T> {
  header: string
  value: (row: T) => unknown
  /** Custom rendering; defaults to the formatted value. */
  cell?: (row: T) => ReactNode
  format?: 'money' | 'number' | 'percent' | 'text'
}

function formatted(value: unknown, format: ReportColumn<unknown>['format']): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>
  if (format === 'money') return formatMoney(value)
  if (format === 'number') return formatNumber(value)
  if (format === 'percent') return formatPercent(value)
  return String(value)
}

/** A titled table with CSV export of exactly what is shown. */
export function ReportTable<T>({ title, description, rows, columns, filename, empty = 'No data for this period', maxHeight, footer }: {
  title: string
  description?: ReactNode
  rows: T[]
  columns: ReportColumn<T>[]
  filename: string
  empty?: string
  maxHeight?: number
  footer?: ReactNode
}) {
  const { can } = useAuth()
  const right = (c: ReportColumn<T>) => c.format === 'money' || c.format === 'number' || c.format === 'percent'
  return (
    <Card className="gap-3 break-inside-avoid">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {can('reports.export') && rows.length > 0 && (
          <CardAction className="no-print">
            <Button size="sm" variant="ghost" onClick={() => downloadCsv(filename, rows, columns.map((c) => ({ header: c.header, value: c.value })))}>
              <Download /> CSV
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-auto print:max-h-none" style={maxHeight ? { maxHeight } : undefined}>
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                {columns.map((c) => <TableHead key={c.header} className={cn('first:pl-6 last:pr-6', right(c) && 'text-right')}>{c.header}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={columns.length} className="py-8 text-center text-muted-foreground">{empty}</TableCell></TableRow>
              )}
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c.header} className={cn('first:pl-6 last:pr-6', right(c) && 'text-right tabular-nums')}>
                      {c.cell ? c.cell(row) : formatted(c.value(row), c.format)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {footer && <div className="px-6 pt-3">{footer}</div>}
      </CardContent>
    </Card>
  )
}

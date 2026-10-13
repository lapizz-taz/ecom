import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatNumber } from '@/lib/format'

export function Pagination({ page, pageSize, total, onPage, pageSizes, onPageSize }: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  /** With onPageSize: the "Rows per page" choices. */
  pageSizes?: number[]
  onPageSize?: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-3 py-2.5 text-sm text-muted-foreground">
      <span className="tabular-nums">{formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onPageSize && pageSizes?.length ? (
          <label className="flex items-center gap-2">
            <span className="whitespace-nowrap">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
              <SelectTrigger size="sm" className="w-[4.5rem] tabular-nums" aria-label="Rows per page"><SelectValue /></SelectTrigger>
              <SelectContent>
                {pageSizes.map((n) => <SelectItem key={n} value={String(n)} className="tabular-nums">{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap px-1 tabular-nums">Page {page} of {pages}</span>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft /><span className="hidden sm:inline">Previous</span>
          </Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <span className="hidden sm:inline">Next</span><ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

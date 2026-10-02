import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'
import { listSystemLogs, resolveSystemLogs, SYSTEM_LOG_CATEGORIES } from '@/services/audit'

const PAGE_SIZE = 50
const LEVEL_VARIANT = { ERROR: 'danger', WARN: 'warning', INFO: 'neutral' } as const

/** Failures from server functions, integrations, webhooks and the admin app. */
export default function SystemLogsPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ level: '', category: '', status: 'open', page: '1' })
  const page = Number(state.page) || 1
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const logs = useQuery({
    queryKey: ['system-logs', state],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: () => listSystemLogs({ level: state.level, category: state.category, status: state.status, page, pageSize: PAGE_SIZE }),
  })
  const resolve = useMutation({
    mutationFn: (ids: number[]) => resolveSystemLogs(ids),
    onSuccess: (n) => {
      toast.success(`${n} marked as resolved`)
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['system-logs'] })
      void queryClient.invalidateQueries({ queryKey: ['system-problems'] })
    },
  })
  const rows = logs.data?.items ?? []
  const toggle = (set: Set<number>, id: number) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next }
  const openRows = rows.filter((r) => !r.resolved_at)

  return (
    <div>
      <PageHeader title="System log" description="Errors and warnings from checkout, couriers, payments, SMS, Meta and the admin. Repeats of the same problem are counted on one line."
        actions={selected.size > 0 && (
          <Button size="sm" onClick={() => resolve.mutate([...selected])} disabled={resolve.isPending}>
            {resolve.isPending ? <Spinner /> : <CheckCheck />} Resolve {selected.size}
          </Button>
        )} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="open">Open</SelectItem><SelectItem value="resolved">Resolved</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
        </Select>
        <Select value={state.level || 'all'} onValueChange={(v) => update({ level: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger className="w-36" aria-label="Level"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All levels</SelectItem><SelectItem value="ERROR">Errors</SelectItem><SelectItem value="WARN">Warnings</SelectItem><SelectItem value="INFO">Info</SelectItem></SelectContent>
        </Select>
        <Select value={state.category || 'all'} onValueChange={(v) => update({ category: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger className="w-40" aria-label="Area"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {SYSTEM_LOG_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {logs.isLoading ? <TableSkeleton /> : logs.error ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : rows.length === 0 ? (
          <EmptyState title={state.status === 'open' ? 'No open problems' : 'Nothing logged'} description="Failures from integrations and server functions show up here as they happen." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox aria-label="Select all open" checked={openRows.length > 0 && openRows.every((r) => selected.has(r.id))}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(openRows.map((r) => r.id)) : new Set())} />
                </TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead className="text-right">Times</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className={cn('cursor-pointer', r.resolved_at && 'opacity-60')} onClick={() => setOpen((s) => toggle(s, r.id))}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {!r.resolved_at && <Checkbox aria-label="Select" checked={selected.has(r.id)} onCheckedChange={() => setSelected((s) => toggle(s, r.id))} />}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.last_seen_at)}</TableCell>
                    <TableCell><Badge variant={LEVEL_VARIANT[r.level as keyof typeof LEVEL_VARIANT] ?? 'neutral'}>{titleCase(r.level)}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap">{titleCase(r.category)}<span className="block text-xs text-muted-foreground">{r.source}</span></TableCell>
                    <TableCell className="max-w-xl"><p className="line-clamp-2">{r.message}</p></TableCell>
                    <TableCell className="text-right tabular-nums">{r.occurrences}</TableCell>
                    <TableCell className="w-8 text-muted-foreground">{open.has(r.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                  </TableRow>
                  {open.has(r.id) && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell />
                      <TableCell colSpan={6} className="pb-4">
                        <p className="mb-2 text-xs text-muted-foreground">
                          First seen {formatDateTime(r.created_at)}{r.resolved_at ? ` · resolved ${formatDateTime(r.resolved_at)}` : ''}
                        </p>
                        <pre className="max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 text-xs whitespace-pre-wrap">{JSON.stringify(r.context, null, 2)}</pre>
                        {!r.resolved_at && (
                          <Button size="sm" variant="outline" className="mt-3" onClick={() => resolve.mutate([r.id])} disabled={resolve.isPending}><CheckCheck /> Mark resolved</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <Pagination page={page} pageSize={PAGE_SIZE} total={logs.data?.total ?? 0} onPage={(p) => update({ page: String(p) })} />
    </div>
  )
}

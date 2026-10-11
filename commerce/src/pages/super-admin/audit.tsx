import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Download } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { listPlatformAudit, type PlatformAuditRow } from '@/services/platform'

const PAGE_SIZE = 50
const RESULT = { SUCCESS: 'success', FAILED: 'danger', DENIED: 'warning', REQUESTED: 'info' } as const

const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v))

export default function PlatformAuditPage() {
  const { can } = usePlatform()
  const [state, update] = useUrlState({ q: '', action: '', result: '', from: '', to: '', merchant: '', page: '1' })
  const page = Number(state.page) || 1
  const [open, setOpen] = useState<Set<number>>(new Set())
  const filters = { q: state.q, action: state.action, result: state.result, from: state.from, to: state.to ? `${state.to}T23:59:59.999Z` : '', merchant_id: state.merchant }
  const logs = useQuery({ queryKey: ['platform-audit', state], placeholderData: keepPreviousData, queryFn: () => listPlatformAudit(filters, page, PAGE_SIZE) })
  const toggle = (id: number) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const exportCsv = async () => {
    const all = await listPlatformAudit(filters, 1, 500)
    downloadCsv<PlatformAuditRow>(`platform-audit-${new Date().toISOString().slice(0, 10)}.csv`, all.items, [
      { header: 'When', value: (r) => r.created_at },
      { header: 'Who', value: (r) => r.actor_email ?? 'system' },
      { header: 'Action', value: (r) => r.action },
      { header: 'Result', value: (r) => r.result },
      { header: 'Merchant', value: (r) => (r.merchant ? `#${r.merchant.number} ${r.merchant.name}` : '') },
      { header: 'Record', value: (r) => `${r.entity_type ?? ''} ${r.entity_id ?? ''}`.trim() },
      { header: 'Reason', value: (r) => r.reason ?? '' },
      { header: 'Request', value: (r) => r.request_id ?? '' },
    ])
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Audit Logs" description="Every action taken in this panel: who, on which merchant, what changed, why, and whether it worked. Entries can't be edited or deleted."
        actions={can('audit', 'export') && <Button size="sm" variant="outline" onClick={exportCsv}><Download /> Export (up to 500)</Button>} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q, page: '1' })} placeholder="Action, record, reason or e-mail" />
        <Select value={state.action || 'all'} onValueChange={(v) => update({ action: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {['merchant', 'employees', 'approval', 'platform_credential', 'subscription', 'credits', 'features', 'support', 'pbx', 'settings'].map((a) => <SelectItem key={a} value={a}>{a.replace(/_/g, ' ')}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.result || 'all'} onValueChange={(v) => update({ result: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any result</SelectItem>
            {Object.keys(RESULT).map((r) => <SelectItem key={r} value={r}>{r.toLowerCase()}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="h-8 w-36" value={state.from} onChange={(e) => update({ from: e.target.value, page: '1' })} aria-label="From" />
        <Input type="date" className="h-8 w-36" value={state.to} onChange={(e) => update({ to: e.target.value, page: '1' })} aria-label="To" />
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {logs.error ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : !logs.data ? <TableSkeleton /> : logs.data.items.length === 0 ? <EmptyState title="Nothing recorded for these filters" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="w-8" /><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Merchant</TableHead><TableHead>Result</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody className={cn(logs.isFetching && 'opacity-60')}>
                {logs.data.items.map((r) => (
                  <Fragment key={r.id}>
                    <TableRow className="cursor-pointer" onClick={() => toggle(r.id)}>
                      <TableCell>{open.has(r.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                      <TableCell className="text-xs">{r.actor_email ?? 'system'}</TableCell>
                      <TableCell><code className="text-xs">{r.action}</code></TableCell>
                      <TableCell className="text-xs">{r.merchant ? <Link className="underline" to={`/super-admin/merchants/${r.merchant.id}`} onClick={(e) => e.stopPropagation()}>#{r.merchant.number} {r.merchant.name}</Link> : '—'}</TableCell>
                      <TableCell><Badge variant={RESULT[r.result]}>{r.result.toLowerCase()}</Badge></TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{r.reason ?? ''}</TableCell>
                    </TableRow>
                    {open.has(r.id) && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <div className="grid gap-3 text-xs md:grid-cols-2">
                            <div><p className="mb-1 font-medium text-muted-foreground">Before</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2">{show(r.before)}</pre></div>
                            <div><p className="mb-1 font-medium text-muted-foreground">After</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2">{show(r.after)}</pre></div>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">Record: {r.entity_type ?? '—'} {r.entity_id ?? ''}{r.request_id && ` · request ${r.request_id}`}{Object.keys(r.metadata ?? {}).length > 0 && ` · ${JSON.stringify(r.metadata)}`}</p>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {logs.data && <div className="border-t px-3 py-2"><Pagination page={page} pageSize={PAGE_SIZE} total={logs.data.total} onPage={(p) => update({ page: String(p) })} /></div>}
      </Card>
    </div>
  )
}

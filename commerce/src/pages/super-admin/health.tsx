import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Gauge, RefreshCw, RotateCcw, Siren } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  databasePing, edgeHealth, type HealthComponent, type HealthStatus, healthRetry, platformHealth, resolveLogs, type RetryResult, type SystemLog, systemLogs,
} from '@/services/platform-ops'

const STATUS: Record<HealthStatus, { label: string; variant: BadgeVariant; dot: string }> = {
  ok: { label: 'Healthy', variant: 'success', dot: 'bg-emerald-500' },
  warn: { label: 'Degraded', variant: 'warning', dot: 'bg-amber-500' },
  down: { label: 'Down', variant: 'danger', dot: 'bg-red-500' },
  idle: { label: 'No activity', variant: 'neutral', dot: 'bg-zinc-400' },
  unknown: { label: 'Not measurable', variant: 'neutral', dot: 'bg-zinc-400' },
}
export const HealthBadge = ({ status }: { status: HealthStatus }) => <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>

function ComponentCard({ c, canRetry, onRetry }: { c: HealthComponent; canRetry: boolean; onRetry: (kind: string) => void }) {
  return (
    <Card className="min-w-0 gap-2 px-4 py-3.5 [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', STATUS[c.status].dot)} aria-hidden />
          <p className="truncate text-sm font-medium">{c.name}</p>
        </div>
        <HealthBadge status={c.status} />
      </div>
      <p className="text-sm">{c.detail}</p>
      <p className="text-xs text-muted-foreground">How it is checked: {c.check}{c.at && ` · last activity ${timeAgo(c.at)}`}</p>
      {canRetry && c.retry && (c.retryable ?? 0) > 0 && (
        <Button size="sm" variant="outline" className="w-fit" onClick={() => onRetry(c.retry!)}><RotateCcw /> Retry {formatNumber(c.retryable)} failed</Button>
      )}
    </Card>
  )
}

/** Measured from this browser: a database call and a call into the edge runtime (which checks its own access). */
function LiveChecks() {
  const db = useQuery({ queryKey: ['platform-health', 'db-ping'], queryFn: databasePing, refetchInterval: 60_000, retry: false })
  const edge = useQuery({ queryKey: ['platform-health', 'edge'], queryFn: edgeHealth, refetchInterval: 120_000, retry: false })
  const unset = (m: Record<string, boolean> | undefined) => Object.entries(m ?? {}).filter(([, set]) => !set).map(([k]) => k)
  const missing = unset(edge.data?.settings.required)
  const optionalMissing = unset(edge.data?.settings.optional)
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle className="text-sm">Live checks from your browser</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => { void db.refetch(); void edge.refetch() }} disabled={db.isFetching || edge.isFetching}>
          {db.isFetching || edge.isFetching ? <Spinner /> : <RefreshCw />} Check now
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 py-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">Database API</span>
            {db.error ? <HealthBadge status="down" /> : db.data == null ? <Spinner /> : <HealthBadge status={db.data > 2000 ? 'warn' : 'ok'} />}</div>
          <p className="text-xs text-muted-foreground">{db.error ? (db.error as Error).message : db.data != null ? `Answered in ${db.data} ms` : 'Measuring…'}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">Server functions (edge runtime)</span>
            {edge.error ? <HealthBadge status="down" /> : !edge.data ? <Spinner /> : <HealthBadge status={edge.data.checks.every((c) => c.ok) ? (missing.length ? 'warn' : 'ok') : 'down'} />}</div>
          {edge.error ? <p className="text-xs text-red-500">{(edge.error as Error).message}</p> : edge.data && (
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <p>Round trip {edge.data.round_trip_ms} ms · runtime {edge.data.runtime.version}</p>
              {edge.data.checks.map((c) => <p key={c.name} className={c.ok ? '' : 'text-red-500'}>{c.name === 'database' ? 'Database from the server' : 'Sign-in service'}: {c.ok ? `${c.detail} (${c.ms} ms)` : c.detail}</p>)}
              {missing.length > 0 && <p className="text-amber-600">Required but not set: {missing.join(', ')}</p>}
              {optionalMissing.length > 0 && <p>Optional, not set: {optionalMissing.join(', ')}</p>}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function RetryDialog({ kind, onClose }: { kind: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const preview = useQuery({ queryKey: ['platform-health', 'retry-preview', kind], queryFn: () => healthRetry(kind, true) })
  const label = kind === 'store_jobs' ? 'failed store sync jobs (last 7 days)' : 'failed courier status updates (last 7 days, under 6 attempts)'
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title="Retry failed work" confirmLabel={preview.data ? `Retry ${preview.data.count}` : 'Retry'}
      reason reasonRequired reasonLabel="Why retry now (for the audit log)"
      description={`This queues the ${label} again. Each item is processed once; items that already have a newer attempt waiting are left alone.`}
      onConfirm={async (reason) => {
        if (!preview.data?.count) return
        const r: RetryResult = await healthRetry(kind, false, reason)
        toast.success(`${r.count} queued again`)
        void queryClient.invalidateQueries({ queryKey: ['platform-health'] })
      }}>
      {preview.isLoading ? <Spinner /> : preview.error ? <ErrorState error={preview.error} /> : preview.data && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p><strong>{formatNumber(preview.data.count)}</strong> item(s) for {formatNumber(preview.data.merchants.length)} merchant(s):</p>
          <ul className="max-h-40 overflow-y-auto text-xs text-muted-foreground">
            {preview.data.merchants.map((m) => <li key={m.id}>#{m.number} {m.name}</li>)}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  )
}

const LEVEL_VARIANT: Record<string, BadgeVariant> = { ERROR: 'danger', WARN: 'warning', INFO: 'neutral' }
const CATEGORIES = ['WEBHOOK', 'FUNCTION', 'COURIER', 'PAYMENT', 'JOB', 'SMS', 'META', 'AUTH', 'FRAUD', 'FRONTEND', 'OTHER']

function LogBrowser({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const [f, setF] = useState({ q: '', level: 'all', category: 'all', unresolved: 'true' })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number[]>([])
  const [open, setOpen] = useState<SystemLog | null>(null)
  const filters = { q: f.q, level: f.level === 'all' ? '' : f.level, category: f.category === 'all' ? '' : f.category, unresolved: f.unresolved === 'true' }
  const q = useQuery({ queryKey: ['platform-health', 'logs', filters, page], queryFn: () => systemLogs(filters, 50, (page - 1) * 50), placeholderData: keepPreviousData })
  const resolve = useMutation({
    mutationFn: (ids: number[]) => resolveLogs(ids),
    onSuccess: (n) => { toast.success(`${n} marked resolved`); setSelected([]); void queryClient.invalidateQueries({ queryKey: ['platform-health'] }) },
  })
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); setSelected([]) }
  const rows = q.data?.rows ?? []
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <SearchInput value={f.q} onChange={(v) => set({ q: v })} placeholder="Search message or source" className="w-full sm:w-64" />
        <Select value={f.level} onValueChange={(level) => set({ level })}>
          <SelectTrigger className="w-32" aria-label="Level"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All levels</SelectItem>{['ERROR', 'WARN', 'INFO'].map((l) => <SelectItem key={l} value={l}>{l.toLowerCase()}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={f.category} onValueChange={(category) => set({ category })}>
          <SelectTrigger className="w-40" aria-label="Category"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All categories</SelectItem>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c.toLowerCase()}{q.data?.by_category[c] ? ` (${q.data.by_category[c]})` : ''}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={f.unresolved} onValueChange={(unresolved) => set({ unresolved })}>
          <SelectTrigger className="w-36" aria-label="Resolved"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="true">Unresolved</SelectItem><SelectItem value="false">Everything</SelectItem></SelectContent>
        </Select>
        {canManage && selected.length > 0 && (
          <Button size="sm" className="ml-auto" disabled={resolve.isPending} onClick={() => resolve.mutate(selected)}><CheckCheck /> Mark {selected.length} resolved</Button>
        )}
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton rows={6} cols={5} /> : rows.length === 0 ? (
        <EmptyState title="Nothing logged" description={f.unresolved === 'true' ? 'No unresolved entries match.' : 'No entries match.'} />
      ) : (
        <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow>
            {canManage && <TableHead className="w-8"><Checkbox aria-label="Select all" checked={rows.length > 0 && rows.filter((r) => !r.resolved_at).every((r) => selected.includes(r.id))}
              onCheckedChange={(v) => setSelected(v ? rows.filter((r) => !r.resolved_at).map((r) => r.id) : [])} /></TableHead>}
            <TableHead>Level</TableHead><TableHead>What happened</TableHead><TableHead>Merchant</TableHead><TableHead className="text-right">Times</TableHead><TableHead>Last seen</TableHead>
          </TableRow></TableHeader>
          <TableBody>{rows.map((r) => (
            <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpen(r)}>
              {canManage && <TableCell onClick={(e) => e.stopPropagation()}>{!r.resolved_at && <Checkbox aria-label={`Select log ${r.id}`} checked={selected.includes(r.id)}
                onCheckedChange={(v) => setSelected(v ? [...selected, r.id] : selected.filter((x) => x !== r.id))} />}</TableCell>}
              <TableCell><Badge variant={LEVEL_VARIANT[r.level] ?? 'neutral'}>{r.level.toLowerCase()}</Badge></TableCell>
              <TableCell className="max-w-md whitespace-normal"><p className="line-clamp-2 text-sm">{r.message}</p><p className="text-xs text-muted-foreground">{r.category.toLowerCase()} · {r.source}{r.resolved_at && ' · resolved'}</p></TableCell>
              <TableCell className="text-xs">{r.merchant ? <Link onClick={(e) => e.stopPropagation()} className="hover:underline" to={`/super-admin/merchants/${r.merchant.id}`}>#{r.merchant.number} {r.merchant.name}</Link> : 'Platform'}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{formatNumber(r.occurrences)}</TableCell>
              <TableCell className="text-xs">{timeAgo(r.last_seen_at)}</TableCell>
            </TableRow>))}</TableBody>
        </Table></div>
      )}
      {q.data && q.data.total > 50 && <div className="border-t p-2"><Pagination page={page} pageSize={50} total={q.data.total} onPage={setPage} /></div>}
      {open && (
        <ConfirmDialog open onOpenChange={(o) => !o && setOpen(null)} title={`${open.level.toLowerCase()} · ${open.category.toLowerCase()} · ${open.source}`}
          confirmLabel={canManage && !open.resolved_at ? 'Mark resolved' : 'Close'}
          onConfirm={async () => { if (canManage && !open.resolved_at) await resolve.mutateAsync([open.id]) }}>
          <div className="min-w-0 space-y-2 text-sm">
            <p className="break-words">{open.message}</p>
            <p className="text-xs text-muted-foreground">First {formatDateTime(open.first_seen_at)} · last {formatDateTime(open.last_seen_at)} · {formatNumber(open.occurrences)} time(s)
              {open.resolved_at && ` · resolved ${formatDateTime(open.resolved_at)}`}</p>
            {Object.keys(open.context ?? {}).length > 0 && (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(open.context, null, 2)}</pre>
            )}
          </div>
        </ConfirmDialog>
      )}
    </Card>
  )
}

export default function SystemHealthPage() {
  const [state, update] = useUrlState({ tab: 'status' })
  const [retry, setRetry] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['platform-health', 'status'], queryFn: platformHealth, refetchInterval: 60_000 })
  const d = q.data
  const counts = d ? (['down', 'warn', 'ok'] as const).map((s) => d.components.filter((c) => c.status === s).length) : [0, 0, 0]
  const cron = d?.components.find((c) => c.key === 'cron')
  const groups = d ? [...new Set(d.components.map((c) => c.group))] : []
  return (
    <div className="space-y-4">
      <PageHeader title="System Health" description="Each part of the platform with how it was checked. Anything with nothing to measure says so instead of showing as healthy."
        actions={<Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? <Spinner /> : <RefreshCw />} Refresh</Button>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <CardsSkeleton count={4} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Down" value={counts[0]} tone={counts[0] ? 'negative' : 'default'} icon={<Gauge />} hint={`checked ${timeAgo(d.checked_at)}`} />
            <StatCard label="Degraded" value={counts[1]} tone={counts[1] ? 'warning' : 'default'} />
            <StatCard label="Healthy" value={counts[2]} tone="positive" hint={`of ${d.components.length} parts`} />
            <StatCard label="Open incidents" value={d.incidents.open} tone={d.incidents.critical ? 'negative' : d.incidents.open ? 'warning' : 'default'} icon={<Siren />}
              hint={d.incidents.critical ? `${d.incidents.critical} critical` : 'none critical'} to="/super-admin/incidents" />
          </div>
          <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
            <TabsList>
              <TabsTrigger value="status">Status</TabsTrigger>
              <TabsTrigger value="jobs">Scheduled tasks</TabsTrigger>
              <TabsTrigger value="logs">System log</TabsTrigger>
            </TabsList>
            <TabsContent value="status" className="mt-3 space-y-4">
              <LiveChecks />
              {groups.map((g) => (
                <section key={g} className="space-y-2">
                  <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{g}</h2>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {d.components.filter((c) => c.group === g).map((c) => <ComponentCard key={c.key} c={c} canRetry={d.can.manage} onRetry={setRetry} />)}
                  </div>
                </section>
              ))}
            </TabsContent>
            <TabsContent value="jobs" className="mt-3">
              <Card className="gap-0 overflow-hidden py-0">
                {!cron?.jobs?.length ? <EmptyState title="No scheduled task history" description={cron?.detail} /> : (
                  <div className="overflow-x-auto"><Table>
                    <TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Schedule</TableHead><TableHead>Latest run</TableHead><TableHead className="text-right">Runs in 24 h</TableHead><TableHead className="text-right">Failed</TableHead><TableHead>Message</TableHead></TableRow></TableHeader>
                    <TableBody>{cron.jobs.map((j) => (
                      <TableRow key={j.name}>
                        <TableCell className="text-sm font-medium">{j.name}{!j.active && <Badge variant="neutral" className="ml-2">paused</Badge>}</TableCell>
                        <TableCell className="font-mono text-xs">{j.schedule}</TableCell>
                        <TableCell className="text-xs">{j.last_status ? <><Badge variant={j.last_status === 'succeeded' ? 'success' : j.last_status === 'failed' ? 'danger' : 'neutral'}>{j.last_status}</Badge> {j.last_end && timeAgo(j.last_end)}</> : 'never ran'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{formatNumber(j.runs_24h)}</TableCell>
                        <TableCell className={cn('text-right text-xs tabular-nums', j.failed_24h > 0 && 'text-red-500')}>{formatNumber(j.failed_24h)}</TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={j.last_message ?? undefined}>{j.last_message ?? ''}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table></div>
                )}
              </Card>
            </TabsContent>
            <TabsContent value="logs" className="mt-3"><LogBrowser canManage={d.can.manage} /></TabsContent>
          </Tabs>
        </>
      )}
      {retry && <RetryDialog kind={retry} onClose={() => setRetry(null)} />}
    </div>
  )
}

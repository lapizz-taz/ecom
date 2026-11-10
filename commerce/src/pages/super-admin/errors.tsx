import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bug, CheckCheck, ClipboardCopy, EyeOff, History, Lightbulb, RefreshCw, RotateCcw, Search, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { Sparkline } from '@/components/common/sparkline'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, LoadingState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { codePointer, errorHints } from '@/features/platform/errors/hints'
import { claudeReport, stepLine } from '@/features/platform/errors/report'
import { useUrlState } from '@/hooks/use-url-state'
import { APP_RELEASE } from '@/lib/env'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type ErrorDetail, type ErrorSample, type ErrorStatus, type ErrorView, getError, listErrors, type TrackedError, updateErrors } from '@/services/platform-ops'

const STATUS: Record<ErrorStatus, { label: string; variant: BadgeVariant }> = {
  NEW: { label: 'New', variant: 'danger' },
  INVESTIGATING: { label: 'Investigating', variant: 'warning' },
  FIXED: { label: 'Fixed', variant: 'success' },
  IGNORED: { label: 'Ignored', variant: 'neutral' },
}
const VIEWS: Array<{ value: ErrorView; label: string }> = [
  { value: 'open', label: 'Open' }, { value: 'new', label: 'New' }, { value: 'investigating', label: 'Investigating' },
  { value: 'came_back', label: 'Came back' }, { value: 'fixed', label: 'Fixed' }, { value: 'ignored', label: 'Ignored' }, { value: 'all', label: 'All' },
]
const CATEGORIES = ['FRONTEND', 'FUNCTION', 'WEBHOOK', 'COURIER', 'PAYMENT', 'JOB', 'SMS', 'META', 'AUTH', 'FRAUD', 'OTHER']
const CATEGORY_LABEL: Record<string, string> = {
  FRONTEND: 'Admin & panel screens', FUNCTION: 'Server functions', WEBHOOK: 'Webhooks', COURIER: 'Couriers', PAYMENT: 'Payments',
  JOB: 'Scheduled tasks', SMS: 'SMS', META: 'Meta', AUTH: 'Sign-in', FRAUD: 'Fraud checks', OTHER: 'Other',
}
const PAGE = 50
const release = APP_RELEASE === 'dev' ? undefined : APP_RELEASE

const StatusBadge = ({ status, back }: { status: ErrorStatus; back?: boolean }) => (
  <span className="inline-flex items-center gap-1">
    <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
    {back && (status === 'NEW' || status === 'INVESTIGATING') && <Badge variant="violet"><RotateCcw className="size-3" /> came back</Badge>}
  </span>
)

const where = (r: { merchant: TrackedError['merchant']; businesses: number; platform: boolean }) =>
  r.businesses > 1 ? `${r.businesses} businesses${r.platform ? ' + platform' : ''}` : r.merchant ? `#${r.merchant.number} ${r.merchant.name}` : 'Platform'

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied. Paste it to Claude in a session on the repository.')
  } catch {
    toast.warning('Your browser did not allow copying. Select the text in the box and copy it.')
  }
}

// ------------------------------------------------------------------ one error

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="truncate tabular-nums" title={typeof v === 'string' ? v : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Occurrences per day, last 30 days: bars to scale, zero days as a thin line. */
function DailyBars({ daily }: { daily: ErrorDetail['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.n))
  return (
    <div>
      <div className="flex h-16 items-end gap-px" role="img" aria-label={`Occurrences per day, last 30 days: ${daily.map((d) => d.n).join(', ')}`}>
        {daily.map((d) => (
          <div key={d.day} title={`${d.day}: ${d.n}`} className={cn('min-w-0 flex-1 rounded-t-sm', d.n ? 'bg-red-500/70' : 'bg-border')}
            style={{ height: d.n ? `${Math.max(6, (d.n / max) * 100)}%` : '2px' }} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums"><span>{daily[0]?.day}</span><span>max {max}/day</span><span>today</span></div>
    </div>
  )
}

function Steps({ context }: { context: Record<string, unknown> }) {
  const trail = Array.isArray(context.trail) ? (context.trail as Array<Record<string, unknown>>) : []
  if (!trail.length) return <p className="text-xs text-muted-foreground">No steps recorded (server errors have none; the browser side may be under “Same request”).</p>
  return (
    <ol className="space-y-0.5 rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {trail.map((s, i) => (
        <li key={i} className={cn('break-words', (s.t === 'error' || s.t === 'toast' || (s.t === 'call' && (s.status === 'failed' || Number(s.status) >= 400))) && 'text-red-600 dark:text-red-400')}>
          {stepLine(s)}
        </li>
      ))}
    </ol>
  )
}

function Occurrence({ s }: { s: ErrorSample }) {
  const c = s.context
  const { trail: _trail, stack, ...other } = c as Record<string, unknown> & { stack?: string }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {formatDateTime(s.at)} · {s.merchant ? <Link className="hover:underline" to={`/super-admin/merchants/${s.merchant.id}`}>#{s.merchant.number} {s.merchant.name}</Link> : 'platform'}
        {s.user && ` · ${s.user.name ?? 'staff member'}`}{typeof c.path === 'string' && ` · ${c.path}`}{s.release && ` · version ${s.release}`}
        {s.old_version && ' · from a tab older than the fix'}
      </p>
      <Steps context={c} />
      {typeof stack === 'string' && stack && <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">{stack}</pre>}
      {Object.keys(other).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(other, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

function ErrorSheet({ id, onClose, onOpen }: { id: number | null; onClose: () => void; onOpen: (id: number) => void }) {
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['platform-errors', 'one', id], queryFn: () => getError(id!), enabled: id != null })
  const d = q.data
  const [note, setNote] = useState('')
  const [fixedIn, setFixedIn] = useState('')
  const [sample, setSample] = useState(0)
  const [showReport, setShowReport] = useState(false)
  useEffect(() => { setNote(d?.error.note ?? ''); setFixedIn(d?.error.fixed_in ?? ''); setSample(0); setShowReport(false) }, [d?.error.id, d?.error.note, d?.error.fixed_in])
  const ids = d ? (d.error.fingerprint ? d.siblings.map((s) => s.id) : [d.error.id]) : []
  const save = useMutation({
    mutationFn: (p: { status?: ErrorStatus; note?: string; fixed_in?: string }) => updateErrors(ids, { ...p, release }),
    onSuccess: (_n, p) => {
      toast.success(p.status ? `Marked ${STATUS[p.status].label.toLowerCase()}` : 'Saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-errors'] })
    },
  })
  const e = d?.error
  const hints = e ? errorHints(e) : []
  const s = d?.samples[sample]
  const open = e && (e.status === 'NEW' || e.status === 'INVESTIGATING')
  const pointer = e ? codePointer(e, typeof d?.samples[0]?.context.path === 'string' ? String(d.samples[0].context.path) : undefined) : null
  const total = d ? d.siblings.reduce((n, x) => n + x.occurrences, 0) : 0
  const changed = e && (note.trim() !== (e.note ?? '') || fixedIn.trim() !== (e.fixed_in ?? ''))
  return (
    <Sheet open={id != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d || !e ? <LoadingState /> : (
          <div className="space-y-5 px-4 pb-8 sm:px-5">
            <SheetHeader className="px-0">
              <SheetDescription className="flex flex-wrap items-center gap-1.5 text-xs">
                <StatusBadge status={e.status} back={!!e.regressed_at} />
                <span>#{e.id} · {CATEGORY_LABEL[e.category] ?? e.category} · {e.source} · {e.level.toLowerCase()}</span>
              </SheetDescription>
              <SheetTitle className="text-base leading-snug break-words">{e.message}</SheetTitle>
            </SheetHeader>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { void copy(claudeReport(d)); setShowReport(true) }}><ClipboardCopy /> Copy for Claude</Button>
              {d.can.manage && open && e.status !== 'INVESTIGATING' && (
                <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ status: 'INVESTIGATING' })}><Search /> Investigating</Button>
              )}
              {d.can.manage && e.status !== 'FIXED' && (
                <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ status: 'FIXED', note: note.trim(), fixed_in: fixedIn.trim() })}><CheckCheck /> Mark fixed</Button>
              )}
              {d.can.manage && e.status !== 'IGNORED' && (
                <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ status: 'IGNORED' })}><EyeOff /> Ignore</Button>
              )}
              {d.can.manage && !open && (
                <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ status: 'NEW' })}><Undo2 /> Reopen</Button>
              )}
            </div>
            {showReport && (
              <Textarea readOnly value={claudeReport(d)} className="h-40 font-mono text-[11px]" onFocus={(ev) => ev.currentTarget.select()} aria-label="Report for Claude" />
            )}

            {hints.length > 0 && (
              <section className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-medium"><Lightbulb className="size-4 text-amber-600" /> Likely cause <span className="text-xs font-normal text-muted-foreground">(automatic first guess)</span></h3>
                {hints.map((h) => (
                  <div key={h.title} className="text-sm">
                    <p className="font-medium">{h.title}</p>
                    <p className="text-muted-foreground">{h.cause}</p>
                    <p><span className="text-muted-foreground">To fix: </span>{h.fix}</p>
                  </div>
                ))}
                {pointer && <p className="text-xs text-muted-foreground">Start in <code className="rounded bg-muted px-1">{pointer}</code></p>}
              </section>
            )}

            <Facts items={[
              ['Times', formatNumber(total || e.occurrences)],
              ['First seen', timeAgo(e.first_seen_at)],
              ['Last seen', timeAgo(e.last_seen_at)],
              ['Where', d.siblings.length > 1 ? `${d.siblings.length} places` : e.merchant ? `#${e.merchant.number} ${e.merchant.name}` : 'Platform'],
              ['App version', e.last_release ?? 'server'],
              ['Came back', e.regressions ? `${e.regressions}× · ${timeAgo(e.regressed_at)}` : 'no'],
              ...(e.old_version_hits ? [['Old tabs since fix', formatNumber(e.old_version_hits)] as [string, ReactNode]] : []),
              ...(e.status_changed_at ? [['Status set', `${timeAgo(e.status_changed_at)}${e.status_by_email ? ` by ${e.status_by_email}` : ''}`] as [string, ReactNode]] : []),
            ]} />

            <DailyBars daily={d.daily} />

            {d.can.manage ? (
              <section className="grid gap-2">
                <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} placeholder="Note: what you found, what was done…" aria-label="Note" className="min-h-16 text-sm" />
                <div className="flex flex-wrap gap-2">
                  <Input value={fixedIn} onChange={(ev) => setFixedIn(ev.target.value)} maxLength={120} placeholder="Fixed in (commit, date…)" aria-label="Fixed in" className="min-w-0 flex-1 basis-48" />
                  <Button size="sm" variant="outline" disabled={!changed || save.isPending} onClick={() => save.mutate({ note: note.trim(), fixed_in: fixedIn.trim() })}>
                    {save.isPending ? <Spinner /> : null} Save note
                  </Button>
                </div>
              </section>
            ) : (e.note || e.fixed_in) && <p className="text-sm whitespace-pre-wrap">{e.note}{e.fixed_in && <span className="block text-xs text-muted-foreground">Fixed in {e.fixed_in}</span>}</p>}

            {d.linked.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">Same request, other side</h3>
                <p className="text-xs text-muted-foreground">The server’s error behind this browser error, or the browser’s side of this server error.</p>
                {d.linked.map((l) => (
                  <button key={l.id} type="button" onClick={() => onOpen(l.id)} className="block w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50">
                    <span className="line-clamp-2 break-words">{l.message}</span>
                    <span className="text-xs text-muted-foreground">#{l.id} · {CATEGORY_LABEL[l.category] ?? l.category} · {l.source} · request {l.request_id}</span>
                  </button>
                ))}
              </section>
            )}

            {d.samples.length > 0 && s && (
              <section className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{sample === 0 ? 'Newest occurrence' : `Occurrence ${sample + 1} of the last ${d.samples.length}`}</h3>
                  {d.samples.length > 1 && (
                    <Select value={String(sample)} onValueChange={(v) => setSample(Number(v))}>
                      <SelectTrigger size="sm" className="w-48" aria-label="Occurrence"><SelectValue /></SelectTrigger>
                      <SelectContent>{d.samples.map((x, i) => <SelectItem key={x.id} value={String(i)}>{formatDateTime(x.at)}{x.merchant ? ` · #${x.merchant.number}` : ''}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
                {s.message !== e.message && <p className="text-sm break-words">{s.message}</p>}
                <Occurrence s={s} />
              </section>
            )}

            {d.nearby.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">Same person, within 2 minutes</h3>
                {d.nearby.map((n) => (
                  <button key={n.id} type="button" onClick={() => onOpen(n.id)} className="block w-full rounded-md border p-2 text-left text-sm hover:bg-muted/50">
                    <span className="line-clamp-2 break-words">{n.message}</span>
                    <span className="text-xs text-muted-foreground">#{n.id} · {n.seconds_apart} s {n.before ? 'before' : 'after'} · {STATUS[n.status].label.toLowerCase()}</span>
                  </button>
                ))}
              </section>
            )}

            {d.siblings.length > 1 && (
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">In {d.siblings.length} places</h3>
                <ul className="divide-y rounded-md border text-sm">
                  {d.siblings.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
                      <span className="min-w-0 truncate">{x.merchant ? <Link className="hover:underline" to={`/super-admin/merchants/${x.merchant.id}`}>#{x.merchant.number} {x.merchant.name}</Link> : 'Platform'}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"><StatusBadge status={x.status} back={!!x.regressed_at} /> {formatNumber(x.occurrences)}× · {timeAgo(x.last_seen_at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.history.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="flex items-center gap-1.5 text-sm font-medium"><History className="size-4" /> Changes</h3>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {d.history.map((h, i) => (
                    <li key={i}>{formatDateTime(h.at)} · {h.by ?? 'someone'}: {String(h.before?.status ?? '')} → {String(h.after?.status ?? '')}{h.after?.fixed_in ? ` · fixed in ${String(h.after.fixed_in)}` : ''}{h.note ? ` · “${h.note}”` : ''}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ------------------------------------------------------------------ the list

function ErrorRow({ r, selected, canManage, onSelect, onOpen }: { r: TrackedError; selected: boolean; canManage: boolean; onSelect: (v: boolean) => void; onOpen: () => void }) {
  return (
    <div className="flex items-start gap-3 px-3 py-3 hover:bg-muted/40">
      {canManage && <Checkbox className="mt-1" aria-label={`Select error ${r.id}`} checked={selected} onCheckedChange={(v) => onSelect(Boolean(v))} />}
      <button type="button" onClick={onOpen} className="grid min-w-0 flex-1 gap-1 text-left sm:grid-cols-[minmax(0,1fr)_7rem_6rem] sm:items-center sm:gap-4">
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <StatusBadge status={r.status} back={!!r.regressed_at} />
            {r.level !== 'ERROR' && <Badge variant="outline">{r.level.toLowerCase()}</Badge>}
            <span>{CATEGORY_LABEL[r.category] ?? r.category} · {r.source}</span>
          </span>
          <span className="line-clamp-2 text-sm font-medium break-words">{r.message}</span>
          <span className="block text-xs text-muted-foreground">{where(r)} · first {timeAgo(r.first_seen_at)}{r.note ? ` · note: ${r.note.slice(0, 60)}` : ''}</span>
        </span>
        <span className="hidden sm:block"><Sparkline values={r.trend} tone={r.status === 'FIXED' || r.status === 'IGNORED' ? 'muted' : 'negative'} /></span>
        <span className="flex items-baseline gap-2 text-xs text-muted-foreground tabular-nums sm:flex-col sm:items-end sm:gap-0">
          <span className="text-sm font-semibold text-foreground">{formatNumber(r.occurrences)}×</span>
          <span>{timeAgo(r.last_seen_at)}</span>
        </span>
      </button>
    </div>
  )
}

export default function ErrorTrackerPage() {
  const queryClient = useQueryClient()
  const [s, update] = useUrlState({ view: 'open', category: 'all', level: 'all', period: 'all', sort: 'recent', q: '', id: '' })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number[][]>([])
  const filters = {
    status: s.view, category: s.category === 'all' ? '' : s.category, level: s.level === 'all' ? '' : s.level,
    period: s.period === 'all' ? '' : s.period, sort: s.sort, q: s.q,
  }
  const q = useQuery({ queryKey: ['platform-errors', 'list', filters, page], queryFn: () => listErrors(filters, PAGE, (page - 1) * PAGE), placeholderData: keepPreviousData, refetchInterval: 60_000 })
  const bulk = useMutation({
    mutationFn: (status: ErrorStatus) => updateErrors(selected.flat(), { status, release }),
    onSuccess: (n, status) => { toast.success(`${n} marked ${STATUS[status].label.toLowerCase()}`); setSelected([]); void queryClient.invalidateQueries({ queryKey: ['platform-errors'] }) },
  })
  const set = (patch: Partial<typeof s>) => { update({ ...patch, id: patch.id ?? '' }); setPage(1); setSelected([]) }
  const d = q.data
  const rows = d?.rows ?? []
  const isSelected = (r: TrackedError) => selected.some((g) => g[0] === r.ids[0])
  return (
    <div className="space-y-4">
      <PageHeader title="Error tracker" icon={<Bug />}
        description="Every error from the admin, this panel, server functions, webhooks and scheduled tasks. Open one for its likely cause, the steps the person took before it, and a full report to paste to Claude."
        actions={<Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? <Spinner /> : <RefreshCw />} Refresh</Button>} />
      {!d && !q.error ? <CardsSkeleton count={4} /> : d && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Open" value={formatNumber(d.stats.open)} tone={d.stats.open ? 'negative' : 'positive'} onClick={() => set({ view: 'open' })} hint={`${formatNumber(d.stats.businesses)} ${d.stats.businesses === 1 ? 'business' : 'businesses'}`} />
          <StatCard label="New in 24 h" value={formatNumber(d.stats.new_24h)} tone={d.stats.new_24h ? 'warning' : 'default'} onClick={() => set({ view: 'new', period: '24h' })} />
          <StatCard label="Came back" value={formatNumber(d.stats.came_back)} tone={d.stats.came_back ? 'negative' : 'default'} onClick={() => set({ view: 'came_back' })} hint="fixed, then again" />
          <StatCard label="Investigating" value={formatNumber(d.stats.investigating)} onClick={() => set({ view: 'investigating' })} />
          <StatCard label="Fixed in 7 days" value={formatNumber(d.stats.fixed_7d)} tone="positive" onClick={() => set({ view: 'fixed', period: '7d' })} />
          <StatCard label="Occurrences today" value={formatNumber(d.stats.today)} hint="Bangladesh time" />
        </div>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex gap-1 overflow-x-auto border-b px-2 pt-2" role="tablist" aria-label="Status">
          {VIEWS.map((v) => (
            <button key={v.value} type="button" role="tab" aria-selected={s.view === v.value} onClick={() => set({ view: v.value })}
              className={cn('shrink-0 rounded-t-md border-b-2 px-3 py-1.5 text-sm', s.view === v.value ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SearchInput value={s.q} onChange={(v) => set({ q: v })} placeholder="Search message, source or #id" className="w-full sm:w-64" />
          <Select value={s.category} onValueChange={(category) => set({ category })}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Where"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Everywhere</SelectItem>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}{d?.by_category[c] ? ` (${d.by_category[c]})` : ''}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={s.period} onValueChange={(period) => set({ period })}>
            <SelectTrigger className="w-[calc(50%-0.25rem)] sm:w-36" aria-label="Last seen"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem><SelectItem value="24h">Last 24 hours</SelectItem><SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem><SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Select value={s.sort} onValueChange={(sort) => set({ sort })}>
            <SelectTrigger className="w-[calc(50%-0.25rem)] sm:w-40" aria-label="Order"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Latest first</SelectItem><SelectItem value="frequent">Most frequent</SelectItem>
              <SelectItem value="businesses">Most businesses</SelectItem><SelectItem value="newest">Newest errors</SelectItem>
            </SelectContent>
          </Select>
          <Select value={s.level} onValueChange={(level) => set({ level })}>
            <SelectTrigger className="w-full sm:w-32" aria-label="Level"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All levels</SelectItem><SelectItem value="ERROR">Errors</SelectItem><SelectItem value="WARN">Warnings</SelectItem><SelectItem value="INFO">Info</SelectItem></SelectContent>
          </Select>
        </div>
        {d?.can.manage && selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
            <span className="mr-auto">{selected.length} selected</span>
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate('INVESTIGATING')}><Search /> Investigating</Button>
            <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate('FIXED')}><CheckCheck /> Mark fixed</Button>
            <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={() => bulk.mutate('IGNORED')}><EyeOff /> Ignore</Button>
          </div>
        )}
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <TableSkeleton rows={6} cols={4} /> : rows.length === 0 ? (
          <EmptyState icon={<Bug />} title={s.view === 'open' && !s.q ? 'No open errors' : 'Nothing matches'}
            description={s.view === 'open' && !s.q ? 'Everything reported has been fixed or ignored. New errors show here within seconds.' : 'Try another status, period or search.'} />
        ) : (
          <div className="divide-y">
            {d.can.manage && (
              <div className="flex items-center gap-3 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                <Checkbox aria-label="Select all on this page" checked={rows.every(isSelected)} onCheckedChange={(v) => setSelected(v ? rows.map((r) => r.ids) : [])} />
                <span>{formatNumber(d.total)} error{d.total === 1 ? '' : 's'}</span>
              </div>
            )}
            {rows.map((r) => (
              <ErrorRow key={r.ids[0]} r={r} canManage={d.can.manage} selected={isSelected(r)} onOpen={() => update({ id: String(r.id) })}
                onSelect={(v) => setSelected(v ? [...selected, r.ids] : selected.filter((g) => g[0] !== r.ids[0]))} />
            ))}
          </div>
        )}
        {d && d.total > PAGE && <div className="border-t p-2"><Pagination page={page} pageSize={PAGE} total={d.total} onPage={setPage} /></div>}
      </Card>
      <ErrorSheet id={s.id ? Number(s.id) : null} onClose={() => update({ id: '' })} onOpen={(id) => update({ id: String(id) })} />
    </div>
  )
}

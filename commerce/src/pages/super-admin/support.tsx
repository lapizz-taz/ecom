import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { ErrorState, LoadingState, TableSkeleton } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePlatform } from '@/features/platform/platform-context'
import { StartSessionDialog } from '@/features/platform/support/start-session-dialog'
import { NewTicketDialog, SessionsTable, TicketSheet, TicketsTable } from '@/features/platform/support/ticket-parts'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  listSupportSessions, listTickets, saveSupportSettings, type SupportSettings, TICKET_PRIORITY, type TicketPriority, type TicketView,
} from '@/services/support-center'

const PAGE = 50
const VIEWS: Array<{ key: TicketView; label: string; count?: keyof Awaited<ReturnType<typeof listTickets>>['summary'] }> = [
  { key: 'active', label: 'Open', count: 'active' },
  { key: 'mine', label: 'Mine', count: 'mine' },
  { key: 'unassigned', label: 'Unassigned', count: 'unassigned' },
  { key: 'overdue', label: 'Overdue', count: 'overdue' },
  { key: 'waiting', label: 'Waiting on us', count: 'waiting' },
  { key: 'escalated', label: 'Escalated', count: 'escalated' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
]
const PRIORITIES = Object.keys(TICKET_PRIORITY) as TicketPriority[]

function Tickets() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ view: 'active', q: '', priority: '', page: '1', ticket: '' })
  const [creating, setCreating] = useState(false)
  const page = Number(state.page) || 1
  const q = useQuery({
    queryKey: ['platform-tickets', state.view, state.q, state.priority, page], placeholderData: keepPreviousData,
    queryFn: () => listTickets({ view: state.view as TicketView, q: state.q, priority: state.priority }, PAGE, (page - 1) * PAGE),
    refetchInterval: 60_000,
  })
  const s = q.data?.summary
  const onTime = s && s.resolved_30d > 0 ? Math.round((s.resolved_on_time_30d / s.resolved_30d) * 100) : null
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Open" value={s ? formatNumber(s.active) : '…'} />
        <StatCard label="Overdue" value={s ? formatNumber(s.overdue) : '…'} tone={s && s.overdue > 0 ? 'negative' : 'default'} />
        <StatCard label="Unassigned" value={s ? formatNumber(s.unassigned) : '…'} tone={s && s.unassigned > 0 ? 'warning' : 'default'} />
        <StatCard label="Waiting on us" value={s ? formatNumber(s.waiting) : '…'} hint="Merchant wrote last" />
        <StatCard label="First reply (30 days)" value={s?.avg_first_response_hours_30d != null ? `${s.avg_first_response_hours_30d} h` : '—'} hint="Average" />
        <StatCard label="Resolved on time (30 days)" value={onTime != null ? `${onTime}%` : '—'} hint={s ? `${s.resolved_on_time_30d} of ${s.resolved_30d}` : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border p-1">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" onClick={() => update({ view: v.key, page: '1' })}
              className={cn('rounded-md px-2.5 py-1 text-xs', state.view === v.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {v.label}{v.count && s ? ` ${s[v.count]}` : ''}
            </button>
          ))}
        </div>
        <SearchInput value={state.q} onChange={(v) => update({ q: v, page: '1' })} placeholder="Title, #number or merchant" />
        <Select value={state.priority || 'all'} onValueChange={(v) => update({ priority: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any priority</SelectItem>
            {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{TICKET_PRIORITY[p].label}</SelectItem>)}
          </SelectContent>
        </Select>
        {can('support', 'create') && <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}><Plus /> New ticket</Button>}
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton /> : (
          <div className={cn(q.isFetching && 'opacity-70')}><TicketsTable rows={q.data.rows} onOpen={(id) => update({ ticket: id }, { resetPage: false })} /></div>
        )}
        {q.data && q.data.total > PAGE && <div className="border-t px-3 py-2"><Pagination page={page} pageSize={PAGE} total={q.data.total} onPage={(p) => update({ page: String(p) })} /></div>}
      </Card>
      <TicketSheet id={state.ticket || null} onClose={() => update({ ticket: '' }, { resetPage: false })} />
      {creating && <NewTicketDialog onClose={() => setCreating(false)}
        onCreated={(id) => { void queryClient.invalidateQueries({ queryKey: ['platform-tickets'] }); update({ ticket: id }) }} />}
    </div>
  )
}

function Sessions() {
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [active, setActive] = useState(false)
  const q = useQuery({ queryKey: ['platform-support-sessions', active], queryFn: () => listSupportSessions({ active }) })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-support-sessions'] })
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <Eye className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Customer view</p>
            <p className="text-xs text-muted-foreground">See a merchant's screens exactly as their staff do, read-only and for a limited time. Every session is logged with its reason and shown to the merchant.
              {q.data && ` Sessions last up to ${q.data.settings.max_minutes} minutes.`}</p>
          </div>
          {q.data?.mine && <Button variant="outline" onClick={() => window.location.assign('/admin')}>Back to #{q.data.mine.merchant.number} {q.data.mine.merchant.name}</Button>}
          {q.data?.can.start && <Button onClick={() => setStarting(true)}><Eye /> View a merchant</Button>}
        </CardContent>
      </Card>
      <div className="flex items-center gap-2 text-sm">
        <button type="button" className={cn('rounded-md px-2.5 py-1 text-xs', !active ? 'bg-muted font-medium' : 'text-muted-foreground')} onClick={() => setActive(false)}>All recent</button>
        <button type="button" className={cn('rounded-md px-2.5 py-1 text-xs', active ? 'bg-muted font-medium' : 'text-muted-foreground')} onClick={() => setActive(true)}>Active now</button>
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton /> : (
          <SessionsTable rows={q.data.rows} canManage={q.data.can.manage} onChanged={refresh} />
        )}
      </Card>
      {starting && <StartSessionDialog onClose={() => setStarting(false)} />}
    </div>
  )
}

function SupportSettingsCard({ settings }: { settings: SupportSettings }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(settings)
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => saveSupportSettings(form, reason.trim() || undefined),
    onSuccess: (s) => { setForm(s); setReason(''); toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['platform-tickets'] }) },
  })
  const hours = (k: 'sla_hours' | 'response_hours', p: TicketPriority) => (
    <Input type="number" min={0.25} step={0.25} aria-label={`${k === 'sla_hours' ? 'Resolve' : 'First reply'} within (${p})`} value={form[k][p]}
      onChange={(e) => setForm((f) => ({ ...f, [k]: { ...f[k], [p]: Number(e.target.value) } }))} />
  )
  return (
    <Card className="max-w-3xl">
      <CardHeader><CardTitle className="text-sm">Response targets and customer view</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Priority</th><th className="pb-2 font-medium">First reply within (hours)</th><th className="pb-2 font-medium">Resolve within (hours)</th></tr></thead>
          <tbody>
            {PRIORITIES.slice().reverse().map((p) => (
              <tr key={p}><td className="py-1 pr-3">{TICKET_PRIORITY[p].label}</td><td className="py-1 pr-3">{hours('response_hours', p)}</td><td className="py-1">{hours('sla_hours', p)}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">Due times are counted from when the ticket was opened, around the clock. Changing them applies to new tickets and to tickets whose priority changes.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customer view: default minutes"><Input type="number" min={5} max={form.session_max_minutes} value={form.session_default_minutes}
            onChange={(e) => setForm((f) => ({ ...f, session_default_minutes: Number(e.target.value) }))} /></Field>
          <Field label="Customer view: longest minutes" hint="At most 240"><Input type="number" min={5} max={240} value={form.session_max_minutes}
            onChange={(e) => setForm((f) => ({ ...f, session_max_minutes: Number(e.target.value) }))} /></Field>
          <Field label="Team name merchants see"><Input value={form.team_name} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, team_name: e.target.value }))} /></Field>
        </div>
        <Field label="Reason for the change (kept in the history)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {save.error && <p className="text-sm text-red-500" role="alert">{save.error.message}</p>}
        <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </CardContent>
    </Card>
  )
}

export default function SupportPage() {
  const { can } = usePlatform()
  const [state, update] = useUrlState({ tab: 'tickets' })
  const settings = useQuery({ queryKey: ['platform-tickets', 'settings'], enabled: state.tab === 'settings', queryFn: () => listTickets({ view: 'active' }, 1) })
  return (
    <div className="space-y-4">
      <PageHeader title="Support & Issues" description="Merchants' bug reports and the team's own tickets, with due times, owners, escalation and a read-only customer view." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="sessions">Customer view</TabsTrigger>
          {can('support', 'manage') && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="tickets"><Tickets /></TabsContent>
        <TabsContent value="sessions"><Sessions /></TabsContent>
        <TabsContent value="settings">
          {settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : !settings.data ? <LoadingState /> : <SupportSettingsCard settings={settings.data.settings} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Plus, Siren } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AnnouncementComposer, type ComposerDraft } from '@/features/platform/ops/announcement-composer'
import { usePlatform } from '@/features/platform/platform-context'
import { MerchantMultiPicker } from '@/features/platform/services/merchant-picker'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { MerchantRef } from '@/services/platform'
import {
  createIncident, getIncident, type Incident, INCIDENT_INTEGRATIONS, type IncidentDetail, type IncidentList, type IncidentSeverity, type IncidentStatus,
  listIncidents, noteIncident, UNAVAILABLE_CAPABLE, updateIncident,
} from '@/services/platform-ops'

export const SEVERITY: Record<IncidentSeverity, { label: string; variant: BadgeVariant }> = {
  CRITICAL: { label: 'Critical', variant: 'danger' }, HIGH: { label: 'High', variant: 'warning' },
  MEDIUM: { label: 'Medium', variant: 'info' }, LOW: { label: 'Low', variant: 'neutral' },
}
const STATUS: Record<IncidentStatus, { label: string; variant: BadgeVariant; hint: string }> = {
  INVESTIGATING: { label: 'Investigating', variant: 'danger', hint: 'We know something is wrong and are looking' },
  IDENTIFIED: { label: 'Identified', variant: 'warning', hint: 'The cause is known; a fix is in progress' },
  MONITORING: { label: 'Monitoring', variant: 'info', hint: 'Fixed; watching that it stays fixed' },
  RESOLVED: { label: 'Resolved', variant: 'success', hint: 'Over' },
}
const integrationLabel = (v: string | null) => INCIDENT_INTEGRATIONS.find((i) => i.value === v)?.label ?? v ?? '—'
const duration = (minutes: number) => (minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 6) / 10} h` : `${Math.round(minutes / 1440)} days`)
const scopeText = (i: Incident) => (i.scope === 'ALL' ? 'All merchants' : i.scope === 'SELECTED' ? `${i.merchants?.length ?? 0} merchant(s)` : 'Not merchant-facing')

function NewIncidentDialog({ list, onClose }: { list: IncidentList; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [f, setF] = useState({ title: '', description: '', severity: 'HIGH' as IncidentSeverity, integration: 'none', scope: 'NONE' as Incident['scope'], assigned_to: 'none', mark_unavailable: false })
  const [merchants, setMerchants] = useState<MerchantRef[]>([])
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () => createIncident({ title: f.title.trim(), description: f.description.trim() || null, severity: f.severity,
      integration: f.integration === 'none' ? null : f.integration, scope: f.scope, merchants: f.scope === 'SELECTED' ? merchants.map((m) => m.id) : [],
      assigned_to: f.assigned_to === 'none' ? null : f.assigned_to, mark_unavailable: f.mark_unavailable }),
    onSuccess: (i) => { toast.success(`Incident #${i.number} opened`); void queryClient.invalidateQueries({ queryKey: ['platform-incidents'] }); onClose() },
  })
  const canUnavailable = list.can.manage && UNAVAILABLE_CAPABLE.includes(f.integration)
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Open an incident" submitLabel="Open incident" wide busy={create.isPending}
      disabled={f.title.trim().length < 3 || (f.scope === 'SELECTED' && merchants.length === 0)} onSubmit={() => create.mutate()}
      description="High and critical incidents alert everyone who works on incidents.">
      <Field label="What is wrong" required><Input value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Shopify orders are not importing" /></Field>
      <Field label="Details"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Severity">
          <Select value={f.severity} onValueChange={(v) => setF({ ...f, severity: v as IncidentSeverity })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(SEVERITY).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Integration affected">
          <Select value={f.integration} onValueChange={(v) => setF({ ...f, integration: v, mark_unavailable: f.mark_unavailable && UNAVAILABLE_CAPABLE.includes(v) })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">None in particular</SelectItem>{INCIDENT_INTEGRATIONS.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Owner">
          <Select value={f.assigned_to} onValueChange={(v) => setF({ ...f, assigned_to: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Nobody yet</SelectItem>{list.staff.map((s) => <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Merchants affected">
        <RadioGroup value={f.scope} onValueChange={(v) => setF({ ...f, scope: v as Incident['scope'] })} className="grid gap-1.5 sm:grid-cols-3">
          {([['NONE', 'Internal only'], ['ALL', 'All merchants'], ['SELECTED', 'Some merchants']] as const).map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><RadioGroupItem value={v} /> {l}</label>
          ))}
        </RadioGroup>
      </Field>
      {f.scope === 'SELECTED' && <MerchantMultiPicker value={merchants} onChange={setMerchants} />}
      {canUnavailable && (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <Checkbox checked={f.mark_unavailable} onCheckedChange={(v) => setF({ ...f, mark_unavailable: !!v })} className="mt-0.5" />
          <span>Show {integrationLabel(f.integration)} as <strong>temporarily unavailable</strong> to {f.scope === 'SELECTED' ? 'the chosen merchants' : 'every merchant'} until this is resolved.
            <span className="block text-xs text-muted-foreground">Merchants see a notice; nothing is blocked (orders keep importing when the connection recovers).</span></span>
        </label>
      )}
      {create.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{(create.error as Error).message}</p>}
    </FormDialog>
  )
}

function Timeline({ d }: { d: IncidentDetail }) {
  const text = (u: IncidentDetail['updates'][number]) => {
    const x = u.data as Record<string, string | boolean | number>
    switch (u.kind) {
      case 'CREATED': return `Opened (${String(x.severity ?? '').toLowerCase()}${x.source === 'AUTOMATION' ? ', by an automation rule' : ''})`
      case 'STATUS': return `${STATUS[x.from as IncidentStatus]?.label ?? x.from} → ${STATUS[x.to as IncidentStatus]?.label ?? x.to}`
      case 'SEVERITY': return `Severity ${String(x.from).toLowerCase()} → ${String(x.to).toLowerCase()}`
      case 'ASSIGNED': return x.to_email ? `Given to ${x.to_email}` : 'Owner removed'
      case 'MERCHANTS': return `Affected merchants changed (${x.count})`
      case 'UNAVAILABLE': return x.unavailable ? `${integrationLabel(String(x.integration))} shown as unavailable to merchants` : `${integrationLabel(String(x.integration))} no longer shown as unavailable`
      default: return 'Update'
    }
  }
  return (
    <ol className="relative space-y-3 border-l pl-4">
      {d.updates.map((u) => (
        <li key={u.id} className="space-y-0.5">
          <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full bg-muted-foreground/60" aria-hidden />
          <p className="text-xs text-muted-foreground">{formatDateTime(u.created_at)} · {u.actor ?? 'system'}</p>
          {u.kind !== 'NOTE' && <p className="text-sm font-medium">{text(u)}</p>}
          {u.body && <p className="text-sm whitespace-pre-wrap">{u.body}</p>}
        </li>
      ))}
    </ol>
  )
}

function IncidentSheet({ id, list, onClose, onAnnounce }: { id: string | null; list: IncidentList | undefined; onClose: () => void; onAnnounce: (d: IncidentDetail) => void }) {
  const queryClient = useQueryClient()
  const { can: platformCan } = usePlatform()
  const q = useQuery({ queryKey: ['platform-incidents', 'detail', id], queryFn: () => getIncident(id!), enabled: !!id })
  const [note, setNote] = useState('')
  const [resolution, setResolution] = useState('')
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform-incidents'] })
  const update = useMutation({ mutationFn: (p: Record<string, unknown>) => updateIncident(id!, p), onSuccess: () => { toast.success('Updated'); void refresh() } })
  const addNote = useMutation({ mutationFn: () => noteIncident(id!, note.trim()), onSuccess: () => { setNote(''); void refresh() } })
  const d = q.data
  const can = list?.can
  const open = d && d.status !== 'RESOLVED'
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState /> : (
          <div className="space-y-5 px-5 pb-6">
            <SheetHeader className="px-0">
              <SheetTitle className="flex flex-wrap items-center gap-2">#{d.number} {d.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-1.5">
                <Badge variant={SEVERITY[d.severity].variant}>{SEVERITY[d.severity].label}</Badge>
                <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                <span>{integrationLabel(d.integration)} · {scopeText(d)} · {d.status === 'RESOLVED' ? `lasted ${duration(d.minutes_open)}` : `open ${duration(d.minutes_open)}`}</span>
                {d.rule && <span>· opened by the rule <Link className="underline" to="/super-admin/automation">{d.rule.name}</Link></span>}
              </SheetDescription>
            </SheetHeader>
            {d.description && <p className="text-sm whitespace-pre-wrap">{d.description}</p>}
            {d.mark_unavailable && open && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">Merchants{d.scope === 'SELECTED' ? ' affected' : ''} see {integrationLabel(d.integration)} as temporarily unavailable.</p>
            )}
            {d.merchants && d.merchants.length > 0 && (
              <p className="text-xs text-muted-foreground">Affected: {d.merchants.map((m) => <Link key={m.id} className="mr-2 underline" to={`/super-admin/merchants/${m.id}`}>#{m.number} {m.name}</Link>)}</p>
            )}

            {can?.edit && (
              <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
                {open && (
                  <Field label="Status">
                    <Select value={d.status} onValueChange={(v) => v !== 'RESOLVED' && update.mutate({ status: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{(['INVESTIGATING', 'IDENTIFIED', 'MONITORING'] as const).map((s) => <SelectItem key={s} value={s}>{STATUS[s].label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                )}
                {open && (
                  <Field label="Severity">
                    <Select value={d.severity} onValueChange={(v) => update.mutate({ severity: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(SEVERITY).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                )}
                {open && (
                  <Field label="Owner">
                    <Select value={d.assigned?.user_id ?? 'none'} onValueChange={(v) => update.mutate({ assigned_to: v === 'none' ? null : v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="none">Nobody</SelectItem>{(list?.staff ?? []).map((s) => <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                )}
                {open && can.manage && d.integration && UNAVAILABLE_CAPABLE.includes(d.integration) && (
                  <label className="flex items-center gap-2 text-sm sm:col-span-3">
                    <Checkbox checked={d.mark_unavailable} disabled={update.isPending} onCheckedChange={(v) => update.mutate({ mark_unavailable: !!v })} />
                    Show {integrationLabel(d.integration)} as temporarily unavailable to {d.scope === 'SELECTED' ? 'the affected merchants' : 'all merchants'}
                  </label>
                )}
                {!open && <Button variant="outline" size="sm" className="w-fit" disabled={update.isPending} onClick={() => update.mutate({ status: 'INVESTIGATING', note: 'Reopened' })}>Reopen</Button>}
              </div>
            )}

            {platformCan('notifications', 'create') && (
              <Button size="sm" variant="outline" onClick={() => onAnnounce(d)}><Megaphone /> Tell affected merchants</Button>
            )}

            {can?.edit && (
              <div className="space-y-2">
                <Field label="Post an update"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed, what is next" /></Field>
                <Button size="sm" disabled={note.trim().length < 2 || addNote.isPending} onClick={() => addNote.mutate()}>{addNote.isPending && <Spinner />} Add update</Button>
              </div>
            )}
            {can?.edit && open && (
              <div className="space-y-2 rounded-md border border-emerald-500/30 p-3">
                <Field label="Resolve" hint="Write what fixed it. Merchants stop seeing the integration as unavailable."><Textarea rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
                <Button size="sm" variant="outline" disabled={resolution.trim().length < 5 || update.isPending}
                  onClick={() => update.mutate({ status: 'RESOLVED', resolution: resolution.trim() }, { onSuccess: () => setResolution('') })}>Mark resolved</Button>
              </div>
            )}
            {d.resolution && <div className="rounded-md bg-emerald-500/5 p-3 text-sm"><p className="text-xs font-medium text-emerald-600">Resolution</p><p className="whitespace-pre-wrap">{d.resolution}</p></div>}
            {update.error && <p className="text-sm text-red-500">{(update.error as Error).message}</p>}
            <div className="space-y-2"><h3 className="text-sm font-medium">Timeline</h3><Timeline d={d} /></div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default function IncidentsPage() {
  const [state, setState] = useUrlState({ view: 'open', incident: '' })
  const [creating, setCreating] = useState(false)
  const [announce, setAnnounce] = useState<ComposerDraft | null>(null)
  const q = useQuery({ queryKey: ['platform-incidents', state.view], queryFn: () => listIncidents(state.view as 'open' | 'resolved' | 'all'), refetchInterval: 60_000 })
  const d = q.data
  const draftFor = (i: IncidentDetail): ComposerDraft => ({
    kind: i.integration && i.integration !== 'platform' ? 'INTEGRATION' : 'MAINTENANCE', severity: i.severity === 'CRITICAL' ? 'CRITICAL' : 'WARN', incident_id: i.id,
    title: i.status === 'RESOLVED' ? `Resolved: ${i.title}` : i.title,
    body: i.status === 'RESOLVED' ? `This is fixed. ${i.resolution ?? ''}`.trim() : `${i.description ?? ''}\n\nWe are working on it and will update you here.`.trim(),
    audience: i.scope === 'SELECTED' ? { type: 'MERCHANTS' } : { type: 'ALL' }, merchants: i.scope === 'SELECTED' ? i.merchants ?? [] : [],
  })
  return (
    <div className="space-y-4">
      <PageHeader title="Incident Management" description="Outages and problems from report to resolution: severity, affected merchants, owner and a timeline that cannot be edited."
        actions={d?.can.create && <Button onClick={() => setCreating(true)}><Plus /> Open incident</Button>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          {d && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Open" value={formatNumber(d.summary.open)} icon={<Siren />} tone={d.summary.open ? 'warning' : 'default'} />
              <StatCard label="Critical open" value={formatNumber(d.summary.critical)} tone={d.summary.critical ? 'negative' : 'default'} />
              <StatCard label="Shown as unavailable" value={d.summary.unavailable.length ? d.summary.unavailable.map(integrationLabel).join(', ') : 'Nothing'} />
              <StatCard label="Resolved in 30 days" value={formatNumber(d.summary.resolved_30d)} hint={d.summary.avg_minutes_30d != null ? `average ${duration(d.summary.avg_minutes_30d)}` : undefined} />
            </div>
          )}
          <Tabs value={state.view} onValueChange={(view) => setState({ view })}>
            <TabsList><TabsTrigger value="open">Open</TabsTrigger><TabsTrigger value="resolved">Resolved</TabsTrigger><TabsTrigger value="all">All</TabsTrigger></TabsList>
          </Tabs>
          <Card className="gap-0 overflow-hidden py-0">
            {!d ? <TableSkeleton rows={4} cols={6} /> : d.rows.length === 0 ? (
              <EmptyState icon={<Siren />} title={state.view === 'open' ? 'No open incidents' : 'No incidents'} description={state.view === 'open' ? 'Everything reported has been resolved.' : undefined} />
            ) : (
              <div className="overflow-x-auto"><Table>
                <TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Severity</TableHead><TableHead>Status</TableHead><TableHead>Affects</TableHead><TableHead>Owner</TableHead><TableHead>Started</TableHead></TableRow></TableHeader>
                <TableBody>{d.rows.map((i) => (
                  <TableRow key={i.id} className="cursor-pointer" onClick={() => setState({ incident: i.id })}>
                    <TableCell className="max-w-sm"><p className="truncate text-sm font-medium">#{i.number} {i.title}</p>
                      <p className="text-xs text-muted-foreground">{integrationLabel(i.integration)}{i.mark_unavailable && i.status !== 'RESOLVED' && ' · shown as unavailable'}{i.source === 'AUTOMATION' && ' · automatic'}</p></TableCell>
                    <TableCell><Badge variant={SEVERITY[i.severity].variant}>{SEVERITY[i.severity].label}</Badge></TableCell>
                    <TableCell><Badge variant={STATUS[i.status].variant} title={STATUS[i.status].hint}>{STATUS[i.status].label}</Badge></TableCell>
                    <TableCell className="text-xs">{scopeText(i)}</TableCell>
                    <TableCell className="text-xs">{i.assigned?.name ?? <span className="text-muted-foreground">nobody</span>}</TableCell>
                    <TableCell className="text-xs">{timeAgo(i.started_at)}{i.resolved_at && <span className="text-muted-foreground"> · {duration(i.minutes_open)}</span>}</TableCell>
                  </TableRow>))}</TableBody>
              </Table></div>
            )}
          </Card>
        </>
      )}
      {creating && d && <NewIncidentDialog list={d} onClose={() => setCreating(false)} />}
      <IncidentSheet id={state.incident || null} list={d} onClose={() => setState({ incident: '' })} onAnnounce={(i) => setAnnounce(draftFor(i))} />
      {announce && <AnnouncementComposer initial={announce} onClose={() => setAnnounce(null)} />}
    </div>
  )
}

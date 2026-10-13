import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckSquare, ClipboardList, Plus, Square, X } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useMyDay } from '@/features/hr/attendance'
import { formatDate, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  cancelRequest, decideRequest, type HrRequest, listRequests, myChecklists, REQUEST_KIND, type RequestKind, sopSteps, submitRequest, tickChecklist, timeLabel,
} from '@/services/hr'

const STATUS_BADGE: Record<HrRequest['status'], 'warning' | 'success' | 'danger' | 'neutral'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' }

const range = (r: HrRequest) => (r.from_date === r.to_date ? formatDate(r.from_date) : `${formatDate(r.from_date)} – ${formatDate(r.to_date)}`)

/** Leave, corrections and late excuses: everyone asks, HR decides. */
export function RequestsView() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const hr = can('hr.manage')
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING')
  const [asking, setAsking] = useState(false)
  const [deciding, setDeciding] = useState<{ r: HrRequest; approve: boolean } | null>(null)
  const list = useQuery({ queryKey: ['hr', 'requests', filter], queryFn: () => listRequests(filter === 'ALL' ? undefined : 'PENDING') })
  const cancel = useMutation({ mutationFn: (id: string) => cancelRequest(id), onSuccess: () => { toast.success('Request cancelled'); void qc.invalidateQueries({ queryKey: ['hr'] }) }, onError: (e) => toast.error((e as Error).message) })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {(['PENDING', 'ALL'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={cn('rounded-md px-3 py-1 text-sm', filter === f ? 'bg-muted font-medium' : 'text-muted-foreground')}>{f === 'PENDING' ? 'Waiting' : 'All'}</button>
          ))}
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setAsking(true)}><Plus /> New request</Button>
      </div>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : !list.data?.length ? <EmptyState icon={<ClipboardList />} title={filter === 'PENDING' ? 'Nothing waiting' : 'No requests yet'} description="Ask for leave, fix a missed check-in or excuse a late arrival." /> : (
          <div className="grid gap-2 md:grid-cols-2">
            {list.data.map((r) => (
              <Card key={r.id} className="gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{REQUEST_KIND[r.kind]} <span className="font-normal text-muted-foreground">· {range(r)}</span></p>
                    <p className="text-xs text-muted-foreground">{r.mine ? 'You' : r.name} · {timeAgo(r.created_at)}</p>
                  </div>
                  <Badge variant={STATUS_BADGE[r.status]}>{r.status.toLowerCase()}</Badge>
                </div>
                {r.kind === 'CORRECTION' && <p className="text-xs">Times asked: {timeLabel(r.check_in)} – {r.check_out ? timeLabel(r.check_out) : 'no check-out'}</p>}
                <p className="text-sm whitespace-pre-line">{r.reason}</p>
                {r.status !== 'PENDING' && r.decided_by && <p className="text-xs text-muted-foreground">{r.status === 'CANCELLED' ? 'Cancelled' : `${r.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${r.decided_by}`}{r.decision_note ? ` · “${r.decision_note}”` : ''}</p>}
                {r.status === 'PENDING' && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {r.mine && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>Cancel</Button>}
                    {hr && !r.mine && <>
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ r, approve: false })}><X /> Reject</Button>
                      <Button size="sm" onClick={() => setDeciding({ r, approve: true })}><Check /> Approve</Button>
                    </>}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      {asking && <RequestDialog onClose={() => setAsking(false)} />}
      {deciding && <DecideDialog {...deciding} onClose={() => setDeciding(null)} />}
    </div>
  )
}

function RequestDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const me = useMyDay()
  const today = me.data?.date ?? ''
  const [kind, setKind] = useState<RequestKind>('LEAVE')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [inT, setIn] = useState('09:00')
  const [outT, setOut] = useState('18:00')
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => submitRequest({ kind, from_date: from, to_date: kind === 'LEAVE' ? to || from : from, check_in: kind === 'CORRECTION' ? inT : undefined, check_out: kind === 'CORRECTION' ? outT || undefined : undefined, reason }),
    onSuccess: () => { toast.success('Request sent to HR'); void qc.invalidateQueries({ queryKey: ['hr'] }); onClose() },
    onError: (e) => toast.error((e as Error).message),
  })
  const past = kind !== 'LEAVE'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New request</DialogTitle><DialogDescription>HR is told right away; you see the answer here.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label="Type">
            <Select value={kind} onValueChange={(v) => setKind(v as RequestKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(REQUEST_KIND) as RequestKind[]).map((k) => <SelectItem key={k} value={k}>{REQUEST_KIND[k]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className={cn('grid gap-2', kind === 'LEAVE' && 'grid-cols-2')}>
            <Field label={kind === 'LEAVE' ? 'From' : 'Day'}><DatePicker value={from} onChange={setFrom} max={past ? today : undefined} min={past ? undefined : today} /></Field>
            {kind === 'LEAVE' && <Field label="To"><DatePicker value={to || from} onChange={setTo} min={from || today} /></Field>}
          </div>
          {kind === 'CORRECTION' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Check-in" htmlFor="rq-in"><Input id="rq-in" type="time" value={inT} onChange={(e) => setIn(e.target.value)} /></Field>
              <Field label="Check-out" htmlFor="rq-out"><Input id="rq-out" type="time" value={outT} onChange={(e) => setOut(e.target.value)} /></Field>
            </div>
          )}
          <Field label="Reason" htmlFor="rq-why" required><Textarea id="rq-why" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'LEAVE' ? 'Family event, illness…' : kind === 'CORRECTION' ? 'Forgot to check in, phone was off…' : 'Traffic, appointment…'} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !from || reason.trim().length < 3 || (kind === 'CORRECTION' && !inT)}>{save.isPending ? <Spinner /> : <Check />} Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DecideDialog({ r, approve, onClose }: { r: HrRequest; approve: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const go = useMutation({
    mutationFn: () => decideRequest(r.id, approve, note),
    onSuccess: () => { toast.success(approve ? 'Approved and applied' : 'Rejected'); void qc.invalidateQueries({ queryKey: ['hr'] }); onClose() },
    onError: (e) => toast.error((e as Error).message),
  })
  const effect = r.kind === 'LEAVE' ? 'Every work day in the range is marked as leave (days already worked stay as worked).'
    : r.kind === 'CORRECTION' ? 'The day’s check-in and check-out are set to the asked times; late and hours are worked out again.'
      : 'The late minutes of that day are cleared.'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{approve ? 'Approve' : 'Reject'} {REQUEST_KIND[r.kind].toLowerCase()} for {r.name}</DialogTitle>
          <DialogDescription>{range(r)}. {approve ? effect : 'Nothing changes in the attendance.'}</DialogDescription>
        </DialogHeader>
        <Field label="Note (optional)" htmlFor="dc-note"><Input id="dc-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button variant={approve ? 'default' : 'destructive'} onClick={() => go.mutate()} disabled={go.isPending}>{go.isPending ? <Spinner /> : approve ? <Check /> : <X />} {approve ? 'Approve' : 'Reject'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Today's SOP checklists for the signed-in person. */
export function MyChecklists() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['hr', 'my-checklists'], queryFn: myChecklists })
  const tick = useMutation({
    mutationFn: (v: { sop: string; item: number; done: boolean }) => tickChecklist(v.sop, v.item, v.done),
    onSuccess: (r) => { if (r.complete) toast.success('Checklist complete'); void qc.invalidateQueries({ queryKey: ['hr', 'my-checklists'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  if (!list.data?.length) return null
  return (
    <Card className="gap-3 p-4">
      <p className="flex items-center gap-2 font-medium"><ClipboardList className="size-4" /> Today’s checklists</p>
      <div className="grid gap-3 md:grid-cols-2">
        {list.data.map((c) => {
          const steps = sopSteps(c.body)
          return (
            <div key={c.id} className="rounded-xl border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{c.title}</p>
                <span className="text-xs text-muted-foreground tabular-nums">{c.done.length}/{c.items_total}</span>
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${c.items_total ? (100 * c.done.length) / c.items_total : 0}%` }} /></div>
              <ul className="space-y-1">
                {steps.map((s, i) => {
                  const done = c.done.includes(i)
                  return (
                    <li key={i}>
                      <button type="button" onClick={() => tick.mutate({ sop: c.id, item: i, done: !done })} disabled={tick.isPending}
                        className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted/50">
                        {done ? <CheckSquare className="mt-0.5 size-4 shrink-0 text-primary" /> : <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                        <span className={cn(done && 'text-muted-foreground line-through')}>{s}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

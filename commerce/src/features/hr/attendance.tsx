import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CalendarDays, Clock, Coffee, LogIn, LogOut, Pencil, Timer } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNow, useWorkdayActions } from '@/features/hr/workday'
import {
  ATTENDANCE, type AttendanceStatus, attendanceBoard, type BoardRow, type BoardState, minutesLabel, type MyDay, myDay, setAttendance,
  timeLabel, zonedHm, zonedIso, zonedTime,
} from '@/services/hr'

export function useMyDay() {
  return useQuery({ queryKey: ['hr', 'me'], queryFn: myDay, staleTime: 30_000 })
}

/** Today's check-in, breaks and check-out for the signed-in staff member. */
export function MyDayCard({ className }: { className?: string }) {
  const me = useMyDay()
  const now = useNow(1000)
  const actions = useWorkdayActions()
  if (me.isLoading) return <Card className={cn('p-4', className)}><Spinner /></Card>
  if (me.error || !me.data) return null
  const d = me.data
  const r = d.record
  const working = Boolean(r?.check_in_at && !r.check_out_at)
  const onBreak = d.breaks.some((b) => !b.ended_at)
  const net = netMinutes(d, now)
  const state = !r ? (d.work_day ? 'Not checked in' : 'Day off') : r.check_out_at ? 'Done for today' : onBreak ? 'On break' : r.check_in_at ? 'Working' : ATTENDANCE[r.status].label
  return (
    <Card className={cn('gap-0 overflow-hidden p-0', className)}>
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold"><CalendarDays className="size-4 text-primary" /> Attendance</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(d.date)} · {d.shift ? `${d.shift.name} ${timeLabel(d.shift.start_time)} – ${timeLabel(d.shift.end_time)}` : 'No shift assigned'}</p>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
          working && !onBreak ? 'bg-primary text-primary-foreground' : onBreak ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground')}>{state}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 py-3">
        <div><p className="text-xs text-muted-foreground">Check in</p><p className="text-lg font-semibold tabular-nums">{r?.check_in_at ? zonedTime(r.check_in_at, d.tz) : '--:--'}</p></div>
        <div><p className="text-xs text-muted-foreground">Check out</p><p className="text-lg font-semibold tabular-nums">{r?.check_out_at ? zonedTime(r.check_out_at, d.tz) : '--:--'}</p></div>
      </div>
      {r?.check_in_at && (
        <div className="mx-4 mb-3 flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground"><Clock className="size-4" /> Work hours</span>
          <span className="font-semibold tabular-nums">{minutesLabel(net)}</span>
        </div>
      )}
      <div className="px-4 pb-4">
        {!d.self_check_in ? <p className="text-xs text-muted-foreground">Attendance is recorded by HR in this store.</p>
          : !r?.check_in_at ? (
            <Button className="w-full" size="lg" onClick={() => actions.checkIn.mutate()} disabled={actions.checkIn.isPending}>
              {actions.checkIn.isPending ? <Spinner /> : <LogIn />} Check in
            </Button>
          ) : working ? (
            <div className="grid grid-cols-2 gap-2">
              {onBreak ? (
                <Button variant="outline" onClick={() => actions.endBreak.mutate()} disabled={actions.endBreak.isPending}><Coffee /> End break</Button>
              ) : (
                <Button variant="outline" onClick={() => actions.startBreak.mutate()} disabled={actions.startBreak.isPending}><Coffee /> Start break</Button>
              )}
              <Button variant="destructive" onClick={() => actions.checkOut.mutate()} disabled={actions.checkOut.isPending}>{actions.checkOut.isPending ? <Spinner /> : <LogOut />} Check out</Button>
            </div>
          ) : <p className="text-center text-xs text-muted-foreground">{r.checkout_source === 'AUTO' ? 'Checked out automatically at the end of the day.' : 'See you tomorrow.'}</p>}
        {working && d.rules.auto_checkout && d.scheduled_end && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            {r?.keep_open_today ? 'Automatic check-out is off for today.' : <>Automatic check-out at {zonedTime(d.scheduled_end, d.tz)} · <button type="button" className="underline" onClick={() => actions.keepWorking.mutate()}>keep working today</button></>}
          </p>
        )}
      </div>
    </Card>
  )
}

/** Net minutes worked so far: check-in to check-out (or now), minus breaks. */
function netMinutes(d: MyDay, now: number) {
  const r = d.record
  if (!r?.check_in_at) return null
  if (r.check_out_at) return r.worked_minutes
  const breaks = d.breaks.reduce((t, b) => t + ((b.ended_at ? new Date(b.ended_at).getTime() : now) - new Date(b.started_at).getTime()), 0)
  return Math.max(0, Math.floor((now - new Date(r.check_in_at).getTime() - breaks) / 60_000))
}

/** Check-in time, total, breaks and net hours for today. */
export function MyDayStats() {
  const me = useMyDay()
  const now = useNow(30_000)
  if (!me.data) return null
  const d = me.data
  const r = d.record
  const gross = r?.check_in_at ? Math.max(0, Math.floor(((r.check_out_at ? new Date(r.check_out_at).getTime() : now) - new Date(r.check_in_at).getTime()) / 60_000)) : 0
  const net = netMinutes(d, now) ?? 0
  const breakMin = Math.max(0, gross - net)
  const items = [
    { label: 'Check-in time', icon: <Clock />, value: r?.check_in_at ? zonedTime(r.check_in_at, d.tz) : '--:--',
      hint: r?.late_minutes ? `${minutesLabel(r.late_minutes)} late` : r?.check_in_at ? 'On time' : d.shift ? `Starts ${timeLabel(d.shift.start_time)}` : '—', warn: Boolean(r?.late_minutes) },
    { label: 'Total hours', icon: <Timer />, value: minutesLabel(gross), hint: r?.check_out_at ? 'Work completed' : r?.check_in_at ? 'Still working' : 'Not started' },
    { label: 'Break time', icon: <Coffee />, value: minutesLabel(breakMin), hint: `${d.breaks.length} break${d.breaks.length === 1 ? '' : 's'} · limit ${minutesLabel(d.rules.max_break_minutes)}`, warn: breakMin > d.rules.max_break_minutes },
    { label: 'Net work hours', icon: <CalendarCheck />, value: minutesLabel(net), hint: 'Total − breaks' },
  ]
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((x) => (
        <Card key={x.label} className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">{x.label}<span className="[&_svg]:size-4">{x.icon}</span></div>
          <p className="text-2xl font-semibold tabular-nums">{x.value}</p>
          <p className={cn('text-xs', x.warn ? 'text-amber-600' : 'text-muted-foreground')}>{x.hint}</p>
        </Card>
      ))}
    </div>
  )
}

/** The day after a yyyy-mm-dd date (check-out after midnight on a night shift). */
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)

const FILTERS: Array<{ key: 'all' | BoardState; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'PRESENT', label: 'Present' }, { key: 'LATE', label: 'Late' }, { key: 'NOT_IN', label: 'Not in' },
  { key: 'ABSENT', label: 'Absent' }, { key: 'LEAVE', label: 'Leave' }, { key: 'OFF', label: 'Off' },
]

/** Everyone's attendance on a day, with corrections for HR. */
export function AttendanceBoard({ date, tz }: { date: string; tz: string }) {
  const { can } = useAuth()
  const [filter, setFilter] = useState<'all' | BoardState>('all')
  const [editing, setEditing] = useState<BoardRow | null>(null)
  const board = useQuery({ queryKey: ['hr', 'board', date], queryFn: () => attendanceBoard(date), refetchInterval: 60_000 })
  const rows = useMemo(() => (board.data ?? []).filter((r) => filter === 'all' || r.state === filter || (filter === 'LEAVE' && r.state === 'HOLIDAY')), [board.data, filter])
  const count = (k: BoardState) => (board.data ?? []).filter((r) => r.state === k).length
  if (board.isLoading) return <LoadingState />
  if (board.error) return <ErrorState error={board.error} onRetry={() => board.refetch()} />
  return (
    <div className="space-y-3">
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm', filter === f.key ? 'border-foreground/40 bg-card' : 'text-muted-foreground hover:text-foreground')}>
            {f.label} <span className="text-xs tabular-nums opacity-70">{f.key === 'all' ? board.data?.length ?? 0 : count(f.key)}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? <EmptyState title="No staff here" description="Nobody matches this filter." /> : (
        <Card className="gap-0 overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Staff</th><th>Department</th><th>Shift</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.profile_id} className="[&>td]:px-3 [&>td]:py-2">
                  <td><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{r.designation ?? r.role}</p></td>
                  <td>{r.department ? <span className="inline-flex items-center gap-1.5 text-xs"><span className="size-2 rounded-full" style={{ background: r.department_color ?? undefined }} />{r.department}</span> : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className="text-xs">{r.shift ? <>{r.shift}<p className="text-muted-foreground">{timeLabel(r.shift_start)} – {timeLabel(r.shift_end)}</p></> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="tabular-nums">{zonedTime(r.record?.check_in_at, tz)}</td>
                  <td className="tabular-nums">{zonedTime(r.record?.check_out_at, tz)}</td>
                  <td className="tabular-nums">{minutesLabel(r.record?.worked_minutes)}</td>
                  <td className={cn('tabular-nums', (r.record?.late_minutes ?? 0) > 0 && 'text-amber-600')}>{r.record?.late_minutes ? minutesLabel(r.record.late_minutes) : '—'}</td>
                  <td><Badge variant={ATTENDANCE[r.state].variant}>{ATTENDANCE[r.state].label}</Badge>{r.record?.source === 'ADMIN' && <p className="mt-0.5 text-[10px] text-muted-foreground">set by HR</p>}</td>
                  <td className="text-right">{can('hr.manage') && <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}><Pencil /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {editing && <EditAttendanceDialog row={editing} date={date} tz={tz} onClose={() => setEditing(null)} />}
    </div>
  )
}

function EditAttendanceDialog({ row, date, tz, onClose }: { row: BoardRow; date: string; tz: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const r = row.record
  const [status, setStatus] = useState<AttendanceStatus>(r?.status ?? 'PRESENT')
  const [inT, setIn] = useState(zonedHm(r?.check_in_at, tz) || (row.shift_start ?? '09:00').slice(0, 5))
  const [outT, setOut] = useState(zonedHm(r?.check_out_at, tz))
  const [note, setNote] = useState(r?.note ?? '')
  const timed = ['PRESENT', 'LATE', 'HALF_DAY'].includes(status)
  const save = useMutation({
    mutationFn: () => setAttendance({ profileId: row.profile_id, date, status, checkIn: timed && inT ? zonedIso(date, inT, tz) : null, checkOut: timed && outT ? zonedIso(outT < inT ? nextDay(date) : date, outT, tz) : null, note }),
    onSuccess: (x) => { toast.success(`${row.name}: ${ATTENDANCE[x.status].label}`); void queryClient.invalidateQueries({ queryKey: ['hr'] }); onClose() },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{row.name} · {formatDate(date)}</DialogTitle>
          <DialogDescription>Present, late and half day are worked out from the times and the shift.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as AttendanceStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY'] as const).map((s) => <SelectItem key={s} value={s}>{s === 'PRESENT' ? 'Worked (present / late / half day)' : ATTENDANCE[s].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {timed && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Check-in" htmlFor="att-in"><Input id="att-in" type="time" value={inT} onChange={(e) => setIn(e.target.value)} /></Field>
              <Field label="Check-out" htmlFor="att-out"><Input id="att-out" type="time" value={outT} onChange={(e) => setOut(e.target.value)} /></Field>
            </div>
          )}
          <Field label="Note" htmlFor="att-note"><Input id="att-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (kept in the record)" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (timed && !inT)}>{save.isPending ? <Spinner /> : <Clock />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

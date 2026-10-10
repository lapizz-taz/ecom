import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, LogIn, LogOut, Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import {
  ATTENDANCE, type AttendanceStatus, attendanceBoard, type BoardRow, type BoardState, checkIn, checkOut, minutesLabel, myDay, setAttendance,
  timeLabel, zonedHm, zonedIso, zonedTime,
} from '@/services/hr'

export function useMyDay() {
  return useQuery({ queryKey: ['hr', 'me'], queryFn: myDay, staleTime: 30_000 })
}

/** Today's check-in / check-out for the signed-in staff member. */
export function MyDayCard({ className }: { className?: string }) {
  const queryClient = useQueryClient()
  const me = useMyDay()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  const done = () => { void queryClient.invalidateQueries({ queryKey: ['hr'] }) }
  const inM = useMutation({ mutationFn: () => checkIn(), onSuccess: (r) => { toast.success(r.late_minutes ? `Checked in · ${minutesLabel(r.late_minutes)} late` : 'Checked in on time'); done() }, onError: (e) => toast.error((e as Error).message) })
  const outM = useMutation({ mutationFn: () => checkOut(), onSuccess: (r) => { toast.success(`Checked out · ${minutesLabel(r.worked_minutes)} worked`); done() }, onError: (e) => toast.error((e as Error).message) })
  if (me.isLoading) return <Card className={cn('p-4', className)}><Spinner /></Card>
  if (me.error || !me.data) return null
  const d = me.data
  const r = d.record
  const working = r?.check_in_at && !r.check_out_at
  const sinceIn = working ? Math.floor((now - new Date(r!.check_in_at!).getTime()) / 60000) : null
  return (
    <Card className={cn('gap-3 p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">My attendance · {formatDate(d.date)}</p>
          <p className="mt-0.5 text-lg font-semibold">
            {!r ? (d.work_day ? 'Not checked in' : 'Day off') : r.check_out_at ? 'Done for today' : r.check_in_at ? 'Working' : ATTENDANCE[r.status].label}
          </p>
          <p className="text-xs text-muted-foreground">
            {d.shift ? `${d.shift.name}: ${timeLabel(d.shift.start_time)} – ${timeLabel(d.shift.end_time)} · ${d.shift.grace_minutes} min grace` : 'No shift assigned yet'}
          </p>
        </div>
        {r && <Badge variant={ATTENDANCE[r.status].variant}>{ATTENDANCE[r.status].label}{r.late_minutes ? ` · ${minutesLabel(r.late_minutes)}` : ''}</Badge>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-muted/50 p-2"><p className="font-semibold tabular-nums">{zonedTime(r?.check_in_at, d.tz)}</p><p className="text-muted-foreground">In</p></div>
        <div className="rounded-lg bg-muted/50 p-2"><p className="font-semibold tabular-nums">{zonedTime(r?.check_out_at, d.tz)}</p><p className="text-muted-foreground">Out</p></div>
        <div className="rounded-lg bg-muted/50 p-2"><p className="font-semibold tabular-nums">{minutesLabel(r?.worked_minutes ?? sinceIn)}</p><p className="text-muted-foreground">Worked</p></div>
      </div>
      {d.self_check_in ? (
        !r?.check_in_at ? (
          <Button onClick={() => inM.mutate()} disabled={inM.isPending}>{inM.isPending ? <Spinner /> : <LogIn />} Check in</Button>
        ) : working ? (
          <Button variant="outline" onClick={() => outM.mutate()} disabled={outM.isPending}>{outM.isPending ? <Spinner /> : <LogOut />} Check out</Button>
        ) : null
      ) : <p className="text-xs text-muted-foreground">Attendance is recorded by HR in this store.</p>}
    </Card>
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

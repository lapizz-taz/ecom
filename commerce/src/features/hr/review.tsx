import { useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, Download, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMyDay } from '@/features/hr/attendance'
import { downloadCsv } from '@/lib/csv'
import { cn } from '@/lib/utils'
import { attendanceBoard, employeeMonth, minutesLabel, type MonthDay, type MonthState, WEEKDAYS, zonedTime } from '@/services/hr'

const STATE: Record<MonthState, { label: string; cell: string }> = {
  PRESENT: { label: 'Present', cell: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  LATE: { label: 'Late', cell: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  HALF_DAY: { label: 'Half day', cell: 'bg-orange-500/15 text-orange-700 border-orange-500/30' },
  ABSENT: { label: 'Absent', cell: 'bg-red-500/15 text-red-700 border-red-500/30' },
  LEAVE: { label: 'Leave', cell: 'bg-violet-500/15 text-violet-700 border-violet-500/30' },
  HOLIDAY: { label: 'Holiday', cell: 'bg-sky-500/15 text-sky-700 border-sky-500/30' },
  OFF: { label: 'Off', cell: 'bg-muted/40 text-muted-foreground border-transparent' },
  NOT_IN: { label: 'Not in yet', cell: 'border-dashed text-muted-foreground' },
  UPCOMING: { label: '', cell: 'border-transparent text-muted-foreground/50' },
}

const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`
const shiftMonth = (m: string, by: number) => {
  const d = new Date(`${m}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + by)
  return d.toISOString().slice(0, 10)
}
const monthName = (m: string) => new Date(`${m}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** One employee's month at a glance, for HR (and for themselves). */
export function AttendanceReview() {
  const me = useMyDay()
  const today = me.data?.date ?? new Date().toISOString().slice(0, 10)
  const tz = me.data?.tz ?? 'Asia/Dhaka'
  const [month, setMonth] = useState(() => monthOf(today))
  const [who, setWho] = useState('')
  const [open, setOpen] = useState<MonthDay | null>(null)
  const staff = useQuery({ queryKey: ['hr', 'board', today], queryFn: () => attendanceBoard(today), enabled: Boolean(me.data) })
  const people = useMemo(() => (staff.data ?? []).map((r) => ({ id: r.profile_id, name: r.name, sub: [r.department, r.designation].filter(Boolean).join(' · ') })), [staff.data])
  const review = useQuery({ queryKey: ['hr', 'month', who, month], queryFn: () => employeeMonth(who, month), enabled: Boolean(who) })
  const idx = people.findIndex((p) => p.id === who)
  const step = (by: number) => { if (people.length) setWho(people[(idx + by + people.length) % people.length].id) }
  const lead = new Date(`${month}T00:00:00Z`).getUTCDay()
  const exportCsv = () => review.data && downloadCsv(`attendance-${review.data.name}-${month.slice(0, 7)}`, review.data.days.filter((x) => x.state !== 'UPCOMING'), [
    { header: 'Date', value: (x: MonthDay) => x.date }, { header: 'Status', value: (x) => STATE[x.state].label || x.state },
    { header: 'Check in', value: (x) => (x.check_in_at ? zonedTime(x.check_in_at, tz) : '') }, { header: 'Check out', value: (x) => (x.check_out_at ? zonedTime(x.check_out_at, tz) : '') },
    { header: 'Late minutes', value: (x) => x.late_minutes }, { header: 'Break minutes', value: (x) => x.break_minutes },
    { header: 'Net hours', value: (x) => (x.worked_minutes == null ? '' : (x.worked_minutes / 60).toFixed(2)) }, { header: 'Note', value: (x) => x.note ?? x.holiday ?? '' },
  ])
  return (
    <div className="space-y-3">
      <Card className="gap-3 p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><CalendarDays className="size-5" /></span>
          <div><p className="font-semibold">Attendance review</p><p className="text-xs text-muted-foreground">{monthName(month)}</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border">
            <Button variant="ghost" size="icon" className="size-9" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft /></Button>
            <Button variant="ghost" size="sm" onClick={() => setMonth(monthOf(today))}>Today</Button>
            <Button variant="ghost" size="icon" className="size-9" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthOf(today)} aria-label="Next month"><ChevronRight /></Button>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!review.data}><Download /> Export</Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => step(-1)} disabled={!people.length} aria-label="Previous employee"><ChevronLeft /></Button>
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="Select employee…" /></SelectTrigger>
            <SelectContent>{people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.sub ? ` · ${p.sub}` : ''}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => step(1)} disabled={!people.length} aria-label="Next employee"><ChevronRight /></Button>
        </div>
      </Card>

      {!who ? <EmptyState icon={<Users />} title="Select an employee to review their attendance" description="Pick someone above, then move through the team with the arrows." />
        : review.isLoading ? <LoadingState />
          : review.error || !review.data ? <ErrorState error={review.error} onRetry={() => review.refetch()} /> : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Present', `${review.data.summary.present}/${review.data.summary.work_days}`],
                  ['Late', `${review.data.summary.late} · ${minutesLabel(review.data.summary.late_minutes)}`],
                  ['Absent / leave', `${review.data.summary.absent} / ${review.data.summary.leave}`],
                  ['Net hours', (review.data.summary.worked_minutes / 60).toFixed(1)],
                ].map(([l, v]) => (
                  <Card key={l} className="gap-1 p-3"><p className="text-xs text-muted-foreground">{l}</p><p className="text-lg font-semibold tabular-nums">{v}</p></Card>
                ))}
              </div>
              <Card className="gap-2 p-3">
                <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">{WEEKDAYS.map((d) => <span key={d}>{d}</span>)}</div>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: lead }, (_, i) => <span key={`x${i}`} />)}
                  {review.data.days.map((x) => (
                    <button key={x.date} type="button" disabled={x.state === 'UPCOMING'} onClick={() => setOpen(open?.date === x.date ? null : x)}
                      className={cn('flex aspect-square min-w-0 flex-col items-start justify-between rounded-lg border p-1 text-left text-[10px] sm:p-1.5 sm:text-xs',
                        STATE[x.state].cell, open?.date === x.date && 'ring-2 ring-primary', x.date === today && 'font-semibold')}>
                      <span className={cn('tabular-nums', x.state !== 'UPCOMING' && 'font-medium text-foreground')}>{Number(x.date.slice(8))}</span>
                      <span className="hidden w-full truncate sm:block">{x.check_in_at ? zonedTime(x.check_in_at, tz) : x.holiday ?? STATE[x.state].label}</span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-muted-foreground">
                  {(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY'] as const).map((k) => (
                    <span key={k} className="flex items-center gap-1"><span className={cn('size-2.5 rounded-sm border', STATE[k].cell)} />{STATE[k].label}</span>
                  ))}
                </div>
              </Card>
              {open && (
                <Card className="gap-1 p-4 text-sm">
                  <p className="font-medium">{new Date(`${open.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} · {STATE[open.state].label || open.state}</p>
                  <p className="text-muted-foreground">
                    In {open.check_in_at ? zonedTime(open.check_in_at, tz) : '—'} · Out {open.check_out_at ? zonedTime(open.check_out_at, tz) : '—'}{open.checkout_source === 'AUTO' ? ' (automatic)' : ''}
                    {open.late_minutes > 0 && ` · ${minutesLabel(open.late_minutes)} late`} · {open.breaks} break{open.breaks === 1 ? '' : 's'} ({minutesLabel(open.break_minutes)}) · net {minutesLabel(open.worked_minutes)}
                  </p>
                  {(open.note || open.holiday) && <p className="text-xs text-muted-foreground">{open.holiday ?? open.note}{open.source === 'ADMIN' ? ' · set by HR' : ''}</p>}
                </Card>
              )}
            </>
          )}
    </div>
  )
}

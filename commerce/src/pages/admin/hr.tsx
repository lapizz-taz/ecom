import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, Download, LogIn, LogOut } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/auth-context'
import { AttendanceBoard, MyDayCard, useMyDay } from '@/features/hr/attendance'
import { DepartmentsSop, HrSettingsView, ShiftManagement } from '@/features/hr/setup'
import { downloadCsv } from '@/lib/csv'
import { type DateRange, rangeFor } from '@/lib/dates'
import { formatDate, formatShortDate, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ATTENDANCE, attendanceReport, hrDashboard, minutesLabel, type ReportStaff, zonedTime } from '@/services/hr'

const SECTIONS = {
  '/admin/hr': { title: 'HR dashboard', description: 'Who is in today, late arrivals and attendance over the last two weeks.' },
  '/admin/hr/attendance': { title: 'Attendance', description: 'Check in and out, and see everyone’s day.' },
  '/admin/hr/report': { title: 'Attendance report', description: 'Present, late, absent and hours per staff member for any period.' },
  '/admin/hr/shifts': { title: 'Shift management', description: 'Working hours, grace time and work days.' },
  '/admin/hr/departments': { title: 'Departments & SOP', description: 'Teams, their standard operating procedures and who works where.' },
  '/admin/hr/settings': { title: 'HR settings', description: 'Attendance rules and holidays.' },
} as const

export default function HrPage() {
  const path = useLocation().pathname.replace(/\/+$/, '') as keyof typeof SECTIONS
  const { can } = useAuth()
  const meta = SECTIONS[path] ?? SECTIONS['/admin/hr']
  return (
    <div className="space-y-4">
      <PageHeader title={meta.title} description={meta.description}
        actions={can('users.manage') ? <Button size="sm" variant="outline" asChild><Link to="/admin/users">User & Role <ChevronRight /></Link></Button> : undefined} />
      {path === '/admin/hr/attendance' ? <AttendanceView />
        : path === '/admin/hr/report' ? <ReportView />
          : path === '/admin/hr/shifts' ? <ShiftManagement />
            : path === '/admin/hr/departments' ? <DepartmentsSop />
              : path === '/admin/hr/settings' ? <HrSettingsView />
                : can('hr.view') ? <DashboardView /> : <MyDayCard className="max-w-md" />}
    </div>
  )
}

function DashboardView() {
  const dash = useQuery({ queryKey: ['hr', 'dashboard'], queryFn: hrDashboard, refetchInterval: 60_000 })
  const me = useMyDay()
  if (dash.isLoading) return <LoadingState />
  if (dash.error || !dash.data) return <ErrorState error={dash.error} onRetry={() => dash.refetch()} />
  const d = dash.data
  const t = d.today
  const peak = Math.max(1, ...d.trend.map((x) => x.present + x.late + x.absent + x.leave))
  const tz = me.data?.tz ?? 'Asia/Dhaka'
  return (
    <div className="space-y-4">
      {d.unassigned > 0 && (
        <Link to="/admin/hr/departments" className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="size-4 shrink-0" /> {d.unassigned} staff have no department or shift yet, so late and absent cannot be worked out for them. Set them up <ChevronRight className="ml-auto size-4" />
        </Link>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Staff" value={t.staff} hint={`${t.off} off today`} />
        <StatCard label="Present" value={t.present + t.half_day} tone="positive" hint={`${t.checked_out} checked out`} />
        <StatCard label="Late" value={t.late} tone={t.late ? 'warning' : undefined} />
        <StatCard label="Not in yet" value={t.not_in} />
        <StatCard label="Absent" value={t.absent} tone={t.absent ? 'negative' : undefined} />
        <StatCard label="Leave / holiday" value={t.leave} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between"><p className="font-medium">Last 14 days</p>
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              {[['bg-emerald-500', 'Present'], ['bg-amber-500', 'Late'], ['bg-red-500', 'Absent'], ['bg-sky-500', 'Leave']].map(([c, l]) => <span key={l} className="flex items-center gap-1"><span className={cn('size-2 rounded-full', c)} />{l}</span>)}
            </div>
          </div>
          <div className="flex h-40 items-end gap-1.5">
            {d.trend.map((x) => {
              const total = x.present + x.late + x.absent + x.leave
              return (
                <div key={x.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${formatDate(x.date)}: ${x.present} present, ${x.late} late, ${x.absent} absent, ${x.leave} leave`}>
                  <div className="flex w-full flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${(100 * total) / peak}%` }}>
                    {([['present', 'bg-emerald-500'], ['late', 'bg-amber-500'], ['absent', 'bg-red-500'], ['leave', 'bg-sky-500']] as const).map(([k, c]) => (
                      <div key={k} className={c} style={{ height: total ? `${(100 * x[k]) / total}%` : 0 }} />
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{formatShortDate(x.date).split(' ')[0]}</span>
                </div>
              )
            })}
          </div>
        </Card>
        <MyDayCard />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-0 p-0">
          <div className="flex items-center justify-between border-b px-4 py-3"><p className="font-medium">Today</p><Button size="sm" variant="ghost" asChild><Link to="/admin/hr/attendance">Attendance <ChevronRight /></Link></Button></div>
          {d.recent.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">Nobody has checked in yet today.</p> : (
            <ul className="divide-y">
              {d.recent.map((r, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                  {r.kind === 'in' ? <LogIn className="size-4 text-emerald-600" /> : <LogOut className="size-4 text-muted-foreground" />}
                  <span className="flex-1 font-medium">{r.name}</span>
                  {r.kind === 'in' && r.late_minutes > 0 && <Badge variant="warning" className="text-[10px]">{minutesLabel(r.late_minutes)} late</Badge>}
                  <span className="text-xs text-muted-foreground tabular-nums" title={timeAgo(r.at)}>{r.kind === 'in' ? 'in' : 'out'} {zonedTime(r.at, tz)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="gap-0 p-0">
          <div className="flex items-center justify-between border-b px-4 py-3"><p className="font-medium">Departments</p><Button size="sm" variant="ghost" asChild><Link to="/admin/hr/departments">Manage <ChevronRight /></Link></Button></div>
          {d.departments.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No departments yet.</p> : (
            <ul className="divide-y">
              {d.departments.map((x) => (
                <li key={x.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="size-2.5 rounded-full" style={{ background: x.color }} />
                  <span className="flex-1 font-medium">{x.name}</span>
                  <span className="text-xs text-muted-foreground">{x.staff} staff · {x.sops} SOP{x.sops === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function AttendanceView() {
  const { can } = useAuth()
  const me = useMyDay()
  const [date, setDate] = useState('')
  const day = date || me.data?.date || ''
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <MyDayCard />
        {can('hr.view') && (
          <Card className="gap-2 p-4">
            <p className="text-sm font-medium">Day</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={day} max={me.data?.date} onChange={(e) => setDate(e.target.value)} className="w-44" aria-label="Attendance date" />
              {date && <Button size="sm" variant="ghost" onClick={() => setDate('')}>Today</Button>}
            </div>
            <p className="text-xs text-muted-foreground">Times are in the store’s time zone ({me.data?.tz ?? '…'}). HR can correct any past day; changes are marked “set by HR”.</p>
          </Card>
        )}
      </div>
      {can('hr.view') && day && me.data && <AttendanceBoard date={day} tz={me.data.tz} />}
    </div>
  )
}

function ReportView() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('month'))
  const [open, setOpen] = useState<string | null>(null)
  const me = useMyDay()
  const report = useQuery({ queryKey: ['hr', 'report', range], queryFn: () => attendanceReport(range.from, range.to) })
  const days = useMemo(() => (report.data?.days ?? []).filter((x) => x.profile_id === open), [report.data, open])
  const tz = me.data?.tz ?? 'Asia/Dhaka'
  const exportCsv = () => report.data && downloadCsv(`attendance-${range.from}-${range.to}`, report.data.staff, [
    { header: 'Staff', value: (s: ReportStaff) => s.name }, { header: 'Department', value: (s) => s.department ?? '' }, { header: 'Shift', value: (s) => s.shift ?? '' },
    { header: 'Work days', value: (s) => s.work_days }, { header: 'Present', value: (s) => s.present }, { header: 'Late', value: (s) => s.late },
    { header: 'Half day', value: (s) => s.half_day }, { header: 'Absent', value: (s) => s.absent }, { header: 'Leave', value: (s) => s.leave },
    { header: 'Holiday', value: (s) => s.holiday }, { header: 'Late minutes', value: (s) => s.late_minutes }, { header: 'Hours worked', value: (s) => (s.worked_minutes / 60).toFixed(1) },
    { header: 'Attendance %', value: (s) => s.rate ?? '' },
  ])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
        <Button size="sm" variant="outline" className="ml-auto" onClick={exportCsv} disabled={!report.data}><Download /> CSV</Button>
      </div>
      {report.isLoading ? <LoadingState /> : report.error ? <ErrorState error={report.error} onRetry={() => report.refetch()} />
        : !report.data?.staff.length ? <EmptyState title="No staff" description="Add staff under User & Role." /> : (
          <Card className="gap-0 overflow-x-auto p-0">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-right [&>th]:font-medium">
                  <th className="!text-left">Staff</th><th>Work days</th><th>Present</th><th>Late</th><th>Half day</th><th>Absent</th><th>Leave</th><th>Late time</th><th>Hours</th><th>Attendance</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.data.staff.map((s) => (
                  <Fragment key={s.profile_id}>
                    <tr onClick={() => setOpen(open === s.profile_id ? null : s.profile_id)} className="cursor-pointer hover:bg-muted/40 [&>td]:px-3 [&>td]:py-2 [&>td]:text-right [&>td]:tabular-nums">
                      <td className="!text-left"><p className="font-medium">{s.name}</p><p className="text-xs text-muted-foreground">{[s.department, s.shift].filter(Boolean).join(' · ') || '—'}</p></td>
                      <td>{s.work_days}</td><td>{s.present}</td>
                      <td className={cn(s.late > 0 && 'text-amber-600')}>{s.late}</td><td>{s.half_day}</td>
                      <td className={cn(s.absent > 0 && 'font-medium text-red-600')}>{s.absent}</td><td>{s.leave}</td>
                      <td>{minutesLabel(s.late_minutes)}</td><td>{(s.worked_minutes / 60).toFixed(1)}</td>
                      <td>{s.rate === null ? '—' : <span className={cn('font-medium', s.rate >= 90 ? 'text-emerald-600' : s.rate >= 75 ? 'text-amber-600' : 'text-red-600')}>{s.rate}%</span>}</td>
                    </tr>
                    {open === s.profile_id && (
                      <tr><td colSpan={10} className="bg-muted/30 px-3 py-2">
                        {days.length === 0 ? <p className="text-xs text-muted-foreground">No attendance recorded in this period.</p> : (
                          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                            {days.map((x) => (
                              <div key={x.date} className="flex items-center justify-between gap-2 rounded-md bg-card px-2 py-1 text-xs">
                                <span className="font-medium">{formatShortDate(x.date)}</span>
                                <span className="text-muted-foreground tabular-nums">{zonedTime(x.check_in_at, tz)} – {zonedTime(x.check_out_at, tz)}</span>
                                <Badge variant={ATTENDANCE[x.status].variant} className="text-[10px]">{ATTENDANCE[x.status].label}{x.late_minutes ? ` ${minutesLabel(x.late_minutes)}` : ''}</Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>
        )}
    </div>
  )
}

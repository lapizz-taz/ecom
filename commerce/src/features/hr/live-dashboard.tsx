import { useQuery } from '@tanstack/react-query'
import { Activity, BarChart3, Coffee, Inbox, LogIn, LogOut, RefreshCw, ShieldCheck, Timer, UserCheck, Users, UserX } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DatePicker } from '@/components/ui/date-picker'
import { useNow } from '@/features/hr/workday'
import { initials, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { LIVE, type LiveDashboard, liveDashboard, minutesLabel, zonedIso, zonedTime } from '@/services/hr'

const EVENT: Record<LiveDashboard['events'][number]['kind'], { label: string; icon: typeof LogIn; tone: string }> = {
  in: { label: 'checked in', icon: LogIn, tone: 'text-emerald-600' },
  out: { label: 'checked out', icon: LogOut, tone: 'text-sky-600' },
  auto_out: { label: 'was checked out automatically', icon: LogOut, tone: 'text-sky-600' },
  break: { label: 'started a break', icon: Coffee, tone: 'text-amber-600' },
  idle: { label: 'went idle (auto break)', icon: Timer, tone: 'text-zinc-500' },
  back: { label: 'is back from a break', icon: Activity, tone: 'text-primary' },
}

/** The HR dashboard: who is working, on a break or away right now, refreshed every minute. */
export function LiveDashboardView() {
  const [date, setDate] = useState('')
  const [tab, setTab] = useState<'team' | 'timeline' | 'activity'>('team')
  const q = useQuery({ queryKey: ['hr', 'live', date], queryFn: () => liveDashboard(date || undefined), refetchInterval: date ? false : 60_000 })
  if (q.isLoading) return <LoadingState />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const t = d.tiles
  const rate = t.expected ? Math.round((100 * (t.present + t.left)) / t.expected) : 0
  const tiles = [
    { label: 'Total', value: t.total, icon: Users },
    { label: 'Present', value: t.present, icon: UserCheck, tone: 'text-emerald-600', hint: t.idle ? `${t.idle} idle` : undefined },
    { label: 'Not in', value: t.not_in, icon: UserX, tone: t.not_in ? 'text-red-600' : undefined },
    { label: 'Left', value: t.left, icon: LogOut },
    { label: 'On break', value: t.on_break, icon: Coffee, tone: t.on_break ? 'text-amber-600' : undefined },
    { label: 'Open orders', value: t.open_orders, icon: Inbox, hint: 'assigned to people at work' },
  ]
  return (
    <div className="space-y-4">
      <Card className="relative gap-0 overflow-hidden p-0">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/80 via-primary to-primary/40" />
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 pt-5">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-primary uppercase">
              <Activity className="size-3" /> Workforce command center
            </span>
            <p className="mt-2 text-xl font-semibold">Live dashboard</p>
            <p className="text-sm text-muted-foreground">Attendance, active work, breaks and recent activity in one view.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DatePicker value={date || d.date} max={d.date} onChange={(v) => setDate(v === d.date ? '' : v)} className="w-40" aria-label="Day" />
            <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw className={cn(q.isFetching && 'animate-spin')} /> Refresh</Button>
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x border-t">
          <div className="flex items-center gap-2 p-3"><ShieldCheck className="size-5 text-primary" /><div><p className="text-[11px] text-muted-foreground uppercase">Attendance</p><p className="font-semibold tabular-nums">{rate}%</p></div></div>
          <div className="flex items-center gap-2 p-3"><Inbox className="size-5 text-emerald-600" /><div><p className="text-[11px] text-muted-foreground uppercase">Orders / present</p><p className="font-semibold tabular-nums">{t.present ? (t.open_orders / t.present).toFixed(1) : '0.0'}</p></div></div>
          <div className="flex items-center gap-2 p-3"><RefreshCw className="size-5 text-amber-600" /><div><p className="text-[11px] text-muted-foreground uppercase">Updated</p><p className="font-semibold tabular-nums">{zonedTime(d.now, d.tz)}</p></div></div>
        </div>
        <p className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          {date ? <>Showing {date}. <button type="button" className="underline" onClick={() => setDate('')}>Back to today</button></>
            : <><span className="size-2 animate-pulse rounded-full bg-emerald-500" /> Live · refreshes every 60 seconds</>}
          {d.pending_requests > 0 && <Link to="/admin/hr/requests" className="ml-auto"><Badge variant="warning">{d.pending_requests} request{d.pending_requests === 1 ? '' : 's'} waiting</Badge></Link>}
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((x) => (
          <Card key={x.label} className="gap-1 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground uppercase">{x.label}<x.icon className="size-4" /></div>
            <p className={cn('text-2xl font-semibold tabular-nums', x.tone)}>{x.value}</p>
            {x.hint && <p className="text-[11px] text-muted-foreground">{x.hint}</p>}
          </Card>
        ))}
      </div>

      <Card className="gap-0 p-0">
        <div className="grid grid-cols-3 gap-1 border-b p-1.5">
          {([['team', Users, 'Team'], ['timeline', BarChart3, 'Timeline'], ['activity', Activity, 'Activity']] as const).map(([k, Icon, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-label={label} aria-pressed={tab === k}
              className={cn('flex items-center justify-center gap-2 rounded-lg py-2 text-sm', tab === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              <Icon className="size-4" /> <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        {tab === 'team' ? <TeamList d={d} /> : tab === 'timeline' ? <Timeline d={d} /> : <ActivityFeed d={d} />}
      </Card>
    </div>
  )
}

function TeamList({ d }: { d: LiveDashboard }) {
  if (!d.team.length) return <p className="p-6 text-sm text-muted-foreground">No staff yet.</p>
  return (
    <ul className="divide-y">
      {d.team.map((m) => (
        <li key={m.profile_id} className="flex items-center gap-3 px-4 py-3">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {initials(m.name)}
            <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card', LIVE[m.state].dot)} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{m.name} {m.designation && <span className="font-normal text-muted-foreground">· {m.designation}</span>}</p>
            <p className="truncate text-xs text-muted-foreground">
              {LIVE[m.state].label}
              {m.state === 'ON_BREAK' && m.on_break_since && ` since ${zonedTime(m.on_break_since, d.tz)}`}
              {m.check_in_at && ` · in ${zonedTime(m.check_in_at, d.tz)}`}
              {m.check_out_at && ` · out ${zonedTime(m.check_out_at, d.tz)}${m.checkout_source === 'AUTO' ? ' (auto)' : ''}`}
              {!m.check_in_at && m.last_seen_at && ` · seen ${timeAgo(m.last_seen_at)}`}
            </p>
          </div>
          <div className="hidden text-right text-xs sm:block">
            {m.worked_minutes !== null && <p className="font-medium tabular-nums">{minutesLabel(m.worked_minutes)} net</p>}
            {m.break_minutes > 0 && <p className="text-muted-foreground tabular-nums">{minutesLabel(m.break_minutes)} break</p>}
          </div>
          {m.late_minutes > 0 && <Badge variant="warning" className="text-[10px]">{minutesLabel(m.late_minutes)} late</Badge>}
          {m.open_orders > 0 && <Badge variant="secondary" className="text-[10px] tabular-nums">{m.open_orders} open</Badge>}
        </li>
      ))}
    </ul>
  )
}

/** One bar per person from 6:00 to 24:00 (store time): work, breaks and idle time. */
function Timeline({ d }: { d: LiveDashboard }) {
  const now = useNow(60_000)
  const rows = d.team.filter((m) => m.check_in_at)
  // Minutes from the day's midnight in store time (negative before it: a night shift from the day before).
  const midnight = new Date(zonedIso(d.date, '00:00', d.tz)).getTime()
  const hm = (iso: string) => Math.round((new Date(iso).getTime() - midnight) / 60_000)
  const nowIso = new Date(now).toISOString()
  const startH = Math.floor(Math.min(6 * 60, ...rows.map((m) => hm(m.check_in_at!))) / 60)
  const endH = Math.ceil(Math.max(24 * 60, ...rows.map((m) => hm(m.check_out_at ?? nowIso))) / 60)
  const span = (endH - startH) * 60
  const pct = (min: number) => `${Math.min(100, Math.max(0, ((min - startH * 60) / span) * 100))}%`
  const width = (a: number, b: number) => `${Math.max(0.4, ((Math.max(b, a) - a) / span) * 100)}%`
  const ticks = Array.from({ length: Math.floor((endH - startH) / 3) + 1 }, (_, i) => startH + i * 3)
  return (
    <div className="space-y-3 p-4">
      <div>
        <p className="font-medium">Employee timeline</p>
        <p className="text-xs text-muted-foreground">Work, idle, break and check-out periods for {d.date}.</p>
      </div>
      {rows.length === 0 ? <p className="py-6 text-sm text-muted-foreground">Nobody checked in on this day.</p> : (
        <div className="overflow-x-auto">
          <div className="min-w-[560px] space-y-2">
            <div className="relative ml-32 h-4 text-[10px] text-muted-foreground">
              {ticks.map((h) => <span key={h} className="absolute -translate-x-1/2 tabular-nums" style={{ left: pct(h * 60) }}>{String(((h % 24) + 24) % 24).padStart(2, '0')}:00</span>)}
            </div>
            {rows.map((m) => {
              const start = hm(m.check_in_at!)
              const end = hm(m.check_out_at ?? nowIso)
              return (
                <div key={m.profile_id} className="flex items-center gap-2">
                  <span className="w-30 shrink-0 truncate text-xs font-medium">{m.name}</span>
                  <div className="relative h-6 flex-1 rounded-md bg-muted/60">
                    <div className="absolute inset-y-0 rounded-md bg-emerald-500/80" style={{ left: pct(start), width: width(start, end) }} title={`Work ${zonedTime(m.check_in_at, d.tz)} – ${m.check_out_at ? zonedTime(m.check_out_at, d.tz) : 'now'}`} />
                    {m.breaks.map((b, i) => {
                      const a = hm(b.started_at)
                      const z = hm(b.ended_at ?? nowIso)
                      return <div key={i} className={cn('absolute inset-y-0', b.kind === 'IDLE' ? 'bg-zinc-400' : 'bg-amber-500')} style={{ left: pct(a), width: width(a, z) }}
                        title={`${b.kind === 'IDLE' ? 'Idle' : 'Break'} ${zonedTime(b.started_at, d.tz)} – ${b.ended_at ? zonedTime(b.ended_at, d.tz) : 'now'}`} />
                    })}
                    {m.check_out_at && <div className="absolute inset-y-0 w-1 rounded bg-sky-500" style={{ left: pct(end) }} title={`Checked out ${zonedTime(m.check_out_at, d.tz)}`} />}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {[['bg-emerald-500', 'Working'], ['bg-amber-500', 'Break'], ['bg-zinc-400', 'Idle'], ['bg-sky-500', 'Check-out']].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1.5"><span className={cn('size-2.5 rounded-full', c)} />{l}</span>
        ))}
      </div>
    </div>
  )
}

function ActivityFeed({ d }: { d: LiveDashboard }) {
  if (!d.events.length) return <p className="p-6 text-sm text-muted-foreground">No activity on this day yet.</p>
  return (
    <ul className="divide-y">
      {d.events.map((e, i) => {
        const x = EVENT[e.kind]
        return (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <x.icon className={cn('size-4 shrink-0', x.tone)} />
            <span className="min-w-0 flex-1 truncate"><span className="font-medium">{e.name}</span> {x.label}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{zonedTime(e.at, d.tz)}</span>
          </li>
        )
      })}
    </ul>
  )
}

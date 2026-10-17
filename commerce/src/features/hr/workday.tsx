import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock, Coffee, LogIn, LogOut, Minimize2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useMyDay } from '@/features/hr/attendance'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { checkIn, checkOut, endBreak, keepWorkingToday, minutesLabel, type MyDay, startBreak, zonedTime } from '@/services/hr'

/** The current time, ticking every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t) }, [ms])
  return now
}

const openBreak = (d: MyDay | undefined) => d?.breaks.find((b) => !b.ended_at) ?? null
const isWorking = (d: MyDay | undefined) => Boolean(d?.record?.check_in_at && !d.record.check_out_at)

/** Check-in, check-out and break actions with toasts; every one refreshes HR data. */
export function useWorkdayActions() {
  const qc = useQueryClient()
  const done = () => { void qc.invalidateQueries({ queryKey: ['hr'] }) }
  const fail = (e: unknown) => toast.error((e as Error).message)
  return {
    checkIn: useMutation({ mutationFn: () => checkIn(), onSuccess: (r) => { toast.success('Checked in successfully', { description: r.late_minutes ? `${minutesLabel(r.late_minutes)} late` : 'Your attendance has been recorded' }); done() }, onError: fail }),
    checkOut: useMutation({ mutationFn: () => checkOut(), onSuccess: (r) => { toast.success('Checked out', { description: `${minutesLabel(r.worked_minutes)} of work today` }); done() }, onError: fail }),
    startBreak: useMutation({ mutationFn: () => startBreak('MANUAL'), onSuccess: () => { toast.success('Break started', { description: 'Enjoy your break!' }); done() }, onError: fail }),
    endBreak: useMutation({
      mutationFn: () => endBreak(),
      onSuccess: (r) => {
        if (r.over_limit) toast.warning('Welcome back', { description: `${minutesLabel(r.total_minutes)} of breaks today, over the ${minutesLabel(r.max_break_minutes)} limit` })
        else toast.success('Welcome back', { description: `${minutesLabel(r.minutes)} break` })
        done()
      },
      onError: fail,
    }),
    keepWorking: useMutation({ mutationFn: () => keepWorkingToday(), onSuccess: () => { toast.success('No automatic check-out today'); done() }, onError: fail }),
  }
}

// ---------------------------------------------------------------- Break screen
/** "12:04" under an hour, "1:02:04" after. */
const short = (sec: number) => {
  const t = Math.max(0, Math.floor(sec))
  const h = Math.floor(t / 3600)
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0')
  const ss = String(t % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * While on a break: a calm full-screen view with a ring that fills against today's
 * break allowance (green, then amber near the limit, red past it). It can be tucked
 * away into a small pill and brought back.
 */
function BreakOverlay({ day }: { day: MyDay }) {
  const b = openBreak(day)
  const now = useNow(1000)
  const actions = useWorkdayActions()
  const [small, setSmall] = useState(false)
  useEffect(() => { setSmall(false) }, [b?.id])
  if (!b) return null
  const secs = (now - new Date(b.started_at).getTime()) / 1000
  const closed = day.breaks.filter((x) => x.ended_at).reduce((t, x) => t + (new Date(x.ended_at!).getTime() - new Date(x.started_at).getTime()) / 1000, 0)
  const used = closed + secs
  const limit = day.rules.max_break_minutes * 60
  const share = limit > 0 ? used / limit : 0
  const over = limit > 0 && used > limit
  const tone = over ? '#ef4444' : share > 0.8 ? '#f59e0b' : '#10b981'
  const idle = b.kind === 'IDLE'
  const R = 104
  const C = 2 * Math.PI * R
  const count = day.breaks.length
  if (small) {
    return (
      <button type="button" onClick={() => setSmall(false)} aria-label="Show break timer"
        className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full border bg-card/95 py-1.5 pr-4 pl-1.5 text-sm shadow-lg backdrop-blur">
        <span className="flex size-7 items-center justify-center rounded-full" style={{ background: `${tone}22`, color: tone }}><Coffee className="size-3.5" /></span>
        <span className="font-medium">{idle ? 'Away' : 'On break'}</span>
        <span className="font-mono tabular-nums" style={{ color: tone }}>{short(secs)}</span>
      </button>
    )
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="break-title">
      <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <span className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span className="size-1.5 animate-pulse rounded-full" style={{ background: tone }} /> {idle ? 'Auto break' : 'Break'} · since {zonedTime(b.started_at, day.tz)}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setSmall(true)}><Minimize2 /> Minimize</Button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <div className="relative flex size-64 items-center justify-center">
          <span className="absolute inset-6 rounded-full opacity-25 blur-2xl motion-safe:animate-[pulse_4s_ease-in-out_infinite]" style={{ background: tone }} />
          <svg viewBox="0 0 240 240" className="absolute inset-0 -rotate-90" aria-hidden>
            <circle cx="120" cy="120" r={R} fill="none" strokeWidth="10" className="stroke-muted" />
            <circle cx="120" cy="120" r={R} fill="none" strokeWidth="10" strokeLinecap="round" stroke={tone}
              strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, share))} className="transition-[stroke-dashoffset] duration-1000 ease-linear" />
          </svg>
          <div className="relative text-center">
            <p id="break-title" className="text-sm text-muted-foreground">{idle ? 'You were away' : 'On a break'}</p>
            <p className="font-mono text-5xl font-semibold tracking-tight tabular-nums">{short(secs)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{limit ? `${minutesLabel(Math.floor(used / 60))} of ${minutesLabel(day.rules.max_break_minutes)} today` : 'No daily limit'}</p>
          </div>
        </div>

        <div className="grid w-full max-w-sm grid-cols-3 divide-x rounded-2xl border bg-card text-center">
          <div className="px-2 py-3"><p className="text-[11px] text-muted-foreground">Started</p><p className="text-sm font-semibold tabular-nums">{zonedTime(b.started_at, day.tz)}</p></div>
          <div className="px-2 py-3"><p className="text-[11px] text-muted-foreground">Breaks today</p><p className="text-sm font-semibold tabular-nums">{count}</p></div>
          <div className="px-2 py-3"><p className="text-[11px] text-muted-foreground">{over ? 'Over by' : 'Left'}</p>
            <p className="text-sm font-semibold tabular-nums" style={{ color: over ? tone : undefined }}>{limit ? minutesLabel(Math.ceil(Math.abs(limit - used) / 60)) : '—'}</p></div>
        </div>

        <p className="max-w-xs text-center text-sm text-muted-foreground">
          {idle ? `No activity for ${day.rules.auto_break_after} minutes, so this break started on its own. Tap below when you’re back.`
            : over ? 'You’re past today’s break allowance. HR sees break time in the report.' : 'Take your time. Your break is being recorded.'}
        </p>
      </div>

      <div className="mx-auto w-full max-w-sm space-y-2 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <Button size="lg" className="h-12 w-full text-base" onClick={() => actions.endBreak.mutate()} disabled={actions.endBreak.isPending}>
          {actions.endBreak.isPending ? <Spinner /> : <LogIn />} I’m back
        </Button>
        {day.rules.block_during_breaks && day.rules.require_check_in && <p className="text-center text-[11px] text-muted-foreground">Work pages open again when the break ends.</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Idle watcher
const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const

/**
 * Automatic break: after `idle_warning_at` minutes without input, a warning; if nothing
 * happens by `auto_break_after` minutes, an IDLE break starts (recorded by the server).
 */
function IdleWatcher({ day }: { day: MyDay }) {
  const qc = useQueryClient()
  const last = useRef(Date.now())
  const sent = useRef(false)
  const [warn, setWarn] = useState(false)
  const now = useNow(5000)
  const enabled = day.rules.auto_break && isWorking(day) && !openBreak(day)
  useEffect(() => {
    if (!enabled) return
    last.current = Date.now()
    sent.current = false
    const mark = () => { last.current = Date.now(); setWarn(false) }
    ACTIVITY.forEach((e) => window.addEventListener(e, mark, { passive: true }))
    return () => ACTIVITY.forEach((e) => window.removeEventListener(e, mark))
  }, [enabled])
  const idleMin = (now - last.current) / 60_000
  useEffect(() => {
    if (!enabled) { setWarn(false); return }
    if (idleMin >= day.rules.auto_break_after && !sent.current) {
      sent.current = true
      setWarn(false)
      void startBreak('IDLE').then(() => qc.invalidateQueries({ queryKey: ['hr'] }), () => { sent.current = false })
    } else if (idleMin >= day.rules.idle_warning_at) {
      setWarn(true)
    }
  }, [enabled, idleMin, day.rules.auto_break_after, day.rules.idle_warning_at, qc])
  if (!warn || !enabled) return null
  const left = Math.max(0, Math.ceil(day.rules.auto_break_after - idleMin))
  return (
    <Dialog open onOpenChange={() => { last.current = Date.now(); setWarn(false) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Are you still there?</DialogTitle>
          <DialogDescription>No activity for {Math.floor(idleMin)} minutes. A break starts automatically in about {left} minute{left === 1 ? '' : 's'}.</DialogDescription>
        </DialogHeader>
        <DialogFooter><Button onClick={() => { last.current = Date.now(); setWarn(false) }}>I’m here</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Automatic check-out notice
/** Ten minutes before the automatic check-out: keep working today, or check out now. */
function AutoCheckoutNotice({ day }: { day: MyDay }) {
  const now = useNow(15_000)
  const actions = useWorkdayActions()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const end = day.scheduled_end ? new Date(day.scheduled_end).getTime() : null
  const show = day.rules.auto_checkout && isWorking(day) && !day.record?.keep_open_today && end !== null
    && now >= end - 10 * 60_000 && dismissed !== day.record?.id
  if (!show) return null
  const mins = Math.max(0, Math.ceil((end! - now) / 60_000))
  return (
    <Dialog open onOpenChange={() => setDismissed(day.record?.id ?? null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clock className="size-4" /> Check-out {mins > 0 ? `in ${mins} min` : 'now'}</DialogTitle>
          <DialogDescription>Your day ends at {zonedTime(day.scheduled_end, day.tz)}. You’ll be checked out automatically then; your hours stay recorded.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => actions.keepWorking.mutate()} disabled={actions.keepWorking.isPending}>Keep working today</Button>
          <Button onClick={() => actions.checkOut.mutate()} disabled={actions.checkOut.isPending}><LogOut /> Check out now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Mounted once in the admin layout. */
export function WorkdayLayer() {
  const me = useMyDay()
  const d = me.data
  if (!d) return null
  return (
    <>
      <BreakOverlay day={d} />
      <IdleWatcher day={d} />
      <AutoCheckoutNotice day={d} />
    </>
  )
}

// ---------------------------------------------------------------- Work gate
/** Sections where the attendance rule applies (the database enforces it on every change there). */
const WORK_SECTIONS = ['orders', 'search', 'scan', 'inventory', 'products', 'customers', 'couriers', 'courier-management', 'courier-invoices',
  'labels', 'label-builder', 'purchases', 'production']

export function isWorkSection(pathname: string) {
  const section = pathname.replace(/^\/admin\/?/, '').split('/')[0]
  return WORK_SECTIONS.includes(section)
}

/** On work pages, people who must check in (or are on a break) see this instead of the page. */
export function WorkGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const me = useMyDay()
  const actions = useWorkdayActions()
  const gate = me.data?.gate
  if (!isWorkSection(pathname) || !gate) return <>{children}</>
  const onBreak = gate === 'ON_BREAK'
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md items-center gap-3 p-8 text-center">
        <span className={cn('flex size-14 items-center justify-center rounded-2xl', onBreak ? 'bg-amber-500/15 text-amber-600' : 'bg-primary/10 text-primary')}>
          {onBreak ? <Coffee className="size-7" /> : <LogIn className="size-7" />}
        </span>
        <p className="text-lg font-semibold">{onBreak ? 'You’re on a break' : 'Check in to start work'}</p>
        <p className="text-sm text-muted-foreground">
          {onBreak ? 'Work pages open again when your break ends.' : 'Your store asks staff to check in before working on orders, stock and customers.'}
        </p>
        {onBreak ? (
          <Button size="lg" onClick={() => actions.endBreak.mutate()} disabled={actions.endBreak.isPending}>{actions.endBreak.isPending ? <Spinner /> : <Coffee />} End break</Button>
        ) : me.data?.self_check_in ? (
          <Button size="lg" onClick={() => actions.checkIn.mutate()} disabled={actions.checkIn.isPending}>{actions.checkIn.isPending ? <Spinner /> : <LogIn />} Check in</Button>
        ) : <p className="text-xs text-muted-foreground">Ask HR to record your check-in.</p>}
        <Button variant="link" size="sm" asChild><Link to="/admin/hr/attendance">Open my attendance</Link></Button>
      </Card>
    </div>
  )
}

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
import { checkIn, checkOut, clock, endBreak, keepWorkingToday, minutesLabel, type MyDay, startBreak, zonedTime } from '@/services/hr'

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

// ---------------------------------------------------------------- Break overlay
/** While on a break: a full-screen card with the running timer, which can be shrunk to a pill. */
function BreakOverlay({ day }: { day: MyDay }) {
  const b = openBreak(day)
  const now = useNow(1000)
  const actions = useWorkdayActions()
  const [small, setSmall] = useState(false)
  useEffect(() => { setSmall(false) }, [b?.id])
  if (!b) return null
  const secs = (now - new Date(b.started_at).getTime()) / 1000
  const limit = day.rules.max_break_minutes * 60
  const closed = day.breaks.filter((x) => x.ended_at).reduce((t, x) => t + (new Date(x.ended_at!).getTime() - new Date(x.started_at).getTime()) / 1000, 0)
  const used = closed + secs
  const over = limit > 0 && used > limit
  if (small) {
    return (
      <button type="button" onClick={() => setSmall(false)}
        className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-lg">
        <Coffee className="size-4" /> {b.kind === 'IDLE' ? 'Away' : 'On break'} <span className="tabular-nums">{clock(secs)}</span>
      </button>
    )
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="break-title">
      <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-amber-500/30 p-6 text-center text-white shadow-2xl"
        style={{ background: 'radial-gradient(120% 70% at 50% 0%, #78350f 0%, #1c1206 55%, #0c0a09 100%)' }}>
        <button type="button" onClick={() => setSmall(true)} className="absolute top-3 right-3 rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Shrink">
          <Minimize2 className="size-4" />
        </button>
        <div className="mx-auto mb-4 flex size-20 items-center justify-center rounded-full bg-gradient-to-b from-amber-400 to-orange-500 shadow-[0_0_40px_rgba(245,158,11,.45)]">
          <Coffee className="size-9" />
        </div>
        <p id="break-title" className="text-lg font-semibold">{b.kind === 'IDLE' ? 'You were away' : 'You’re taking a break'}</p>
        <p className="mt-1 text-xs text-white/60">{b.kind === 'IDLE' ? `No activity for ${day.rules.auto_break_after} minutes, so a break started automatically.` : `Started at ${zonedTime(b.started_at, day.tz)}`}</p>
        <div className="mx-auto mt-5 w-fit rounded-2xl border border-white/10 bg-black/40 px-6 py-3 font-mono text-4xl font-semibold tracking-wider text-amber-400 tabular-nums">{clock(secs)}</div>
        <p className={cn('mt-3 text-xs', over ? 'text-red-300' : 'text-white/70')}>
          {over ? `Over today’s ${minutesLabel(day.rules.max_break_minutes)} break limit` : 'Enjoy your break! Your time is being tracked.'}
        </p>
        <Button className="mt-5 w-full bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:from-amber-500 hover:to-orange-500" size="lg"
          onClick={() => actions.endBreak.mutate()} disabled={actions.endBreak.isPending}>
          {actions.endBreak.isPending ? <Spinner /> : <Coffee />} End break
        </Button>
        {day.rules.block_during_breaks && day.rules.require_check_in && <p className="mt-3 text-[11px] text-white/50">Work pages open again when the break ends.</p>}
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

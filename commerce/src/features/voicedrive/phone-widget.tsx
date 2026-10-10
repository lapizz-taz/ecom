import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Delete, Grip, GripVertical, History, Mic, MicOff, Minus, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Power, RotateCcw, SlidersHorizontal, UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CALL_STATUS, durationLabel, LINE_PROBLEM, OUTCOMES, pbx, REJECT_REASON, type CallOutcome, type CallRecord } from '@/services/voicedrive'
import { CallerPanel } from './caller-panel'
import { usePhone } from './phone-context'
import { clampPosition, combineRepeated, DEFAULT_POSITION, setPhoneSettings, usePhoneSettings } from './phone-settings'
import type { PhoneState } from './softphone'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']
type Panel = 'dialer' | 'recent' | null

function useTicker(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

const dot = (s: PhoneState) =>
  s.status === 'ready' ? (s.availability === 'AVAILABLE' ? 'bg-emerald-500' : 'bg-amber-500')
    : s.status === 'starting' || s.status === 'reconnecting' ? 'bg-amber-500 animate-pulse'
      : s.status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/50'

const statusText = (s: PhoneState) =>
  s.status === 'ready' ? (s.availability === 'AVAILABLE' ? 'Ready for calls' : 'Away — incoming calls go to others')
    : s.status === 'starting' ? 'Connecting…'
      : s.status === 'reconnecting' ? 'PBX server connection is retrying. Try again in a few seconds.'
        : s.status === 'error' ? s.error ?? 'The phone could not connect'
          : 'Phone off'

const isMissed = (c: CallRecord) => c.direction === 'INBOUND' && ['NO_ANSWER', 'REJECTED', 'BUSY', 'FAILED'].includes(c.status)

/** The phone, on every admin page: a small bar that can be dragged anywhere, with dialer, recent calls and the live call. */
export function PhoneWidget() {
  const { engine, state } = usePhone()
  const settings = usePhoneSettings()
  const [panel, setPanel] = useState<Panel>(null)
  const call = state?.call ?? null
  const live = !!call && call.state !== 'ended'
  const ringing = call?.state === 'incoming'
  const bar = useRef<HTMLDivElement>(null)

  // Ring sound follows the setting.
  useEffect(() => { if (engine) engine.ringSound = settings.ringSound }, [engine, settings.ringSound])

  // A call always brings the phone back up.
  const callState = call?.state
  useEffect(() => { if (callState && callState !== 'ended' && settings.minimized) setPhoneSettings({ minimized: false }) }, [callState, settings.minimized])

  // Desktop notification for an incoming call while this tab is in the background.
  useEffect(() => {
    if (!ringing || !settings.desktopNotifications || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return
    const n = new Notification('Incoming call', { body: call?.number ?? 'Unknown number', tag: 'vd-incoming', requireInteraction: true })
    n.onclick = () => { window.focus(); n.close() }
    return () => n.close()
  }, [ringing, settings.desktopNotifications, call?.number])

  const recent = useQuery({
    queryKey: ['vd-recent-calls'],
    queryFn: () => pbx.getMyRecentCalls(40),
    enabled: !!engine,
    refetchInterval: panel === 'recent' ? 10_000 : 60_000,
  })
  const refetchRecent = recent.refetch
  useEffect(() => { if (callState === 'ended') void refetchRecent() }, [callState, refetchRecent])
  const missed = (recent.data?.items ?? []).filter((c) => isMissed(c) && !c.calledBack && Date.parse(c.createdAt) > Date.now() - 86_400_000).length

  // Keep the bar inside the window.
  const pos = settings.position
  const fit = useCallback(() => {
    const el = bar.current
    if (!el) return
    const next = clampPosition(pos, el.offsetWidth, el.offsetHeight)
    if (next.right !== pos.right || next.bottom !== pos.bottom) setPhoneSettings({ position: next })
  }, [pos])
  useLayoutEffect(() => { fit() }, [fit, settings.minimized])
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit) }, [fit])

  // Drag anywhere on the bar that is not a button.
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null)
  const [dragPos, setDragPos] = useState<{ right: number; bottom: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    drag.current = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || !bar.current) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    setDragPos(clampPosition({ right: d.right - dx, bottom: d.bottom - dy }, bar.current.offsetWidth, bar.current.offsetHeight))
  }
  const onPointerUp = () => {
    if (drag.current?.moved && dragPos) setPhoneSettings({ position: dragPos })
    drag.current = null
    setDragPos(null)
  }

  if (!engine || !state) return null
  const at = dragPos ?? pos
  const showPanel = !!call || panel !== null

  if (settings.minimized && !live) {
    return (
      <div ref={bar} style={{ right: at.right, bottom: at.bottom }} className="no-print fixed z-40">
        <button type="button" onClick={() => setPhoneSettings({ minimized: false })} aria-label="Open the phone"
          className="relative flex size-12 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-lg hover:bg-accent">
          <Phone className="size-5" />
          <span className={cn('absolute top-1 right-1 size-2.5 rounded-full ring-2 ring-popover', dot(state))} aria-hidden />
          {missed > 0 && <span className="absolute -top-1 -left-1 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{missed}</span>}
        </button>
      </div>
    )
  }

  return (
    <div ref={bar} style={{ right: at.right, bottom: at.bottom }} className="no-print fixed z-40 flex w-[min(380px,calc(100vw-1rem))] flex-col items-stretch gap-2">
      {showPanel && (
        <div className="max-h-[min(70dvh,560px)] overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl" role="dialog" aria-label="VoiceDrive phone">
          {call ? <CallView key={call.callId ?? call.startedAt} state={state} autoShow={settings.autoShowCustomer} />
            : state.status !== 'ready' ? <PhoneOffPanel state={state} onStart={() => void engine.start()} />
              : panel === 'recent' ? <RecentCalls items={recent.data?.items ?? []} loading={recent.isLoading} combine={settings.combineRepeated} onDialed={() => setPanel(null)} />
                : <Dialer onDone={() => setPanel(null)} />}
        </div>
      )}

      <div onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        className={cn('flex touch-none items-center gap-1.5 rounded-xl border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg select-none',
          ringing && 'ring-2 ring-emerald-500', dragPos && 'cursor-grabbing')}>
        <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
        <span className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-lg', live ? 'bg-emerald-600 text-white' : 'bg-muted')}>
          {ringing ? <PhoneIncoming className="size-4 animate-pulse" /> : <Phone className="size-4" />}
          <span className={cn('absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-popover', dot(state))} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm leading-tight font-semibold whitespace-nowrap">
            PBX Phone
            {state.extension && <span className="text-xs font-normal text-muted-foreground tabular-nums">{state.extension}</span>}
            {missed > 0 && (
              <button type="button" onClick={() => setPanel('recent')} className="shrink-0 rounded-full bg-red-600 px-1.5 py-px text-[10px] font-semibold whitespace-nowrap text-white">{missed} Missed</button>
            )}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground" title={statusText(state)}>
            {live ? `${call!.direction === 'in' ? 'Incoming' : 'Outgoing'} · ${call!.number}` : statusText(state)}
          </p>
        </div>
        <SettingsButton />
        <BarButton label="Dialpad" active={panel === 'dialer' && !call} onClick={() => setPanel(panel === 'dialer' ? null : 'dialer')}><Grip className="size-4" /></BarButton>
        <BarButton label="Recent calls" active={panel === 'recent' && !call} onClick={() => setPanel(panel === 'recent' ? null : 'recent')}><History className="size-4" /></BarButton>
        <BarButton label="Minimise" disabled={live} onClick={() => { setPanel(null); setPhoneSettings({ minimized: true }) }}><Minus className="size-4" /></BarButton>
      </div>
    </div>
  )
}

function BarButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className={cn('rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40', active && 'bg-accent text-foreground')}>
      {children}
    </button>
  )
}

function SettingRow({ icon, title, hint, checked, onChange }: { icon: ReactNode; title: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  )
}

function SettingsButton() {
  const s = usePhoneSettings()
  const notifications = async (on: boolean) => {
    if (!on) return setPhoneSettings({ desktopNotifications: false })
    if (typeof Notification === 'undefined') return toast.error('This browser cannot show notifications')
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') return toast.error('Notifications are blocked for this site — allow them in the browser settings')
    setPhoneSettings({ desktopNotifications: true })
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Phone settings" title="Phone settings" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <SlidersHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80">
        <p className="text-sm font-semibold">Phone settings</p>
        <p className="mb-2 text-xs text-muted-foreground">Saved in this browser</p>
        <SettingRow icon={<UserRound className="size-4" />} title="Auto-show customer details" hint="On incoming and outgoing calls"
          checked={s.autoShowCustomer} onChange={(v) => setPhoneSettings({ autoShowCustomer: v })} />
        <SettingRow icon={<PhoneIncoming className="size-4" />} title="Ring sound" hint="Ring while a call is waiting"
          checked={s.ringSound} onChange={(v) => setPhoneSettings({ ringSound: v })} />
        <SettingRow icon={<History className="size-4" />} title="Combine repeated calls" hint="Same number, status and direction"
          checked={s.combineRepeated} onChange={(v) => setPhoneSettings({ combineRepeated: v })} />
        <SettingRow icon={<PhoneMissed className="size-4" />} title="Desktop notifications" hint="When a call comes in on another tab"
          checked={s.desktopNotifications} onChange={(v) => void notifications(v)} />
        <button type="button" onClick={() => { setPhoneSettings({ position: DEFAULT_POSITION }); toast.success('Phone moved back to the corner') }}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
          <RotateCcw className="size-4" /> Reset phone position
        </button>
      </PopoverContent>
    </Popover>
  )
}

function PhoneOffPanel({ state, onStart }: { state: PhoneState; onStart: () => void }) {
  const ov = useQuery({ queryKey: ['vd-overview'], queryFn: () => pbx.overview(), staleTime: 30_000 })
  const problems = ov.data?.lineProblems ?? []
  return (
    <div className="space-y-3 text-sm">
      {state.error && state.status === 'error' && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-300">{state.error}</p>}
      {problems.length > 0 ? (
        <div className="space-y-1 text-xs">
          <p className="font-medium">The line is not active yet</p>
          <ul className="list-disc pl-4 text-muted-foreground">{problems.map((p) => <li key={p}>{LINE_PROBLEM[p]}</li>)}</ul>
        </div>
      ) : (
        <p className="text-muted-foreground">Start the phone to make and receive calls here. The microphone is used only during calls.</p>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={state.status === 'starting' || state.status === 'reconnecting' || problems.length > 0} onClick={onStart}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Power className="size-4" /> {state.status === 'starting' ? 'Starting…' : 'Start phone'}
        </button>
        <Link to="/admin/settings/voicedrive-pbx?tab=setup" className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-accent">My setup</Link>
      </div>
    </div>
  )
}

function Dialer({ onDone }: { onDone: () => void }) {
  const { dial } = usePhone()
  const [number, setNumber] = useState('')
  const go = useMutation({ mutationFn: () => dial({ phone: number }), onSuccess: onDone, onError: (e) => toast.error((e as Error).message) })
  const valid = /^(\+?880|0)1[3-9]\d{8}$|^0\d{9,11}$/.test(number.replace(/[\s-]/g, ''))
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md border px-2">
        <input value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d+*#\s-]/g, ''))} inputMode="tel" placeholder="01XXXXXXXXX" autoFocus
          aria-label="Number to call" className="h-10 min-w-0 flex-1 bg-transparent text-lg tracking-wider tabular-nums outline-none placeholder:text-muted-foreground/60"
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) go.mutate() }} />
        {number && <button type="button" aria-label="Delete" onClick={() => setNumber(number.slice(0, -1))} className="text-muted-foreground hover:text-foreground"><Delete className="size-4" /></button>}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {KEYS.map((k) => (
          <button key={k} type="button" onClick={() => setNumber((n) => n + k)} className="h-9 rounded-md bg-muted font-medium hover:bg-accent">{k}</button>
        ))}
      </div>
      <button type="button" disabled={!valid || go.isPending} onClick={() => go.mutate()}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
        <PhoneOutgoing className="size-4" /> {go.isPending ? 'Calling…' : 'Call'}
      </button>
    </div>
  )
}

function RecentCalls({ items, loading, combine, onDialed }: { items: CallRecord[]; loading: boolean; combine: boolean; onDialed: () => void }) {
  const { dial } = usePhone()
  const back = useMutation({
    mutationFn: (c: CallRecord) => dial({ phone: c.customerPhone ?? '', callbackOf: isMissed(c) ? c.id : undefined }),
    onSuccess: onDialed, onError: (e) => toast.error((e as Error).message),
  })
  const rows = combine ? combineRepeated(items) : items.map((c) => ({ ...c, repeat: 1 }))
  if (loading) return <p className="text-xs text-muted-foreground">Loading calls…</p>
  if (!rows.length) return <p className="py-4 text-center text-xs text-muted-foreground">No calls in the last 7 days.</p>
  return (
    <ul className="-my-1 divide-y">
      {rows.map((c) => {
        const missed = isMissed(c)
        const Icon = missed ? PhoneMissed : c.direction === 'INBOUND' ? PhoneIncoming : PhoneOutgoing
        return (
          <li key={c.id} className="flex items-center gap-2 py-1.5">
            <Icon className={cn('size-4 shrink-0', missed ? 'text-red-500' : 'text-muted-foreground')} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm tabular-nums">{c.customerPhone ?? 'Unknown'}{c.repeat > 1 && <span className="text-xs text-muted-foreground"> ×{c.repeat}</span>}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {CALL_STATUS[c.status]?.label ?? c.status}{c.orderNumber ? ` · ${c.orderNumber}` : ''}{c.calledBack ? ' · called back' : ''} · {timeAgo(c.createdAt)}
              </p>
            </div>
            {c.customerPhone && (
              <button type="button" disabled={back.isPending} onClick={() => back.mutate(c)} aria-label={`Call ${c.customerPhone}`}
                className="rounded-md p-1.5 text-emerald-600 hover:bg-accent disabled:opacity-40"><Phone className="size-4" /></button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function CallView({ state, autoShow }: { state: PhoneState; autoShow: boolean }) {
  const { engine } = usePhone()
  const call = state.call!
  const [keypad, setKeypad] = useState(false)
  const [details, setDetails] = useState(autoShow)
  const [outcome, setOutcome] = useState<CallOutcome | null>(null)
  const [note, setNote] = useState('')
  const now = useTicker(call.state === 'active')
  const server = useQuery({
    queryKey: ['vd-call-state', call.callId],
    queryFn: () => pbx.getManualCallState(call.callId!),
    enabled: !!call.callId,
    refetchInterval: (q) => (q.state.data && ['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'REJECTED'].includes(q.state.data.status) && call.state === 'ended' ? false : 2_000),
  })
  const save = useMutation({
    mutationFn: () => pbx.endWebOrderCall(call.callId!, outcome, note),
    onSuccess: () => { toast.success('Saved'); engine?.dismiss() },
    onError: (e) => toast.error((e as Error).message),
  })
  const s = server.data
  const elapsed = call.answeredAt ? Math.floor(((call.endedAt ?? now) - call.answeredAt) / 1000) : 0
  const label = call.state === 'incoming' ? 'Incoming call' : call.state === 'dialing' ? 'Calling…' : call.state === 'ringing' ? 'Ringing…'
    : call.state === 'active' ? (call.direction === 'in' ? 'Incoming' : 'Outgoing') : 'Call ended'

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
          <p className="truncate text-xl font-semibold tabular-nums">{call.number}</p>
          {s && call.state === 'ended' && (
            <p className="text-xs text-muted-foreground">
              {CALL_STATUS[s.status]?.label ?? s.status}{s.rejectReason ? ` — ${REJECT_REASON[s.rejectReason] ?? s.rejectReason}` : ''}
              {s.billedSeconds ? ` · ${durationLabel(s.billedSeconds)} billed` : ''}{s.chargedTk ? ` · ${Number(s.chargedTk).toFixed(2)} tk` : ''}
            </p>
          )}
        </div>
        {call.state === 'active' && <span className="font-mono text-sm text-emerald-600">{durationLabel(elapsed)}</span>}
      </div>

      {call.state === 'incoming' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void engine?.decline()} className="flex h-9 items-center justify-center gap-2 rounded-md bg-red-600 text-sm font-medium text-white hover:bg-red-500"><PhoneOff className="size-4" /> Decline</button>
          <button type="button" onClick={() => void engine?.answer()} className="flex h-9 items-center justify-center gap-2 rounded-md bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500"><Phone className="size-4" /> Answer</button>
        </div>
      )}

      {(call.state === 'active' || call.state === 'dialing' || call.state === 'ringing') && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <button type="button" disabled={call.state !== 'active'} onClick={() => engine?.mute(!call.muted)}
              className={cn('flex h-9 items-center justify-center gap-1.5 rounded-md text-sm hover:bg-accent disabled:opacity-40', call.muted ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-muted')}>
              {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />} {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" disabled={call.state !== 'active'} onClick={() => setKeypad((k) => !k)}
              className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-muted text-sm hover:bg-accent disabled:opacity-40"><Grip className="size-4" /> Keypad</button>
            <button type="button" onClick={() => void engine?.hangup()} className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-red-600 text-sm font-medium text-white hover:bg-red-500"><PhoneOff className="size-4" /> End</button>
          </div>
          {keypad && (
            <div className="grid grid-cols-3 gap-1.5">
              {KEYS.map((k) => <button key={k} type="button" onClick={() => engine?.sendDtmf(k)} className="h-8 rounded-md bg-muted font-medium hover:bg-accent">{k}</button>)}
            </div>
          )}
        </>
      )}

      {call.state === 'ended' && call.callId && (
        <div className="space-y-2 rounded-md border p-2.5">
          <p className="text-xs font-medium">What happened?</p>
          <div className="flex flex-wrap gap-1">
            {OUTCOMES.map((o) => (
              <button key={o.value} type="button" onClick={() => setOutcome(o.value)}
                className={cn('rounded-full border px-2 py-0.5 text-xs', outcome === o.value ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'hover:bg-accent')}>
                {o.label}
              </button>
            ))}
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Note (optional)" aria-label="Call note"
            className="w-full rounded-md border bg-transparent p-2 text-sm outline-none placeholder:text-muted-foreground/60" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => engine?.dismiss()} className="rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-accent">Skip</button>
            <button type="button" disabled={save.isPending || (!outcome && !note.trim())} onClick={() => save.mutate()}
              className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">Save</button>
          </div>
        </div>
      )}
      {call.state === 'ended' && !call.callId && (
        <div className="flex justify-end"><button type="button" onClick={() => engine?.dismiss()} className="rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-accent">Close</button></div>
      )}

      {/* The caller's details: open by default when "Auto-show customer details" is on. */}
      {call.number && call.number !== 'Unknown' && (
        details
          ? <CallerPanel phone={s?.normalizedCustomerPhone ?? call.number} compact={call.state !== 'incoming'} />
          : <button type="button" onClick={() => setDetails(true)} className="flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs hover:bg-accent"><UserRound className="size-3.5" /> Customer details</button>
      )}
    </div>
  )
}

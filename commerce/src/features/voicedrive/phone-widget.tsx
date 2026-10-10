import { useMutation, useQuery } from '@tanstack/react-query'
import { Delete, Grip, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, PhoneOutgoing, Power, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CALL_STATUS, durationLabel, LINE_PROBLEM, OUTCOMES, pbx, REJECT_REASON, type CallOutcome } from '@/services/voicedrive'
import { CallerPanel } from './caller-panel'
import { usePhone } from './phone-context'
import type { PhoneState } from './softphone'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

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
  s.status === 'ready' ? (s.availability === 'AVAILABLE' ? 'bg-emerald-400' : 'bg-amber-400')
    : s.status === 'starting' || s.status === 'reconnecting' ? 'bg-amber-400 animate-pulse'
      : s.status === 'error' ? 'bg-red-500' : 'bg-zinc-500'

const statusText = (s: PhoneState) =>
  s.status === 'ready' ? (s.availability === 'AVAILABLE' ? 'Ready · প্রস্তুত' : 'Away · দূরে')
    : s.status === 'starting' ? 'Connecting… · সংযোগ হচ্ছে'
      : s.status === 'reconnecting' ? 'Reconnecting… · পুনঃসংযোগ'
        : s.status === 'error' ? 'Problem · সমস্যা' : 'Phone off · ফোন বন্ধ'

/** The phone, on every admin page: dialer, incoming call with the caller's orders, in-call controls. */
export function PhoneWidget() {
  const { engine, state, dial } = usePhone()
  const [open, setOpen] = useState(false)
  const call = state?.call ?? null
  const ringing = call?.state === 'incoming'
  // Pop the phone open whenever a call starts or changes state (incoming, dialled from an order, answered).
  const callState = call?.state
  useEffect(() => { if (callState && callState !== 'ended') setOpen(true) }, [callState])

  // Polled like the spec: the live inbound call for this agent (screen-pop fallback).
  const inbound = useQuery({
    queryKey: ['vd-active-inbound'],
    queryFn: pbx.getMyActiveInboundBrowserCall,
    enabled: state?.status === 'ready',
    refetchInterval: 4_000,
  })

  if (!engine || !state) return null
  const live = call && call.state !== 'ended'

  return (
    <div className="no-print fixed right-3 bottom-3 z-40 flex flex-col items-end gap-2 sm:right-5 sm:bottom-5">
      {open && (
        <div className="w-[min(380px,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
          role="dialog" aria-label="VoiceDrive phone">
          <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
            <span className={cn('size-2.5 rounded-full', dot(state))} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">VoiceDrive {state.extension ? <span className="font-normal text-zinc-400">· ext {state.extension}</span> : null}</p>
              <p className="truncate text-xs text-zinc-400">{statusText(state)}</p>
            </div>
            {state.status === 'ready' && !live && (
              <button type="button" className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                onClick={() => void engine.setAvailability(state.availability === 'AVAILABLE' ? 'AWAY' : 'AVAILABLE')}>
                {state.availability === 'AVAILABLE' ? 'Set away' : 'Set available'}
              </button>
            )}
            {(state.status === 'ready' || state.status === 'reconnecting' || state.status === 'error') && !live && (
              <button type="button" aria-label="Turn the phone off" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => void engine.stop()}>
                <Power className="size-4" />
              </button>
            )}
            <button type="button" aria-label="Close" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setOpen(false)}><X className="size-4" /></button>
          </header>
          <div className="max-h-[70dvh] overflow-y-auto p-4">
            {call ? <CallView state={state} /> : state.status === 'ready' ? <Dialer onDial={(n) => dial({ phone: n })} /> : <PhoneOff_ state={state} onStart={() => void engine.start()} />}
            {state.status === 'ready' && !call && inbound.data && inbound.data.status === 'ANSWERED' && (
              <p className="mt-3 text-xs text-zinc-400">You have a call in progress on another tab.</p>
            )}
          </div>
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={ringing ? 'Incoming call' : 'Phone'}
        className={cn('relative flex size-14 items-center justify-center rounded-full bg-zinc-900 text-white shadow-xl ring-1 ring-zinc-700 transition hover:bg-zinc-800',
          ringing && 'animate-bounce bg-emerald-600 hover:bg-emerald-600', live && !ringing && 'bg-emerald-700')}>
        {ringing ? <PhoneIncoming className="size-6" /> : <Phone className="size-6" />}
        <span className={cn('absolute top-1 right-1 size-3 rounded-full ring-2 ring-zinc-900', dot(state))} aria-hidden />
      </button>
    </div>
  )
}

function PhoneOff_({ state, onStart }: { state: PhoneState; onStart: () => void }) {
  const ov = useQuery({ queryKey: ['vd-overview'], queryFn: () => pbx.overview(), staleTime: 30_000 })
  const problems = ov.data?.lineProblems ?? []
  return (
    <div className="space-y-3 text-sm">
      {state.error && <p className="rounded-lg border border-red-900 bg-red-950/50 p-2 text-xs text-red-200">{state.error}</p>}
      {problems.length > 0 ? (
        <div className="space-y-1 text-xs text-zinc-300">
          <p className="font-medium">The line is not active yet · লাইন চালু নেই</p>
          <ul className="list-disc pl-4 text-zinc-400">{problems.map((p) => <li key={p}>{LINE_PROBLEM[p]}</li>)}</ul>
        </div>
      ) : (
        <p className="text-zinc-300">Start the phone to make and receive calls in this browser. Your microphone is used only during calls.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={state.status === 'starting' || problems.length > 0} onClick={onStart}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <Power className="size-4" /> {state.status === 'starting' ? 'Starting…' : 'Start phone · ফোন চালু'}
        </button>
        <Link to="/admin/settings/voicedrive-pbx?tab=setup" className="inline-flex items-center rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800">My Setup</Link>
      </div>
    </div>
  )
}

function Dialer({ onDial }: { onDial: (n: string) => Promise<unknown> }) {
  const [number, setNumber] = useState('')
  const go = useMutation({ mutationFn: () => onDial(number), onError: (e) => toast.error((e as Error).message) })
  const valid = /^(\+?880|0)1[3-9]\d{8}$|^0\d{9,11}$/.test(number.replace(/[\s-]/g, ''))
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3">
        <input value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d+*#\s-]/g, ''))} inputMode="tel" placeholder="01XXXXXXXXX"
          aria-label="Number to call" className="h-11 min-w-0 flex-1 bg-transparent text-lg tracking-wider outline-none placeholder:text-zinc-600"
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) go.mutate() }} />
        {number && <button type="button" aria-label="Delete" onClick={() => setNumber(number.slice(0, -1))} className="text-zinc-400 hover:text-zinc-100"><Delete className="size-5" /></button>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((k) => (
          <button key={k} type="button" onClick={() => setNumber((n) => n + k)}
            className="h-11 rounded-lg bg-zinc-900 text-lg font-medium hover:bg-zinc-800 active:bg-zinc-700">{k}</button>
        ))}
      </div>
      <button type="button" disabled={!valid || go.isPending} onClick={() => go.mutate()}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
        <PhoneOutgoing className="size-4" /> {go.isPending ? 'Calling…' : 'Call · কল করুন'}
      </button>
      <p className="text-center text-[11px] text-zinc-500">Outgoing calls use your business's prepaid balance. Incoming calls are free.</p>
    </div>
  )
}

function CallView({ state }: { state: PhoneState }) {
  const { engine } = usePhone()
  const call = state.call!
  const [keypad, setKeypad] = useState(false)
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

  return (
    <div className="space-y-3">
      <div className="text-center">
        <p className="text-xs tracking-wide text-zinc-400 uppercase">
          {call.state === 'incoming' ? 'Incoming call · ইনকামিং কল'
            : call.state === 'dialing' ? 'Calling… · কল হচ্ছে'
              : call.state === 'ringing' ? 'Ringing… · রিং হচ্ছে'
                : call.state === 'active' ? (call.direction === 'in' ? 'Incoming · কথা চলছে' : 'Outgoing · কথা চলছে')
                  : 'Call ended · কল শেষ'}
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-wider">{call.number}</p>
        {call.state === 'active' && <p className="font-mono text-sm text-emerald-400">{durationLabel(elapsed)}</p>}
        {s && call.state === 'ended' && (
          <p className="mt-1 text-xs text-zinc-400">
            {CALL_STATUS[s.status]?.label ?? s.status}
            {s.rejectReason ? ` — ${REJECT_REASON[s.rejectReason] ?? s.rejectReason}` : ''}
            {s.billedSeconds ? ` · ${durationLabel(s.billedSeconds)} billed` : ''}
            {s.chargedTk ? ` · ${Number(s.chargedTk).toFixed(2)} tk` : ''}
          </p>
        )}
      </div>

      {call.state === 'incoming' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void engine?.decline()} className="flex h-11 items-center justify-center gap-2 rounded-lg bg-red-600 font-medium text-white hover:bg-red-500"><PhoneOff className="size-4" /> Decline</button>
          <button type="button" onClick={() => void engine?.answer()} className="flex h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 font-medium text-white hover:bg-emerald-500"><Phone className="size-4" /> Answer</button>
        </div>
      )}

      {(call.state === 'active' || call.state === 'dialing' || call.state === 'ringing') && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <button type="button" disabled={call.state !== 'active'} onClick={() => engine?.mute(!call.muted)}
              className={cn('flex h-11 items-center justify-center gap-1.5 rounded-lg text-sm hover:bg-zinc-800 disabled:opacity-40', call.muted ? 'bg-amber-600/30 text-amber-200' : 'bg-zinc-900')}>
              {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />} {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" disabled={call.state !== 'active'} onClick={() => setKeypad((k) => !k)}
              className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 text-sm hover:bg-zinc-800 disabled:opacity-40"><Grip className="size-4" /> Keypad</button>
            <button type="button" onClick={() => void engine?.hangup()} className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-red-600 text-sm font-medium text-white hover:bg-red-500"><PhoneOff className="size-4" /> End</button>
          </div>
          {keypad && (
            <div className="grid grid-cols-3 gap-2">
              {KEYS.map((k) => <button key={k} type="button" onClick={() => engine?.sendDtmf(k)} className="h-10 rounded-lg bg-zinc-900 font-medium hover:bg-zinc-800">{k}</button>)}
            </div>
          )}
        </>
      )}

      {call.state === 'ended' && call.callId && (
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
          <p className="text-xs font-medium text-zinc-300">What happened? · কলের ফলাফল</p>
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <button key={o.value} type="button" onClick={() => setOutcome(o.value)}
                className={cn('rounded-full border px-2.5 py-1 text-xs', outcome === o.value ? 'border-emerald-500 bg-emerald-600/20 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800')}>
                {o.label} · {o.bn}
              </button>
            ))}
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Note (optional)" aria-label="Call note"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none placeholder:text-zinc-600" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => engine?.dismiss()} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Skip</button>
            <button type="button" disabled={save.isPending || (!outcome && !note.trim())} onClick={() => save.mutate()}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Save</button>
          </div>
        </div>
      )}
      {call.state === 'ended' && !call.callId && (
        <div className="flex justify-end"><button type="button" onClick={() => engine?.dismiss()} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Close</button></div>
      )}

      {/* Screen-pop: who is on the line and their orders. */}
      {call.number && call.number !== 'Unknown' && <CallerPanel phone={s?.normalizedCustomerPhone ?? call.number} dark compact={call.state !== 'incoming'} />}
    </div>
  )
}

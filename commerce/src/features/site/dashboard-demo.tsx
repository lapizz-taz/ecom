import { ArrowLeft, Check, CircleDot, Globe, Inbox, LayoutGrid, Loader2, Package, Phone, Search, ShieldCheck, Truck, X } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DEMO_COURIERS, DEMO_ORDERS, DEMO_RANGES, type DemoOrder, type DemoRange, type DemoStatus } from './demo-data'

// The product site's hero: a working miniature of the admin with sample data.
// Switch the date range, open the pipeline, call, approve, book a courier and
// mark parcels delivered. State lives in one reducer; nothing leaves the page.

type View = 'dashboard' | 'web' | 'approved' | 'couriers'

interface State {
  view: View
  range: DemoRange
  tab: DemoStatus
  orders: DemoOrder[]
  open: string | null
  query: string
  busy: string | null
  toast: string | null
  seq: number
}

type Action =
  | { type: 'view'; view: View; tab?: DemoStatus }
  | { type: 'range'; range: DemoRange }
  | { type: 'tab'; tab: DemoStatus }
  | { type: 'open'; id: string | null }
  | { type: 'query'; query: string }
  | { type: 'busy'; id: string | null }
  | { type: 'status'; id: string; status: DemoStatus; toast: string; courier?: string }
  | { type: 'toast'; toast: string | null }

const WEB: DemoStatus[] = ['NEW', 'CALLING']
const PIPELINE: DemoStatus[] = ['PENDING', 'RTS', 'SHIPPED', 'DELIVERED', 'RETURNED']
const LABEL: Record<DemoStatus, string> = { NEW: 'New', CALLING: 'Calling', PENDING: 'Pending', RTS: 'Ready (RTS)', SHIPPED: 'Shipped', DELIVERED: 'Delivered', RETURNED: 'Returned' }
const COLOR: Record<DemoStatus, string> = { NEW: 'var(--d-muted)', CALLING: 'var(--d-warn)', PENDING: 'var(--d-info)', RTS: 'var(--d-sky)', SHIPPED: 'var(--d-info)', DELIVERED: 'var(--d-ok)', RETURNED: 'var(--d-bad)' }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'view': return { ...s, view: a.view, tab: a.tab ?? (a.view === 'web' ? 'NEW' : a.view === 'approved' ? 'PENDING' : s.tab), open: null, query: '' }
    case 'range': return { ...s, range: a.range }
    case 'tab': return { ...s, tab: a.tab, open: null }
    case 'open': return { ...s, open: a.id }
    case 'query': return { ...s, query: a.query }
    case 'busy': return { ...s, busy: a.id }
    case 'toast': return { ...s, toast: a.toast }
    case 'status': {
      const seq = s.seq + 1
      return {
        ...s, seq, busy: null, toast: a.toast,
        orders: s.orders.map((o) => o.id !== a.id ? o : {
          ...o, status: a.status,
          ...(a.courier ? { courier: a.courier, tracking: `${a.courier.slice(0, 2).toUpperCase()}-${88300 + seq}` } : {}),
        }),
      }
    }
  }
}

const initial: State = { view: 'dashboard', range: 'week', tab: 'PENDING', orders: DEMO_ORDERS, open: null, query: '', busy: null, toast: null, seq: 0 }

const muted = 'text-(--d-muted)'
const taka = (n: number) => `৳${n.toLocaleString('en-IN')}`

export function DashboardDemo() {
  const [s, dispatch] = useReducer(reducer, initial)
  const counts = useMemo(() => Object.fromEntries((Object.keys(LABEL) as DemoStatus[]).map((k) => [k, s.orders.filter((o) => o.status === k).length])) as Record<DemoStatus, number>, [s.orders])

  // Toasts fade on their own; actions that "talk to a courier" take a moment.
  useEffect(() => {
    if (!s.toast) return
    const t = window.setTimeout(() => dispatch({ type: 'toast', toast: null }), 2600)
    return () => window.clearTimeout(t)
  }, [s.toast])
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const later = (id: string, fn: () => void) => {
    dispatch({ type: 'busy', id })
    timer.current = window.setTimeout(fn, 900)
  }

  const act = {
    call: (o: DemoOrder) => dispatch({ type: 'status', id: o.id, status: 'CALLING', toast: `Calling ${o.name}…` }),
    approve: (o: DemoOrder) => dispatch({ type: 'status', id: o.id, status: 'PENDING', toast: `${o.id} approved` }),
    pack: (o: DemoOrder) => dispatch({ type: 'status', id: o.id, status: 'RTS', toast: `${o.id} packed, ready to ship` }),
    book: (o: DemoOrder) => {
      const best = [...o.history].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Steadfast'
      later(o.id, () => dispatch({ type: 'status', id: o.id, status: 'SHIPPED', courier: best, toast: `Booked with ${best}` }))
    },
    deliver: (o: DemoOrder) => dispatch({ type: 'status', id: o.id, status: 'DELIVERED', toast: `${o.id} delivered · ${taka(o.amount)} COD` }),
  }

  const nav: Array<[View, typeof Inbox, string, number | null]> = [
    ['dashboard', LayoutGrid, 'Dashboard', null],
    ['web', Inbox, 'Web orders', counts.NEW + counts.CALLING],
    ['approved', Check, 'Approved', counts.PENDING + counts.RTS],
    ['couriers', Truck, 'Couriers', null],
  ]

  return (
    <div className="relative grid grid-cols-1 overflow-hidden rounded-xl border border-(--d-line) bg-(--d-panel) text-left text-[11px] text-(--d-fg2) shadow-(--d-shadow) sm:grid-cols-[170px_minmax(0,1fr)]">
      <aside className="hidden border-r border-(--d-line-2) p-3 sm:block">
        <div className="mb-4 flex items-center gap-2 font-medium text-(--d-strong)"><span className="grid size-5 place-items-center rounded bg-[#2142e7] text-[9px] text-(--d-strong)">I</span>Isolation</div>
        {nav.map(([v, Icon, l, c]) => (
          <button key={v} type="button" onClick={() => dispatch({ type: 'view', view: v })} aria-current={s.view === v ? 'page' : undefined}
            className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors', s.view === v ? 'bg-(--d-tint-3) text-(--d-strong)' : 'hover:bg-(--d-tint-2) hover:text-(--d-strong)')}>
            <Icon className="size-3.5 opacity-70" /><span className="flex-1">{l}</span>{c ? <span className={muted}>{c}</span> : null}
          </button>
        ))}
        {[[Package, 'Inventory'], [ShieldCheck, 'Fraud checks'], [Globe, 'Store']].map(([Icon, l]) => {
          const I = Icon as typeof Inbox
          return <div key={l as string} className="flex items-center gap-2 px-2 py-1.5 opacity-50"><I className="size-3.5" />{l as string}</div>
        })}
        <p className="mt-4 rounded-md border border-dashed border-(--d-line-strong) p-2 text-[10px] leading-relaxed text-(--d-subtle)">Interactive demo with sample data. Click around.</p>
      </aside>

      {/* Mobile: a compact view switcher. */}
      <div className="flex gap-1 overflow-x-auto border-b border-(--d-line-2) p-2 sm:hidden [scrollbar-width:none]">
        {nav.map(([v, , l]) => (
          <button key={v} type="button" onClick={() => dispatch({ type: 'view', view: v })} className={cn('shrink-0 rounded-full px-2.5 py-1', s.view === v ? 'bg-(--d-tint-4) text-(--d-strong)' : muted)}>{l}</button>
        ))}
      </div>

      <div className="min-h-[360px] min-w-0">
        {s.view === 'dashboard' && <Overview s={s} counts={counts} dispatch={dispatch} />}
        {(s.view === 'web' || s.view === 'approved') && <Orders s={s} counts={counts} dispatch={dispatch} act={act} />}
        {s.view === 'couriers' && <Couriers counts={counts} onOpen={() => dispatch({ type: 'view', view: 'approved', tab: 'RTS' })} />}
      </div>

      <div aria-live="polite" className={cn('pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--d-line-strong) bg-[#1b1c1f] px-3 py-1.5 text-white shadow-xl transition-all duration-300',
        s.toast ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0')}>
        <Check className="size-3 text-(--d-ok)" />{s.toast}
      </div>
    </div>
  )
}

function Overview({ s, counts, dispatch }: { s: State; counts: Record<DemoStatus, number>; dispatch: (a: Action) => void }) {
  const r = DEMO_RANGES[s.range]
  const max = Math.max(...r.bars)
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-medium text-(--d-strong)">Good evening, Nadia</p>
        <div className="ml-auto flex rounded-md border border-(--d-line-strong) p-0.5" role="radiogroup" aria-label="Date range">
          {(Object.keys(DEMO_RANGES) as DemoRange[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={s.range === k} onClick={() => dispatch({ type: 'range', range: k })}
              className={cn('rounded px-2 py-0.5', s.range === k ? 'bg-(--d-tint-4) text-(--d-strong)' : muted)}>{DEMO_RANGES[k].label}</button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[['Sales', taka(r.sales)], ['Orders', r.orders.toLocaleString('en-IN')], ['Delivered', `${r.delivered}%`], ['Net profit', taka(r.profit)]].map(([l, v]) => (
          <div key={l} className="rounded-lg border border-(--d-line-2) p-2.5">
            <p className={muted}>{l}</p>
            <p key={`${s.range}-${v}`} className="mt-0.5 animate-[enter_.35s_ease-out] text-[15px] font-medium text-(--d-strong) tabular-nums">{v}</p>
            <p className="text-[10px] text-(--d-ok)">+{r.delta}% vs before</p>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-(--d-line-2) p-3">
        <p className="mb-2 text-(--d-strong)">Orders</p>
        <div className="flex h-20 items-end gap-1">
          {r.bars.map((b, i) => (
            <div key={`${s.range}-${i}`} className="group relative flex-1">
              <div className="rounded-t-sm bg-gradient-to-t from-[#2142e7]/30 to-[#7b8fff] transition-[height] duration-500 group-hover:to-(--d-bar-hi)" style={{ height: `${(b / max) * 76}px` }} />
              <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 rounded bg-(--d-strong) px-1 text-[9px] text-(--d-panel) group-hover:block">{b}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-(--d-line-2)">
        <p className="px-3 pt-2.5 text-(--d-strong)">Order pipeline <span className={muted}>· click to open</span></p>
        <div className="grid grid-cols-3 lg:grid-cols-7">
          {[...WEB, ...PIPELINE].map((k) => (
            <button key={k} type="button" onClick={() => dispatch({ type: 'view', view: WEB.includes(k) ? 'web' : 'approved', tab: k })}
              className="px-3 py-2 text-left transition-colors hover:bg-(--d-tint-2)">
              <p className={cn('truncate', muted)}>{LABEL[k]}</p>
              <p className="text-[14px] font-medium tabular-nums" style={{ color: k === 'DELIVERED' && counts[k] ? COLOR[k] : 'var(--d-fg)' }}>{counts[k]}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

interface Acts { call: (o: DemoOrder) => void; approve: (o: DemoOrder) => void; pack: (o: DemoOrder) => void; book: (o: DemoOrder) => void; deliver: (o: DemoOrder) => void }

function Orders({ s, counts, dispatch, act }: { s: State; counts: Record<DemoStatus, number>; dispatch: (a: Action) => void; act: Acts }) {
  const tabs = s.view === 'web' ? WEB : PIPELINE
  const q = s.query.trim().toLowerCase()
  const list = s.orders.filter((o) => (q ? `${o.id} ${o.name} ${o.city}`.toLowerCase().includes(q) && tabs.includes(o.status) : o.status === s.tab))
  const open = s.orders.find((o) => o.id === s.open)
  return (
    <div className="grid h-full md:grid-cols-[minmax(0,1fr)_230px]">
      <div className="min-w-0 md:border-r md:border-(--d-line-2)">
        <div className="flex items-center gap-2 border-b border-(--d-line-2) px-3 py-2">
          <span className="font-medium text-(--d-strong)">{s.view === 'web' ? 'Web orders' : 'Approved orders'}</span>
          <label className="ml-auto flex items-center gap-1.5 rounded-md border border-(--d-line-strong) px-2 py-1">
            <Search className={cn('size-3', muted)} />
            <input value={s.query} onChange={(e) => dispatch({ type: 'query', query: e.target.value })} placeholder="Search name or invoice" aria-label="Search orders"
              className="w-28 bg-transparent text-(--d-strong) outline-none placeholder:text-(--d-subtle) sm:w-36" />
          </label>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-(--d-line-2) px-2 py-1.5 [scrollbar-width:none]" role="tablist">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={!q && s.tab === t} onClick={() => { dispatch({ type: 'query', query: '' }); dispatch({ type: 'tab', tab: t }) }}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1', !q && s.tab === t ? 'bg-(--d-tint-3) text-(--d-strong)' : muted)}>
              <span className="size-1.5 rounded-full" style={{ background: COLOR[t] }} />{LABEL[t]}<span className="tabular-nums opacity-70">{counts[t]}</span>
            </button>
          ))}
        </div>
        {list.length === 0 ? <p className={cn('px-4 py-10 text-center', muted)}>No orders here. Try another tab.</p> : list.map((o) => (
          <button key={o.id} type="button" onClick={() => dispatch({ type: 'open', id: o.id })}
            className={cn('flex w-full items-center gap-3 border-b border-(--d-line-3) px-3 py-2.5 text-left transition-colors hover:bg-(--d-tint-2)', s.open === o.id && 'bg-(--d-tint-3)')}>
            <span className={cn('w-16 shrink-0 font-mono', muted)}>{o.id}</span>
            <span className="size-2 shrink-0 rounded-full" style={{ background: COLOR[o.status] }} />
            <span className="min-w-0 flex-1 truncate text-(--d-fg)">{o.name}</span>
            <span className={cn('hidden lg:inline', muted)}>{o.city}</span>
            <span className="w-14 text-right tabular-nums">{taka(o.amount)}</span>
          </button>
        ))}
      </div>
      <div className={cn('p-3', open ? 'block' : 'hidden md:block')}>
        {open ? <Detail o={open} busy={s.busy === open.id} act={act} onClose={() => dispatch({ type: 'open', id: null })} /> : <p className={cn('pt-10 text-center', muted)}>Choose an order</p>}
      </div>
    </div>
  )
}

function Detail({ o, busy, act, onClose }: { o: DemoOrder; busy: boolean; act: Acts; onClose: () => void }) {
  const rate = Math.round(o.history.reduce((n, [, v]) => n + v, 0) / o.history.length)
  const risky = rate < 70
  const actions: Record<DemoStatus, ReactNode> = {
    NEW: <><Btn primary onClick={() => act.call(o)}><Phone className="size-3" /> Call</Btn><Btn onClick={() => act.approve(o)}>Approve</Btn></>,
    CALLING: <Btn primary onClick={() => act.approve(o)}><Check className="size-3" /> Confirmed, approve</Btn>,
    PENDING: <Btn primary onClick={() => act.pack(o)}><Package className="size-3" /> Pack</Btn>,
    RTS: <Btn primary disabled={busy} onClick={() => act.book(o)}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Truck className="size-3" />} {busy ? 'Booking…' : 'Book courier'}</Btn>,
    SHIPPED: <Btn primary onClick={() => act.deliver(o)}><Check className="size-3" /> Mark delivered</Btn>,
    DELIVERED: <span className="text-(--d-ok)">Delivered · COD collected</span>,
    RETURNED: <span className="text-(--d-bad)">Returned to the warehouse</span>,
  }
  return (
    <div key={o.id} className="animate-[enter_.25s_ease-out]">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} aria-label="Back to the list" className={cn('md:hidden', muted)}><ArrowLeft className="size-3.5" /></button>
        <p className={muted}>{o.id}</p>
        <span className="ml-auto rounded-full border border-(--d-line-strong) px-1.5 py-px text-[10px]" style={{ color: COLOR[o.status] }}>{LABEL[o.status]}</span>
        <button type="button" onClick={onClose} aria-label="Close" className={cn('hidden md:block', muted)}><X className="size-3.5" /></button>
      </div>
      <p className="mt-1 text-[13px] font-medium text-(--d-strong)">{o.name}</p>
      <p className={muted}>{o.phone} · {o.city}</p>
      <p className="mt-1 text-(--d-fg2)">{o.items} · <span className="tabular-nums">{taka(o.amount)}</span> COD</p>
      <div className="mt-3 space-y-1.5 rounded-lg border border-(--d-line) p-2.5">
        <p className="flex text-[10px] tracking-wide uppercase">Courier history<span className={cn('ml-auto normal-case', risky ? 'text-(--d-bad)' : 'text-(--d-ok)')}>{rate}% · {risky ? 'high risk' : 'good'}</span></p>
        {o.history.map(([c, v]) => (
          <div key={c} className="flex items-center gap-2">
            <span className="w-14">{c}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-(--d-tint-4)"><span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${v}%`, background: v < 70 ? '#eb5757' : '#4cb782' }} /></span>
            <span className="w-8 text-right tabular-nums">{v}%</span>
          </div>
        ))}
      </div>
      {risky && o.status === 'NEW' && <p className="mt-2 rounded-md border border-[#eb5757]/30 bg-[#eb5757]/[0.06] p-2 text-(--d-fg)">Ask for a ৳55 advance before shipping</p>}
      {o.tracking && <p className={cn('mt-2 flex items-center gap-1.5', muted)}><CircleDot className="size-3" />{o.courier} · <span className="font-mono text-(--d-fg2)">{o.tracking}</span></p>}
      <div className="mt-3 flex flex-wrap gap-2">{actions[o.status]}</div>
    </div>
  )
}

function Btn({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 font-medium transition-colors disabled:opacity-70', primary ? 'bg-[#2142e7] text-white hover:bg-[#3352f0]' : 'border border-(--d-line-strong) hover:bg-(--d-tint-3)')}>{children}</button>
  )
}

function Couriers({ counts, onOpen }: { counts: Record<DemoStatus, number>; onOpen: () => void }) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-medium text-(--d-strong)">Couriers</p>
        <button type="button" onClick={onOpen} className="ml-auto flex items-center gap-1 rounded-md bg-[#2142e7] px-2.5 py-1.5 font-medium text-white hover:bg-[#3352f0]">
          <Truck className="size-3" /> Book ready parcels ({counts.RTS})
        </button>
      </div>
      <div className="mt-3 divide-y divide-(--d-line-3) rounded-lg border border-(--d-line-2)">
        {DEMO_COURIERS.map((c) => (
          <div key={c.name} className="flex items-center gap-3 px-3 py-2.5">
            <span className="w-16 text-(--d-fg)">{c.name}</span>
            <span className={cn('w-16 tabular-nums', muted)}>{c.parcels} parcels</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--d-tint-4)"><span className="block h-full rounded-full bg-[#4cb782]" style={{ width: `${c.delivered}%` }} /></span>
            <span className="w-9 text-right tabular-nums">{c.delivered}%</span>
            <span className={cn('hidden w-20 text-right tabular-nums sm:inline', muted)}>{taka(c.cod)}</span>
          </div>
        ))}
      </div>
      <p className={cn('mt-2', muted)}>Delivery success and COD still with each courier, last 30 days.</p>
    </div>
  )
}

import {
  ArrowLeft, ArrowRight, Boxes, Check, ChevronDown, CircleDot, ClipboardList, CreditCard, Globe, Inbox, LayoutGrid, Loader2, Megaphone,
  MessageSquare, Package, PackagePlus, Phone, Plus, ScanLine, Search, ShoppingCart, Store, Triangle, Truck, Users, Wallet, X,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useReducer, useRef } from 'react'
import { Wordmark } from '@/components/brand/logo'
import { cn } from '@/lib/utils'
import { DEMO_COURIERS, DEMO_ORDERS, DEMO_RANGES, type DemoOrder, type DemoRange, type DemoStatus } from './demo-data'

// The product site's hero: a working miniature of the admin dashboard, in
// the admin's own light design, with sample data. Switch the date range, open
// the pipeline, call, approve, pack, book a courier and mark parcels
// delivered. State lives in one reducer; nothing leaves the page.

type View = 'dashboard' | 'web' | 'approved' | 'couriers'

interface State {
  view: View
  range: DemoRange
  rangeOpen: boolean
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
  | { type: 'rangeOpen'; open: boolean }
  | { type: 'tab'; tab: DemoStatus }
  | { type: 'open'; id: string | null }
  | { type: 'query'; query: string }
  | { type: 'busy'; id: string | null }
  | { type: 'status'; id: string; status: DemoStatus; toast: string; courier?: string }
  | { type: 'toast'; toast: string | null }

const WEB: DemoStatus[] = ['NEW', 'CALLING']
const PIPELINE: DemoStatus[] = ['PENDING', 'RTS', 'SHIPPED', 'DELIVERED', 'RETURNED']
const LABEL: Record<DemoStatus, string> = { NEW: 'New', CALLING: 'Calling', PENDING: 'Pending', RTS: 'Ready (RTS)', SHIPPED: 'Shipped', DELIVERED: 'Delivered', RETURNED: 'Returned' }
const CHIP: Record<DemoStatus, string> = {
  NEW: 'bg-zinc-100 text-zinc-700', CALLING: 'bg-amber-50 text-amber-800', PENDING: 'bg-blue-50 text-blue-700', RTS: 'bg-sky-50 text-sky-700',
  SHIPPED: 'bg-indigo-50 text-indigo-700', DELIVERED: 'bg-emerald-50 text-emerald-700', RETURNED: 'bg-red-50 text-red-700',
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'view': return { ...s, view: a.view, tab: a.tab ?? (a.view === 'web' ? 'NEW' : a.view === 'approved' ? 'PENDING' : s.tab), open: null, query: '', rangeOpen: false }
    case 'range': return { ...s, range: a.range, rangeOpen: false }
    case 'rangeOpen': return { ...s, rangeOpen: a.open }
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

const initial: State = { view: 'dashboard', range: 'month', rangeOpen: false, tab: 'PENDING', orders: DEMO_ORDERS, open: null, query: '', busy: null, toast: null, seq: 0 }
const taka = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`
const muted = 'text-zinc-500'

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
  const later = (id: string, fn: () => void) => { dispatch({ type: 'busy', id }); timer.current = window.setTimeout(fn, 900) }

  const act: Acts = {
    call: (o) => dispatch({ type: 'status', id: o.id, status: 'CALLING', toast: `Calling ${o.name}…` }),
    approve: (o) => dispatch({ type: 'status', id: o.id, status: 'PENDING', toast: `${o.id} approved` }),
    pack: (o) => dispatch({ type: 'status', id: o.id, status: 'RTS', toast: `${o.id} packed, ready to ship` }),
    book: (o) => {
      const best = [...o.history].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Steadfast'
      later(o.id, () => dispatch({ type: 'status', id: o.id, status: 'SHIPPED', courier: best, toast: `Booked with ${best}` }))
    },
    deliver: (o) => dispatch({ type: 'status', id: o.id, status: 'DELIVERED', toast: `${o.id} delivered · ${taka(o.amount)} COD` }),
  }
  const go = (view: View, tab?: DemoStatus) => dispatch({ type: 'view', view, tab })

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white text-left text-[11px] text-zinc-900 shadow-[0_30px_80px_-20px_rgb(0_0_0/.8)] [color-scheme:light]">
      <div className="grid grid-cols-1 sm:grid-cols-[172px_minmax(0,1fr)]">
        <Sidebar s={s} counts={counts} go={go} />
        <div className="min-w-0 bg-white">
          <TopBar go={go} />
          {/* Mobile: a compact view switcher. */}
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-100 p-2 sm:hidden [scrollbar-width:none]">
            {([['dashboard', 'Dashboard'], ['web', 'Web orders'], ['approved', 'Approved'], ['couriers', 'Couriers']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => go(v)} className={cn('shrink-0 rounded-full px-2.5 py-1', s.view === v ? 'bg-zinc-900 text-white' : muted)}>{l}</button>
            ))}
          </div>
          <div className="min-h-[430px] p-4 sm:p-5">
            {s.view === 'dashboard' && <Overview s={s} counts={counts} dispatch={dispatch} go={go} />}
            {(s.view === 'web' || s.view === 'approved') && <Orders s={s} counts={counts} dispatch={dispatch} act={act} />}
            {s.view === 'couriers' && <Couriers counts={counts} onOpen={() => go('approved', 'RTS')} />}
          </div>
        </div>
      </div>
      <div aria-live="polite" className={cn('pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 text-white shadow-xl transition-all duration-300',
        s.toast ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0')}>
        <Check className="size-3 text-emerald-400" />{s.toast}
      </div>
    </div>
  )
}

function Sidebar({ s, counts, go }: { s: State; counts: Record<DemoStatus, number>; go: (v: View, tab?: DemoStatus) => void }) {
  const item = (v: View | null, Icon: typeof Inbox, label: string, badge?: number) => (
    <button key={label} type="button" disabled={!v} onClick={() => v && go(v)} aria-current={v && s.view === v ? 'page' : undefined}
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        v && s.view === v ? 'bg-white font-medium text-zinc-900 shadow-[0_0_0_1px_rgb(0_0_0/.06)]' : 'text-zinc-600', v ? 'hover:text-zinc-900' : 'cursor-default')}>
      <Icon className="size-3.5 opacity-70" /><span className="flex-1">{label}</span>
      {badge ? <span className="rounded-full bg-blue-50 px-1.5 text-[10px] font-medium text-blue-700 tabular-nums">{badge}</span> : <ChevronDown className="size-3 opacity-30" />}
    </button>
  )
  return (
    <aside className="hidden border-r border-zinc-100 bg-zinc-50/70 p-3 sm:block">
      <Wordmark className="h-[15px] text-zinc-900" />
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5">
        <span className="grid size-6 place-items-center rounded-md bg-zinc-100 text-[9px] font-semibold">I</span>
        <span className="leading-tight"><span className="block font-medium">Isolation</span><span className={cn('block text-[9px]', muted)}>Owner</span></span>
      </div>
      <div className={cn('mt-2 flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1.5', muted)}><Search className="size-3" /> Find in menu</div>
      <div className="mt-3 space-y-0.5">
        <button type="button" onClick={() => go('dashboard')} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', s.view === 'dashboard' ? 'bg-white font-medium shadow-[0_0_0_1px_rgb(0_0_0/.06)]' : 'text-zinc-600 hover:text-zinc-900')}>
          <LayoutGrid className="size-3.5 opacity-70" /> Dashboard
        </button>
      </div>
      <p className={cn('mt-3 mb-1 px-2 text-[9px]', muted)}>Operations</p>
      <div className="space-y-0.5">
        {item('web', Inbox, 'Web Orders', counts.NEW + counts.CALLING)}
        {item('approved', ClipboardList, 'Approved Orders', counts.PENDING + counts.RTS)}
        {item('couriers', Truck, 'Couriers')}
        {item(null, Boxes, 'Inventory')}
        {item(null, Store, 'Store')}
        {item(null, MessageSquare, 'Messages')}
      </div>
      <p className={cn('mt-3 mb-1 px-2 text-[9px]', muted)}>Growth</p>
      <div className="space-y-0.5">{item(null, Megaphone, 'Ads')}{item(null, Users, 'Customers')}</div>
    </aside>
  )
}

function TopBar({ go }: { go: (v: View, tab?: DemoStatus) => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
      <div className="hidden items-center gap-3 text-zinc-600 md:flex">
        <button type="button" onClick={() => go('web', 'NEW')} className="flex items-center gap-1 hover:text-zinc-900"><Plus className="size-3" /> New Order</button>
        <button type="button" onClick={() => go('web')} className="flex items-center gap-1 hover:text-zinc-900"><Globe className="size-3" /> Web Order List</button>
        <button type="button" onClick={() => go('approved')} className="flex items-center gap-1 hover:text-zinc-900"><ClipboardList className="size-3" /> Order List</button>
        <span className="flex items-center gap-1"><ScanLine className="size-3" /> Scan</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-zinc-900 text-[9px] font-semibold text-white">AR</span>
        <span className="hidden font-medium sm:inline">Ayesha Rahman</span>
      </div>
    </div>
  )
}

function Spark({ data, className }: { data: readonly number[]; className?: string }) {
  const max = Math.max(...data), min = Math.min(...data)
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-7 w-24', className)} aria-hidden>
      <polyline points={pts} fill="none" stroke="#2142e7" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Overview({ s, counts, dispatch, go }: { s: State; counts: Record<DemoStatus, number>; dispatch: (a: Action) => void; go: (v: View, tab?: DemoStatus) => void }) {
  const r = DEMO_RANGES[s.range]
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const avg = r.sales / r.orders
  const kpis = [
    { l: 'Sales', v: taka(r.sales), sub: `${taka(r.sales / Math.max(r.bars.length, 1))} a day`, icon: Wallet, spark: r.bars },
    { l: 'Orders', v: r.orders.toLocaleString('en-IN'), sub: `${Math.round(r.orders / r.bars.length)} a day`, icon: ShoppingCart, spark: [...r.bars].reverse() },
    { l: 'Average order', v: taka(avg), sub: `${r.orders} orders`, icon: CreditCard },
    { l: 'Net profit', v: taka(r.profit), sub: `${r.delivered}% delivered`, icon: Triangle, spark: r.bars.map((b, i) => b + (i % 3) * 6) },
  ]
  const tiles: Array<[string, number, View, DemoStatus | undefined, string?]> = [
    ['Total orders', total, 'approved', undefined], ['Pending (web)', counts.NEW + counts.CALLING, 'web', 'NEW'], ['Pending', counts.PENDING, 'approved', 'PENDING'],
    ['Ready (RTS)', counts.RTS, 'approved', 'RTS'], ['Shipped', counts.SHIPPED, 'approved', 'SHIPPED'], ['Delivered', counts.DELIVERED, 'approved', 'DELIVERED', 'text-emerald-600'],
    ['Return pending', 0, 'approved', 'RETURNED'], ['Returned', counts.RETURNED, 'approved', 'RETURNED'],
  ]
  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <p className="text-[17px] font-semibold tracking-[-0.01em]">Good evening, Ayesha</p>
          <p className={muted}>Isolation · {r.label.toLowerCase()}</p>
        </div>
        <div className="relative ml-auto">
          <button type="button" aria-expanded={s.rangeOpen} onClick={() => dispatch({ type: 'rangeOpen', open: !s.rangeOpen })}
            className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 hover:bg-zinc-50">
            <ClipboardList className="size-3" /> {r.label} <ChevronDown className="size-3 opacity-50" />
          </button>
          {s.rangeOpen && (
            <div className="absolute top-full right-0 z-10 mt-1 w-32 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
              {(Object.keys(DEMO_RANGES) as DemoRange[]).map((k) => (
                <button key={k} type="button" onClick={() => dispatch({ type: 'range', range: k })}
                  className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-zinc-50', s.range === k && 'font-medium')}>
                  {DEMO_RANGES[k].label}{s.range === k && <Check className="size-3" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.l} className="rounded-xl border border-zinc-200 p-3">
            <div className="flex items-center justify-between"><p className={muted}>{k.l}</p><span className="grid size-5 place-items-center rounded-md bg-zinc-100"><k.icon className="size-3 text-zinc-500" /></span></div>
            <div className="mt-1 flex items-end justify-between gap-2">
              <div>
                <p key={`${s.range}-${k.v}`} className="animate-[enter_.35s_ease-out] text-[18px] font-semibold tracking-[-0.02em] tabular-nums">{k.v}</p>
                <p className={cn('text-[10px]', muted)}>{k.sub}</p>
              </div>
              {k.spark && <Spark key={s.range} data={k.spark} className="hidden xl:block" />}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[[PackagePlus, 'New order', () => go('web', 'NEW')], [Package, 'Add product', undefined], [Boxes, 'Stock adjustment', undefined], [Truck, 'Book couriers', () => go('approved', 'RTS')]].map(([Icon, l, fn]) => {
          const I = Icon as typeof Inbox
          return (
            <button key={l as string} type="button" onClick={fn as (() => void) | undefined} disabled={!fn}
              className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 font-medium enabled:hover:bg-zinc-50 disabled:cursor-default">
              <I className="size-3" />{l as string}
            </button>
          )
        })}
      </div>

      <div className="rounded-xl border border-zinc-200">
        <div className="flex items-center justify-between px-3 pt-2.5"><p className="font-semibold">Order pipeline</p><button type="button" onClick={() => go('approved')} className={cn('flex items-center gap-1 hover:text-zinc-900', muted)}>All orders <ArrowRight className="size-3" /></button></div>
        <div className="grid grid-cols-4 lg:grid-cols-8">
          {tiles.map(([l, n, v, tab, tone]) => (
            <button key={l} type="button" onClick={() => go(v, tab)} className="px-3 py-2 text-left transition-colors hover:bg-zinc-50">
              <p className={cn('truncate text-[10px]', muted)}>{l}</p>
              <p className={cn('text-[15px] font-semibold tabular-nums', n > 0 && tone)}>{n}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {[[Wallet, 'Payments to verify', 1, () => go('web', 'NEW')], [Truck, 'Ready to ship', counts.RTS, () => go('approved', 'RTS')], [Triangle, 'Low stock', 6, undefined]].map(([Icon, l, n, fn]) => {
          const I = Icon as typeof Inbox
          return (
            <button key={l as string} type="button" onClick={fn as (() => void) | undefined} disabled={!fn}
              className="flex items-center gap-2.5 rounded-xl border border-zinc-200 px-3 py-2.5 text-left enabled:hover:bg-zinc-50 disabled:cursor-default">
              <span className="grid size-7 place-items-center rounded-full bg-amber-50"><I className="size-3.5 text-amber-600" /></span>
              <span className="flex-1"><span className="block font-medium">{l as string}</span><span className={cn('block text-[10px]', muted)}>{n as number} waiting</span></span>
              <ArrowRight className="size-3 text-zinc-400" />
            </button>
          )
        })}
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[15px] font-semibold">{s.view === 'web' ? 'Web orders' : 'Approved orders'}</p>
        <label className="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5">
          <Search className={cn('size-3', muted)} />
          <input value={s.query} onChange={(e) => dispatch({ type: 'query', query: e.target.value })} placeholder="Search name or invoice" aria-label="Search orders"
            className="w-32 bg-transparent outline-none placeholder:text-zinc-400 sm:w-40" />
        </label>
      </div>
      <div className="flex gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={!q && s.tab === t} onClick={() => { dispatch({ type: 'query', query: '' }); dispatch({ type: 'tab', tab: t }) }}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1', !q && s.tab === t ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-600 hover:text-zinc-900')}>
            {LABEL[t]}<span className="tabular-nums opacity-70">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_230px]">
        <div className="overflow-hidden rounded-xl border border-zinc-200">
          <div className={cn('grid grid-cols-[72px_minmax(0,1fr)_64px] gap-3 border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[9px] uppercase', muted)}><span>Invoice</span><span>Customer</span><span className="text-right">Total</span></div>
          {list.length === 0 ? <p className={cn('px-4 py-10 text-center', muted)}>No orders here. Try another tab.</p> : list.map((o) => (
            <button key={o.id} type="button" onClick={() => dispatch({ type: 'open', id: o.id })}
              className={cn('grid w-full grid-cols-[72px_minmax(0,1fr)_64px] items-center gap-3 border-b border-zinc-100 px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-zinc-50', s.open === o.id && 'bg-blue-50/60')}>
              <span className="font-medium">{o.id}</span>
              <span className="min-w-0"><span className="block truncate">{o.name}</span><span className={cn('block truncate text-[10px]', muted)}>{o.city} · {o.items}</span></span>
              <span className="text-right font-medium tabular-nums">{taka(o.amount)}</span>
            </button>
          ))}
        </div>
        <div className={cn(open ? 'block' : 'hidden md:block')}>
          {open ? <Detail o={open} busy={s.busy === open.id} act={act} onClose={() => dispatch({ type: 'open', id: null })} />
            : <div className={cn('grid h-full min-h-40 place-items-center rounded-xl border border-dashed border-zinc-200 p-4 text-center', muted)}>Choose an order to call, approve or ship it</div>}
        </div>
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
    DELIVERED: <span className="font-medium text-emerald-700">Delivered · COD collected</span>,
    RETURNED: <span className="font-medium text-red-700">Returned to the warehouse</span>,
  }
  return (
    <div key={o.id} className="animate-[enter_.25s_ease-out] rounded-xl border border-zinc-200 p-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} aria-label="Back to the list" className={cn('md:hidden', muted)}><ArrowLeft className="size-3.5" /></button>
        <p className="font-medium">{o.id}</p>
        <span className={cn('ml-auto rounded-full px-1.5 py-px text-[10px] font-medium', CHIP[o.status])}>{LABEL[o.status]}</span>
        <button type="button" onClick={onClose} aria-label="Close" className={cn('hidden md:block', muted)}><X className="size-3.5" /></button>
      </div>
      <p className="mt-1.5 text-[13px] font-semibold">{o.name}</p>
      <p className={muted}>{o.phone} · {o.city}</p>
      <p className="mt-1">{o.items} · <span className="font-medium tabular-nums">{taka(o.amount)}</span> COD</p>
      <div className="mt-2.5 space-y-1.5 rounded-lg bg-zinc-50 p-2.5">
        <p className="flex text-[9px] uppercase">Courier success<span className={cn('ml-auto font-semibold normal-case', risky ? 'text-red-600' : 'text-emerald-600')}>{rate}% · {risky ? 'high risk' : 'good'}</span></p>
        {o.history.map(([c, v]) => (
          <div key={c} className="flex items-center gap-2">
            <span className="w-14">{c}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-200"><span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${v}%`, background: v < 70 ? '#dc2626' : '#059669' }} /></span>
            <span className="w-8 text-right tabular-nums">{v}%</span>
          </div>
        ))}
      </div>
      {risky && o.status === 'NEW' && <p className="mt-2 rounded-md bg-red-50 p-2 text-red-800">Ask for a ৳55 advance before shipping</p>}
      {o.tracking && <p className={cn('mt-2 flex items-center gap-1.5', muted)}><CircleDot className="size-3" />{o.courier} · <span className="font-mono text-zinc-800">{o.tracking}</span></p>}
      <div className="mt-3 flex flex-wrap gap-2">{actions[o.status]}</div>
    </div>
  )
}

function Btn({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 font-medium transition-colors disabled:opacity-70', primary ? 'bg-zinc-900 text-white hover:bg-zinc-800' : 'border border-zinc-200 hover:bg-zinc-50')}>{children}</button>
  )
}

function Couriers({ counts, onOpen }: { counts: Record<DemoStatus, number>; onOpen: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[15px] font-semibold">Couriers</p>
        <button type="button" onClick={onOpen} className="ml-auto flex items-center gap-1 rounded-md bg-zinc-900 px-2.5 py-1.5 font-medium text-white hover:bg-zinc-800">
          <Truck className="size-3" /> Book ready parcels ({counts.RTS})
        </button>
      </div>
      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
        {DEMO_COURIERS.map((c) => (
          <div key={c.name} className="flex items-center gap-3 px-3 py-2.5">
            <span className="w-16 font-medium">{c.name}</span>
            <span className={cn('w-16 tabular-nums', muted)}>{c.parcels} parcels</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100"><span className="block h-full rounded-full bg-emerald-500" style={{ width: `${c.delivered}%` }} /></span>
            <span className="w-9 text-right tabular-nums">{c.delivered}%</span>
            <span className={cn('hidden w-20 text-right tabular-nums sm:inline', muted)}>{taka(c.cod)}</span>
          </div>
        ))}
      </div>
      <p className={muted}>Delivery success and COD still with each courier, last 30 days.</p>
    </div>
  )
}

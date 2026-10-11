import { Check, ChevronRight, Circle, CircleDot, Globe, Inbox, LayoutGrid, Package, Phone, Search, ShieldCheck, Truck } from 'lucide-react'
import { cn } from '@/lib/utils'

// Product mock-ups for the marketing page, drawn in HTML so they stay sharp
// and match the real app. The data shown is illustrative sample data.

const win = 'rounded-xl border border-white/[0.08] bg-[#0f1011] shadow-[0_0_0_1px_rgb(0_0_0/.4),0_30px_80px_-20px_rgb(0_0_0/.8)]'
const muted = 'text-[#8a8f98]'

function Dot({ c }: { c: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ background: c }} />
}

const STATUS = { new: '#8a8f98', call: '#f2c94c', ok: '#4cb782', ship: '#7b8fff', risk: '#eb5757' }

/** The hero: the order screen with a detail panel. */
export function AppWindow() {
  const orders = [
    { n: 'ISO-10482', name: 'Rahim Uddin', city: 'Dhaka', amt: '৳1,290', s: 'call', label: 'Calling' },
    { n: 'ISO-10481', name: 'Nusrat Jahan', city: 'Chattogram', amt: '৳2,450', s: 'ok', label: 'Confirmed' },
    { n: 'ISO-10480', name: 'Tanvir Ahmed', city: 'Sylhet', amt: '৳890', s: 'risk', label: 'Review' },
    { n: 'ISO-10479', name: 'Mitu Akter', city: 'Khulna', amt: '৳3,100', s: 'ship', label: 'Shipped' },
    { n: 'ISO-10478', name: 'Sabbir Hossain', city: 'Rajshahi', amt: '৳1,750', s: 'ok', label: 'Confirmed' },
    { n: 'ISO-10477', name: 'Farhana Islam', city: 'Gazipur', amt: '৳640', s: 'new', label: 'New' },
  ] as const
  return (
    <div className={cn(win, 'grid grid-cols-1 overflow-hidden text-[11px] text-[#d0d6e0] sm:grid-cols-[180px_minmax(0,1fr)] md:grid-cols-[190px_minmax(0,1fr)_260px]')}>
      <aside className="hidden border-r border-white/[0.06] p-3 sm:block">
        <div className="mb-4 flex items-center gap-2 font-medium text-white"><span className="grid size-5 place-items-center rounded bg-[#2142e7] text-[9px]">I</span>Isolation</div>
        {[[Inbox, 'Web orders', '24'], [Check, 'Approved', '11'], [Truck, 'Couriers', ''], [Package, 'Inventory', ''], [ShieldCheck, 'Fraud checks', ''], [Globe, 'Store', '']].map(([Icon, l, c], i) => {
          const I = Icon as typeof Inbox
          return (
            <div key={l as string} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5', i === 0 && 'bg-white/[0.06] text-white')}>
              <I className="size-3.5 opacity-70" /><span className="flex-1">{l as string}</span>{c && <span className={muted}>{c as string}</span>}
            </div>
          )
        })}
      </aside>
      <div className="min-w-0 md:border-r md:border-white/[0.06]">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
          <span className="font-medium text-white">Web orders</span><span className={muted}>Processing · 24</span>
          <Search className={cn('ml-auto size-3.5', muted)} />
        </div>
        {orders.map((o, i) => (
          <div key={o.n} className={cn('flex items-center gap-3 border-b border-white/[0.04] px-4 py-2.5', i === 0 && 'bg-white/[0.03]')}>
            <span className={cn('w-16 shrink-0 font-mono', muted)}>{o.n}</span>
            <Dot c={STATUS[o.s]} />
            <span className="min-w-0 flex-1 truncate text-[#f7f8f8]">{o.name}</span>
            <span className={cn('hidden lg:inline', muted)}>{o.city}</span>
            <span className="w-14 text-right tabular-nums">{o.amt}</span>
            <span className="hidden w-16 rounded-full border border-white/10 px-1.5 py-0.5 text-center text-[10px] sm:inline">{o.label}</span>
          </div>
        ))}
      </div>
      <div className="hidden p-4 md:block">
        <p className={muted}>ISO-10482</p>
        <p className="mt-1 text-[13px] font-medium text-white">Rahim Uddin</p>
        <p className={muted}>017•• ••• 482 · Dhaka</p>
        <div className="mt-4 space-y-2 rounded-lg border border-white/[0.08] p-3">
          <p className="text-[10px] tracking-wide uppercase">Courier history</p>
          {[['Steadfast', 92], ['Pathao', 88], ['RedX', 100]].map(([c, v]) => (
            <div key={c as string} className="flex items-center gap-2">
              <span className="w-14">{c}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-[#4cb782]" style={{ width: `${v}%` }} /></span>
              <span className="w-8 text-right tabular-nums">{v}%</span>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          {['Order placed from the website', 'Fraud check passed · 91% delivered', 'Calling the customer…'].map((t, i) => (
            <div key={t} className="flex items-start gap-2"><CircleDot className={cn('mt-0.5 size-3 shrink-0', i === 2 ? 'text-[#f2c94c]' : muted)} /><span className={i === 2 ? 'text-white' : muted}>{t}</span></div>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <span className="flex items-center gap-1 rounded-md bg-[#2142e7] px-2.5 py-1.5 font-medium text-white"><Phone className="size-3" /> Call</span>
          <span className="rounded-md border border-white/10 px-2.5 py-1.5">Approve</span>
        </div>
      </div>
    </div>
  )
}

/** 1.0 Orders: queue board. */
export function OrdersBoard() {
  const cols = [
    { t: 'Processing', n: 24, c: STATUS.new, items: ['Black spike bracelet', 'Star chain ×2', 'Rhinestone belt'] },
    { t: 'Follow up', n: 7, c: STATUS.call, items: ['Cross necklace', 'Diesel belt'] },
    { t: 'Approved', n: 11, c: STATUS.ok, items: ['Ancient ring', 'Venom bracelet', '5 layer bracelet'] },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cols.map((c) => (
        <div key={c.t} className={cn(win, 'p-3 text-[11px]')}>
          <div className="mb-3 flex items-center gap-2 text-[#f7f8f8]"><Dot c={c.c} />{c.t}<span className={cn('ml-auto', muted)}>{c.n}</span></div>
          <div className="space-y-2">
            {c.items.map((it, i) => (
              <div key={it} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                <p className={cn('font-mono text-[10px]', muted)}>ISO-104{70 - i}</p>
                <p className="mt-0.5 text-[#f7f8f8]">{it}</p>
                <div className="mt-2 flex gap-1.5">
                  <span className="rounded border border-white/10 px-1.5 text-[10px]">COD</span>
                  {i === 0 && <span className="rounded border border-[#f2c94c]/40 px-1.5 text-[10px] text-[#f2c94c]">Duplicate?</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 2.0 Couriers: bulk booking progress. */
export function CourierBooking() {
  const rows = [
    ['ISO-10466', 'Steadfast', 'SF-88213', 'done'], ['ISO-10465', 'Pathao', 'DA2610XK', 'done'], ['ISO-10464', 'RedX', '24A1173', 'done'],
    ['ISO-10463', 'Steadfast', '', 'busy'], ['ISO-10462', 'Carrybee', '', 'wait'],
  ] as const
  return (
    <div className={cn(win, 'mx-auto max-w-2xl p-4 text-[11px]')}>
      <div className="flex items-center gap-2 text-[#f7f8f8]"><Truck className="size-4" /> Booking 5 parcels<span className={cn('ml-auto', muted)}>3 of 5</span></div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full w-3/5 rounded-full bg-gradient-to-r from-[#2142e7] to-[#7b8fff]" /></div>
      <div className="mt-4 divide-y divide-white/[0.05]">
        {rows.map(([o, c, t, s]) => (
          <div key={o} className="flex items-center gap-3 py-2.5">
            <span className={cn('w-16 font-mono', muted)}>{o}</span>
            <span className="w-20 text-[#f7f8f8]">{c}</span>
            <span className="flex-1 font-mono">{t || <span className={muted}>—</span>}</span>
            {s === 'done' ? <Check className="size-3.5 text-[#4cb782]" /> : s === 'busy' ? <span className="size-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white motion-reduce:animate-none" /> : <Circle className={cn('size-3.5', muted)} />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 3.0 Fraud: delivery success per courier for a phone number. */
export function FraudCheck() {
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_1.3fr]">
      <div className={cn(win, 'p-4 text-[11px]')}>
        <p className={muted}>Customer</p>
        <p className="mt-1 text-[13px] text-white">017•• ••• 315</p>
        <div className="mt-4 flex items-end gap-2"><span className="text-3xl font-semibold text-white tabular-nums">38%</span><span className="pb-1 text-[#eb5757]">High risk</span></div>
        <p className={cn('mt-1', muted)}>13 parcels · 5 delivered · 8 returned</p>
        <div className="mt-4 rounded-lg border border-[#eb5757]/30 bg-[#eb5757]/[0.06] p-2.5 text-[#f7f8f8]">Ask for a ৳55 advance before shipping</div>
      </div>
      <div className={cn(win, 'p-4 text-[11px]')}>
        <p className="mb-3 text-[#f7f8f8]">Delivered vs returned, by courier</p>
        {[['Steadfast', 6, 4], ['Pathao', 4, 3], ['RedX', 2, 1], ['Paperfly', 1, 0]].map(([c, a, b]) => (
          <div key={c as string} className="mb-3 flex items-center gap-3">
            <span className="w-16">{c}</span>
            <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span className="bg-[#4cb782]" style={{ width: `${((a as number) - (b as number)) / 6 * 100}%` }} />
              <span className="bg-[#eb5757]" style={{ width: `${(b as number) / 6 * 100}%` }} />
            </div>
            <span className={cn('w-10 text-right tabular-nums', muted)}>{(a as number) - (b as number)}/{a}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 4.0 Store: the theme editor. */
export function EditorMock() {
  return (
    <div className={cn(win, 'grid grid-cols-[150px_minmax(0,1fr)] overflow-hidden text-[11px] sm:grid-cols-[170px_minmax(0,1fr)_170px]')}>
      <div className="border-r border-white/[0.06] p-3">
        <p className="mb-2 text-[#f7f8f8]">Home page</p>
        {['Announcement bar', 'Header', 'Hero', 'Collection list', 'New arrivals', 'Footer'].map((s, i) => (
          <div key={s} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5', i === 2 ? 'bg-[#2142e7] text-white' : muted)}><LayoutGrid className="size-3" />{s}</div>
        ))}
        <p className="mt-2 px-2 text-[#7b8fff]">+ Add section</p>
      </div>
      <div className="bg-white p-2">
        <div className="bg-black py-1 text-center text-[8px] tracking-[0.2em] text-white">FREE DELIVERY · CASH ON DELIVERY</div>
        <div className="flex items-center justify-between px-2 py-2 text-[8px] tracking-wider text-black uppercase"><span>Shop · Belts · Rings</span><span className="text-[11px] font-semibold tracking-normal normal-case">isolation</span><span>⌕ ⛉</span></div>
        <div className="relative h-36 bg-gradient-to-br from-zinc-500 to-zinc-900 ring-2 ring-[#2142e7] ring-inset">
          <span className="absolute top-0 left-0 bg-[#2142e7] px-1.5 text-[9px] text-white">Hero</span>
          <div className="absolute bottom-3 left-3 flex items-center gap-2"><span className="bg-white px-3 py-1 text-[8px] text-black">SHOP NOW</span><span className="text-[8px] text-white/80">Made to last.</span></div>
        </div>
        <div className="mt-1 grid grid-cols-4 gap-px">{[0, 1, 2, 3].map((i) => <div key={i} className="aspect-[4/5] bg-black" />)}</div>
      </div>
      <div className="hidden space-y-2 border-l border-white/[0.06] p-3 sm:block">
        <p className="text-[#f7f8f8]">Hero</p>
        {['Image', 'Heading', 'Button label', 'Height'].map((f) => <div key={f}><p className={muted}>{f}</p><div className="mt-1 h-6 rounded-md border border-white/10" /></div>)}
      </div>
    </div>
  )
}

/** 5.0 Insights: profit by day. */
export function InsightsMock() {
  const bars = [42, 55, 38, 61, 70, 52, 66, 74, 58, 81, 77, 90, 72, 85]
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_1.5fr]">
      <div className={cn(win, 'space-y-3 p-4 text-[11px]')}>
        <p className="text-[#f7f8f8]">This week</p>
        {[['Delivered', '৳2,48,900', '#4cb782'], ['Returned', '৳18,400', '#eb5757'], ['Ad spend', '৳41,200', '#7b8fff'], ['Net profit', '৳63,750', '#f7f8f8']].map(([l, v, c]) => (
          <div key={l} className="flex items-center justify-between border-b border-white/[0.05] pb-2 last:border-0"><span className={muted}>{l}</span><span className="tabular-nums" style={{ color: c }}>{v}</span></div>
        ))}
      </div>
      <div className={cn(win, 'p-4 text-[11px]')}>
        <p className="mb-4 text-[#f7f8f8]">Profit per day</p>
        <div className="flex h-36 items-end gap-1.5">
          {bars.map((b, i) => <div key={i} className="flex-1 rounded-t-sm bg-gradient-to-t from-[#2142e7]/30 to-[#7b8fff]" style={{ height: `${b}%` }} />)}
        </div>
      </div>
    </div>
  )
}

export function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} className="inline-flex items-center gap-1 text-[13px] text-[#8a8f98] transition-colors hover:text-white">{children}<ChevronRight className="size-3.5" /></a>
}

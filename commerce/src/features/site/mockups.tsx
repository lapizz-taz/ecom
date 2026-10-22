import { Check, ChevronRight, Circle, Truck } from 'lucide-react'
import { cn } from '@/lib/utils'

// Product mock-ups for the marketing page, drawn in HTML so they stay sharp
// and match the real app. The data shown is illustrative sample data.

const win = 'rounded-xl border border-(--d-line) bg-(--d-panel) text-(--d-fg2) shadow-(--d-shadow)'
const muted = 'text-(--d-muted)'

function Dot({ c }: { c: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ background: c }} />
}

const STATUS = { new: '#8a8f98', call: '#f2c94c', ok: '#4cb782', ship: '#7b8fff', risk: '#eb5757' }

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
          <div className="mb-3 flex items-center gap-2 text-(--d-fg)"><Dot c={c.c} />{c.t}<span className={cn('ml-auto', muted)}>{c.n}</span></div>
          <div className="space-y-2">
            {c.items.map((it, i) => (
              <div key={it} className="rounded-lg border border-(--d-line-2) bg-(--d-tint-1) p-2.5">
                <p className={cn('font-mono text-[10px]', muted)}>ISO-104{70 - i}</p>
                <p className="mt-0.5 text-(--d-fg)">{it}</p>
                <div className="mt-2 flex gap-1.5">
                  <span className="rounded border border-(--d-line-strong) px-1.5 text-[10px]">COD</span>
                  {i === 0 && <span className="rounded border border-[#f2c94c]/40 px-1.5 text-[10px] text-(--d-warn)">Duplicate?</span>}
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
      <div className="flex items-center gap-2 text-(--d-fg)"><Truck className="size-4" /> Booking 5 parcels<span className={cn('ml-auto', muted)}>3 of 5</span></div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-(--d-tint-4)"><div className="h-full w-3/5 rounded-full bg-gradient-to-r from-[#2142e7] to-[#7b8fff]" /></div>
      <div className="mt-4 divide-y divide-(--d-line-3)">
        {rows.map(([o, c, t, s]) => (
          <div key={o} className="flex items-center gap-3 py-2.5">
            <span className={cn('w-16 font-mono', muted)}>{o}</span>
            <span className="w-20 text-(--d-fg)">{c}</span>
            <span className="flex-1 font-mono">{t || <span className={muted}>—</span>}</span>
            {s === 'done' ? <Check className="size-3.5 text-(--d-ok)" /> : s === 'busy' ? <span className="size-3.5 animate-spin rounded-full border-2 border-(--d-line-x) border-t-(--d-strong) motion-reduce:animate-none" /> : <Circle className={cn('size-3.5', muted)} />}
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
        <p className="mt-1 text-[13px] text-(--d-strong)">017•• ••• 315</p>
        <div className="mt-4 flex items-end gap-2"><span className="text-3xl font-semibold text-(--d-strong) tabular-nums">38%</span><span className="pb-1 text-(--d-bad)">High risk</span></div>
        <p className={cn('mt-1', muted)}>13 parcels · 5 delivered · 8 returned</p>
        <div className="mt-4 rounded-lg border border-[#eb5757]/30 bg-[#eb5757]/[0.06] p-2.5 text-(--d-fg)">Ask for a ৳55 advance before shipping</div>
      </div>
      <div className={cn(win, 'p-4 text-[11px]')}>
        <p className="mb-3 text-(--d-fg)">Delivered vs returned, by courier</p>
        {[['Steadfast', 6, 4], ['Pathao', 4, 3], ['RedX', 2, 1], ['Carrybee', 1, 0]].map(([c, a, b]) => (
          <div key={c as string} className="mb-3 flex items-center gap-3">
            <span className="w-16">{c}</span>
            <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-(--d-tint-3)">
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

/** 5.0 Insights: profit by day. */
export function InsightsMock() {
  const bars = [42, 55, 38, 61, 70, 52, 66, 74, 58, 81, 77, 90, 72, 85]
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_1.5fr]">
      <div className={cn(win, 'space-y-3 p-4 text-[11px]')}>
        <p className="text-(--d-fg)">This week</p>
        {[['Delivered', '৳2,48,900', 'var(--d-ok)'], ['Returned', '৳18,400', 'var(--d-bad)'], ['Ad spend', '৳41,200', 'var(--d-info)'], ['Net profit', '৳63,750', 'var(--d-fg)']].map(([l, v, c]) => (
          <div key={l} className="flex items-center justify-between border-b border-(--d-line-3) pb-2 last:border-0"><span className={muted}>{l}</span><span className="tabular-nums" style={{ color: c }}>{v}</span></div>
        ))}
      </div>
      <div className={cn(win, 'p-4 text-[11px]')}>
        <p className="mb-4 text-(--d-fg)">Profit per day</p>
        <div className="flex h-36 items-end gap-1.5">
          {bars.map((b, i) => <div key={i} className="flex-1 rounded-t-sm bg-gradient-to-t from-[#2142e7]/30 to-[#7b8fff]" style={{ height: `${b}%` }} />)}
        </div>
      </div>
    </div>
  )
}

export function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} className="inline-flex items-center gap-1 text-[13px] text-(--s-muted) transition-colors hover:text-(--s-fg)">{children}<ChevronRight className="size-3.5" /></a>
}

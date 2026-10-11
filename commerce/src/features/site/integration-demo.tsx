import { ArrowLeft, ArrowRight, Pause, Play, RotateCcw, Truck } from 'lucide-react'
import { useEffect, useReducer } from 'react'
import { LogoMark } from '@/components/brand/logo'
import { ShopifyLogo, WooLogo } from '@/components/brand/platform-logos'
import { cn } from '@/lib/utils'

// The product site's integration section: one order travelling between a
// Shopify or WooCommerce store, Fullfilio and the courier, step by step, for
// a delivered parcel or one that comes back (RTS). Sample data only.

type Platform = 'SHOPIFY' | 'WOOCOMMERCE'
type Path = 'DELIVERED' | 'RETURNED'
type Lane = 'store' | 'app' | 'courier'

interface View {
  store: { payment: string; fulfillment: string; note?: string; stock: number }
  app: { status: string; detail: string }
  courier: { status: string; detail?: string }
}

interface Step { title: (store: string) => string; from: Lane; to: Lane; view: View }

const COMMON: Step[] = [
  { title: (s) => `A customer orders on ${s}`, from: 'store', to: 'app',
    view: { store: { payment: 'Pending (COD)', fulfillment: 'Unfulfilled', stock: 11 }, app: { status: 'New web order', detail: '#1046 · Black leather belt · ৳1,750' }, courier: { status: 'Waiting' } } },
  { title: () => 'Fullfilio checks the customer and calls', from: 'app', to: 'store',
    view: { store: { payment: 'Pending (COD)', fulfillment: 'Unfulfilled', note: 'Tag: confirmed', stock: 11 }, app: { status: 'Confirmed', detail: '94% of past parcels delivered · call answered' }, courier: { status: 'Waiting' } } },
  { title: () => 'One click books the courier', from: 'app', to: 'courier',
    view: { store: { payment: 'Pending (COD)', fulfillment: 'Unfulfilled', note: 'Tag: confirmed', stock: 11 }, app: { status: 'Shipped', detail: 'Steadfast · SF-88213 · label printed' }, courier: { status: 'Picked up', detail: 'SF-88213' } } },
  { title: (s) => `Tracking goes back to ${s}`, from: 'app', to: 'store',
    view: { store: { payment: 'Pending (COD)', fulfillment: 'Fulfilled', note: 'Tracking SF-88213', stock: 11 }, app: { status: 'Shipped', detail: 'The customer gets the tracking link' }, courier: { status: 'In transit', detail: 'Dhaka hub' } } },
]

const PATHS: Record<Path, Step[]> = {
  DELIVERED: [
    ...COMMON,
    { title: () => 'The courier delivers and collects cash', from: 'courier', to: 'app',
      view: { store: { payment: 'Pending (COD)', fulfillment: 'Fulfilled', note: 'Tracking SF-88213', stock: 11 }, app: { status: 'Delivered', detail: '৳1,750 collected · in the courier invoice' }, courier: { status: 'Delivered', detail: '৳1,750 COD' } } },
    { title: (s) => `${s} shows the order paid and delivered`, from: 'app', to: 'store',
      view: { store: { payment: 'Paid', fulfillment: 'Delivered', note: 'Closed', stock: 11 }, app: { status: 'Delivered', detail: 'Profit counted after courier fees' }, courier: { status: 'Delivered', detail: '৳1,750 COD' } } },
  ],
  RETURNED: [
    ...COMMON,
    { title: () => 'The customer refuses: return to sender (RTS)', from: 'courier', to: 'app',
      view: { store: { payment: 'Pending (COD)', fulfillment: 'Fulfilled', note: 'Tracking SF-88213', stock: 11 }, app: { status: 'Return pending', detail: 'On its way back · customer flagged' }, courier: { status: 'Return to sender', detail: 'RTS · SF-88213' } } },
    { title: () => 'The parcel is scanned back in', from: 'courier', to: 'app',
      view: { store: { payment: 'Pending (COD)', fulfillment: 'Fulfilled', note: 'Tracking SF-88213', stock: 11 }, app: { status: 'Returned', detail: 'Scanned at the packing table · stock +1' }, courier: { status: 'Returned', detail: 'Return charge ৳50' } } },
    { title: (s) => `${s} is updated and the stock goes back`, from: 'app', to: 'store',
      view: { store: { payment: 'Voided', fulfillment: 'Returned', note: 'Restocked +1', stock: 12 }, app: { status: 'Returned', detail: 'Next order from this number asks for an advance' }, courier: { status: 'Returned', detail: 'Return charge ৳50' } } },
  ],
}

interface State { platform: Platform; path: Path; step: number; playing: boolean }
type Action = { type: 'platform'; platform: Platform } | { type: 'path'; path: Path } | { type: 'step'; step: number } | { type: 'play'; playing: boolean } | { type: 'tick' }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'platform': return { ...s, platform: a.platform }
    case 'path': return { ...s, path: a.path, step: Math.min(s.step, PATHS[a.path].length - 1) }
    case 'step': return { ...s, step: a.step, playing: false }
    case 'play': return { ...s, playing: a.playing, step: a.playing && s.step === PATHS[s.path].length - 1 ? 0 : s.step }
    case 'tick': {
      const last = PATHS[s.path].length - 1
      return s.step >= last ? { ...s, playing: false } : { ...s, step: s.step + 1 }
    }
  }
}

const muted = 'text-[#8a8f98]'

export function IntegrationDemo() {
  const [s, dispatch] = useReducer(reducer, { platform: 'SHOPIFY', path: 'RETURNED', step: 0, playing: false })
  const steps = PATHS[s.path]
  const step = steps[s.step]
  const storeName = s.platform === 'SHOPIFY' ? 'Shopify' : 'WooCommerce'
  const v = step.view

  useEffect(() => {
    if (!s.playing) return
    const t = window.setTimeout(() => dispatch({ type: 'tick' }), 1900)
    return () => window.clearTimeout(t)
  }, [s.playing, s.step])

  const lanes: Lane[] = ['store', 'app', 'courier']
  const active = (l: Lane) => step.from === l || step.to === l

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0f1011] text-[12px] shadow-[0_30px_80px_-20px_rgb(0_0_0/.8)]">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <div className="flex rounded-lg border border-white/10 p-0.5" role="radiogroup" aria-label="Store">
          {(['SHOPIFY', 'WOOCOMMERCE'] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={s.platform === p} onClick={() => dispatch({ type: 'platform', platform: p })}
              className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1', s.platform === p ? 'bg-white/10 text-white' : muted)}>
              {p === 'SHOPIFY' ? <ShopifyLogo className="size-4" /> : <WooLogo className="h-3.5 w-5" />}{p === 'SHOPIFY' ? 'Shopify' : 'WooCommerce'}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-white/10 p-0.5" role="radiogroup" aria-label="What happens to the parcel">
          {([['DELIVERED', 'Delivered'], ['RETURNED', 'Returned (RTS)']] as const).map(([p, l]) => (
            <button key={p} type="button" role="radio" aria-checked={s.path === p} onClick={() => dispatch({ type: 'path', path: p })}
              className={cn('rounded-md px-2.5 py-1', s.path === p ? 'bg-white/10 text-white' : muted)}>{l}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn label="Previous step" disabled={s.step === 0} onClick={() => dispatch({ type: 'step', step: s.step - 1 })}><ArrowLeft /></IconBtn>
          <button type="button" onClick={() => dispatch({ type: 'play', playing: !s.playing })}
            className="flex items-center gap-1.5 rounded-md bg-[#2142e7] px-3 py-1.5 font-medium text-white hover:bg-[#3352f0]">
            {s.playing ? <Pause className="size-3.5" /> : s.step === steps.length - 1 ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
            {s.playing ? 'Pause' : s.step === steps.length - 1 ? 'Replay' : 'Play'}
          </button>
          <IconBtn label="Next step" disabled={s.step === steps.length - 1} onClick={() => dispatch({ type: 'step', step: s.step + 1 })}><ArrowRight /></IconBtn>
        </div>
      </div>

      {/* The three places the order lives */}
      <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch md:gap-0">
        <Panel lit={active('store')} title={`${storeName} admin`} icon={s.platform === 'SHOPIFY' ? <ShopifyLogo className="size-4" /> : <WooLogo className="h-3.5 w-5" />}>
          <Row k="Order" v="#1046" />
          <Row k="Payment" v={v.store.payment} tone={v.store.payment === 'Paid' ? 'ok' : v.store.payment === 'Voided' ? 'bad' : 'wait'} />
          <Row k="Fulfillment" v={v.store.fulfillment} tone={v.store.fulfillment === 'Delivered' ? 'ok' : v.store.fulfillment === 'Returned' ? 'bad' : v.store.fulfillment === 'Fulfilled' ? 'info' : 'wait'} />
          <Row k="Black leather belt" v={`${v.store.stock} in stock`} tone={v.store.stock === 12 && s.step > 0 ? 'ok' : undefined} />
          {v.store.note && <p key={v.store.note} className={cn('mt-1 animate-[enter_.3s_ease-out] text-[11px]', muted)}>{v.store.note}</p>}
        </Panel>
        <Wire lanes={lanes} from={step.from} to={step.to} at={0} stepKey={`${s.path}-${s.step}`} />
        <Panel lit={active('app')} title="Fullfilio" icon={<LogoMark className="size-4" />}>
          <p key={v.app.status} className="animate-[enter_.3s_ease-out] text-[15px] font-medium text-white">{v.app.status}</p>
          <p key={v.app.detail} className={cn('mt-1 animate-[enter_.3s_ease-out]', muted)}>{v.app.detail}</p>
        </Panel>
        <Wire lanes={lanes} from={step.from} to={step.to} at={1} stepKey={`${s.path}-${s.step}`} />
        <Panel lit={active('courier')} title="Courier · Steadfast" icon={<Truck className="size-4 text-[#d0d6e0]" />}>
          <p key={v.courier.status} className="animate-[enter_.3s_ease-out] text-[15px] font-medium text-white">{v.courier.status}</p>
          {v.courier.detail && <p className={cn('mt-1 font-mono text-[11px]', muted)}>{v.courier.detail}</p>}
        </Panel>
      </div>

      {/* Steps */}
      <ol className="grid gap-1 border-t border-white/[0.06] p-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((st, i) => (
          <li key={i}>
            <button type="button" onClick={() => dispatch({ type: 'step', step: i })} aria-current={i === s.step ? 'step' : undefined}
              className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors', i === s.step ? 'bg-white/[0.06] text-white' : i < s.step ? 'text-[#d0d6e0]' : muted, 'hover:bg-white/[0.04]')}>
              <span className={cn('mt-px grid size-4 shrink-0 place-items-center rounded-full text-[9px] tabular-nums', i <= s.step ? 'bg-[#2142e7] text-white' : 'border border-white/15')}>{i + 1}</span>
              {st.title(storeName)}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
      className="grid size-7 place-items-center rounded-md border border-white/10 text-[#d0d6e0] hover:bg-white/[0.05] disabled:opacity-30 [&_svg]:size-3.5">{children}</button>
  )
}

function Panel({ lit, title, icon, children }: { lit: boolean; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border p-3 transition-[border-color,background-color,box-shadow] duration-300',
      lit ? 'border-[#2142e7]/60 bg-[#2142e7]/[0.06] shadow-[0_0_0_3px_rgb(33_66_231/.12)]' : 'border-white/[0.08]')}>
      <p className="mb-2 flex items-center gap-2 text-[11px] tracking-wide text-[#d0d6e0] uppercase">{icon}{title}</p>
      {children}
    </div>
  )
}

const TONE = { ok: 'text-[#4cb782]', bad: 'text-[#eb5757]', wait: 'text-[#f2c94c]', info: 'text-[#7b8fff]' } as const

function Row({ k, v, tone }: { k: string; v: string; tone?: keyof typeof TONE }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-white/[0.05] py-1.5 last:border-0">
      <span className={muted}>{k}</span>
      <span key={v} className={cn('animate-[enter_.3s_ease-out] text-right text-white', tone && TONE[tone])}>{v}</span>
    </div>
  )
}

/** The link between two neighbouring panels; a dot runs along it when data moves across. */
function Wire({ lanes, from, to, at, stepKey }: { lanes: Lane[]; from: Lane; to: Lane; at: number; stepKey: string }) {
  const a = lanes.indexOf(from)
  const b = lanes.indexOf(to)
  const crosses = Math.min(a, b) <= at && Math.max(a, b) > at
  const forward = b > a
  return (
    <div className="flex items-center justify-center md:w-14" aria-hidden>
      <div className="relative h-8 w-px bg-white/10 md:h-px md:w-full">
        {crosses && (
          <span key={stepKey} className={cn('absolute size-2 rounded-full bg-[#7b8fff] shadow-[0_0_12px_#7b8fff]',
            'left-[-3.5px] md:top-[-3.5px] md:left-auto',
            forward ? 'animate-[wire-down_1.1s_ease-in-out_infinite] md:animate-[wire-right_1.1s_ease-in-out_infinite]' : 'animate-[wire-up_1.1s_ease-in-out_infinite] md:animate-[wire-left_1.1s_ease-in-out_infinite]')} />
        )}
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Menu, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Wordmark } from '@/components/brand/logo'
import { DashboardDemo } from '@/features/site/dashboard-demo'
import { CourierBooking, FraudCheck, InsightsMock, MoreLink, OrdersBoard } from '@/features/site/mockups'
import { ThemeEditorDemo } from '@/features/site/theme-editor-demo'
import { TourVideo } from '@/features/site/tour-video'
import { cn } from '@/lib/utils'
import { signupOptions } from '@/services/onboarding'

// The Fullfilio product site: dark, quiet and precise, with the brand blue
// used sparingly. Every feature shown here exists in the app.

const NAV = [['Product', '#product'], ['Features', '#orders'], ['Pricing', '#pricing'], ['Changelog', '#changelog'], ['Contact', '#contact']] as const

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect() } }, { rootMargin: '0px 0px -10% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return { ref, className: cn('transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none', shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0') }
}

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const r = useReveal<HTMLDivElement>()
  return <div ref={r.ref} className={cn(r.className, className)}>{children}</div>
}

export default function MarketingHome() {
  const [menu, setMenu] = useState(false)
  useEffect(() => { document.title = 'Fullfilio — the order system for online sellers' }, [])
  return (
    <div className="min-h-dvh bg-[#08090a] font-sans text-[#f7f8f8] antialiased selection:bg-[#2142e7]/60">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#08090a]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
          <a href="#top" aria-label="Fullfilio home" className="text-white"><Wordmark className="h-[18px]" /></a>
          <nav className="ml-auto hidden items-center gap-6 text-[13px] text-[#8a8f98] md:flex" aria-label="Main">
            {NAV.map(([l, h]) => <a key={l} href={h} className="transition-colors hover:text-white">{l}</a>)}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-4">
            <Link to="/admin/login" className="hidden px-2 text-[13px] text-[#8a8f98] transition-colors hover:text-white sm:inline">Log in</Link>
            <Link to="/start" className="rounded-full bg-[#f7f8f8] px-3.5 py-1.5 text-[13px] font-medium text-[#08090a] transition-colors hover:bg-white">Sign up</Link>
            <button type="button" className="grid size-8 place-items-center md:hidden" aria-label="Menu" onClick={() => setMenu(!menu)}>{menu ? <X className="size-4" /> : <Menu className="size-4" />}</button>
          </div>
        </div>
        {menu && (
          <nav className="grid gap-1 border-t border-white/[0.06] px-5 py-3 text-sm md:hidden">
            {NAV.map(([l, h]) => <a key={l} href={h} onClick={() => setMenu(false)} className="py-2 text-[#d0d6e0]">{l}</a>)}
            <Link to="/admin/login" className="py-2 text-[#d0d6e0]">Log in</Link>
          </nav>
        )}
      </header>

      <main id="top">
        {/* Hero */}
        <section className="relative overflow-hidden" id="product">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_60%_50%_at_30%_0%,rgb(33_66_231/.18),transparent)]" />
          <div className="relative mx-auto max-w-6xl px-5 pt-24 pb-14 sm:pt-32">
            <h1 className="max-w-3xl text-[40px] leading-[1.05] font-medium tracking-[-0.035em] sm:text-[64px]">
              The order system for online sellers
            </h1>
            <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
              <p className="max-w-md text-[15px] leading-relaxed text-[#8a8f98] sm:text-[17px]">
                Purpose-built for cash-on-delivery commerce in Bangladesh. Orders, calls, couriers, fraud checks and stock, in one calm place.
              </p>
              <a href="#store" className="flex items-center gap-2 text-[13px] text-[#8a8f98] transition-colors hover:text-white">
                <span className="font-medium text-white">New</span> Store theme editor <ArrowRight className="size-3.5" />
              </a>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/start" className="rounded-full bg-[#f7f8f8] px-5 py-2.5 text-sm font-medium text-[#08090a] hover:bg-white">Start for free</Link>
              <a href="#tour" className="rounded-full border border-white/10 px-5 py-2.5 text-sm text-[#d0d6e0] hover:bg-white/[0.04]">Watch the tour</a>
            </div>
          </div>
          <div className="relative mx-auto max-w-6xl px-5 pb-24 [perspective:2000px]">
            {/* A working demo: it lies back until the visitor reaches for it. */}
            <Reveal className="origin-top transition-transform duration-700 [transform:rotateX(14deg)] hover:[transform:none] focus-within:[transform:none] max-sm:[transform:none]">
              <DashboardDemo />
            </Reveal>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#08090a] to-transparent" />
          </div>
        </section>

        {/* Product tour */}
        <section id="tour" className="scroll-mt-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
            <Reveal className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-[28px] leading-tight font-medium tracking-[-0.03em] sm:text-[40px]">See it in 30 seconds</h2>
              <p className="max-w-sm text-[15px] text-[#8a8f98]">From the first order to a delivered parcel: sync, fraud checks, courier booking and returns.</p>
            </Reveal>
            <Reveal className="mt-10"><TourVideo /></Reveal>
          </div>
        </section>

        {/* Statement + three pillars */}
        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-24 sm:py-32">
            <Reveal>
              <p className="max-w-4xl text-[26px] leading-[1.2] font-medium tracking-[-0.025em] sm:text-[40px]">
                A new kind of back office. <span className="text-[#8a8f98]">Built for teams that confirm, pack and ship every day, Fullfilio turns a messy inbox of orders into a pipeline you can trust.</span>
              </p>
            </Reveal>
            <div className="mt-20 grid gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.06] md:grid-cols-3">
              {[
                { k: 'FIG 0.1', t: 'Built for cash on delivery', d: 'Calls, follow-ups, advance payments and duplicate checks are part of the flow, not an afterthought.', art: <Stack /> },
                { k: 'FIG 0.2', t: 'Powered by courier data', d: 'Every phone number is checked against delivery history across couriers before you ship.', art: <Cubes /> },
                { k: 'FIG 0.3', t: 'Designed for speed', d: 'Keyboard-fast lists, bulk booking and label printing keep a busy day moving.', art: <Steps /> },
              ].map((c) => (
                <Reveal key={c.t} className="bg-[#08090a] p-6">
                  <p className="font-mono text-[11px] text-[#62666d]">{c.k}</p>
                  <div className="my-8 grid h-40 place-items-center text-[#3e4248]">{c.art}</div>
                  <p className="text-[15px] font-medium">{c.t}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#8a8f98]">{c.d}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <Feature id="orders" n="1.0" tag="Orders" title={<>Make every order<br />count</>}
          text="Website, Facebook, Shopify and WooCommerce orders land in one list. Call the customer, record what happened, merge duplicates and approve in a click."
          subs={['1.1 Web orders', '1.2 Call queues', '1.3 Duplicate merge', '1.4 Abandoned carts']}><OrdersBoard /></Feature>
        <Feature id="couriers" n="2.0" tag="Couriers" title={<>Ship with every courier<br />from one screen</>}
          text="Book Steadfast, Pathao, RedX and Carrybee parcels in bulk, print labels, scan at the packing table and follow every delivery to the end."
          subs={['2.1 Bulk booking', '2.2 Labels and scanning', '2.3 Delivery tracking', '2.4 Invoice reconciliation']}><CourierBooking /></Feature>
        <Feature id="fraud" n="3.0" tag="Fraud check" title={<>Stop fake orders<br />before they ship</>}
          text="See how often a customer accepts their parcels before you send another one. Ask risky orders for an advance, block repeat offenders, keep good customers moving."
          subs={['3.1 Courier success rate', '3.2 Advance payments', '3.3 Block list']}><FraudCheck /></Feature>
        <Feature id="store" n="4.0" tag="Store" title={<>Your store,<br />your domain</>}
          text="Launch a fast storefront with a visual theme editor, connect your own domain with HTTPS, or keep selling on Shopify and WooCommerce with two-way sync."
          subs={['4.1 Theme editor', '4.2 Custom domains', '4.3 Shopify and WooCommerce', '4.4 Website and External API']}><ThemeEditorDemo /></Feature>
        <Feature id="insights" n="5.0" tag="Insights" title={<>Understand profit<br />at scale</>}
          text="Delivered, returned and paid, next to ad spend and courier costs. Know which products and campaigns actually make money."
          subs={['5.1 Profit and loss', '5.2 Ads attribution', '5.3 Inventory insights']}><InsightsMock /></Feature>

        {/* Integrations */}
        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <p className="text-center text-[13px] text-[#8a8f98]">Works with the tools you already use</p>
            <div className="mt-8 flex flex-wrap justify-center gap-x-10 gap-y-4 text-[15px] font-medium text-[#62666d]">
              {['Shopify', 'WooCommerce', 'Steadfast', 'Pathao', 'RedX', 'Carrybee', 'bKash', 'Meta Ads', 'TikTok Ads'].map((n) => <span key={n} className="transition-colors hover:text-[#d0d6e0]">{n}</span>)}
            </div>
          </div>
        </section>

        <Pricing />

        {/* Changelog */}
        <section id="changelog" className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <h2 className="text-[32px] font-medium tracking-[-0.025em] sm:text-[40px]">Changelog</h2>
            <div className="relative mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              <div className="absolute top-[5px] right-0 left-0 hidden h-px bg-white/[0.08] lg:block" />
              {[
                { t: 'Store theme editor', d: 'Edit your store visually: sections, colours, fonts and a live preview, like the editors you know.', first: true },
                { t: 'External API', d: 'Connect an ERP or warehouse app with scoped keys for orders, products, stock and customers.' },
                { t: 'Custom domain status', d: 'See every DNS record, each region and HTTPS at a glance, with fixes for common problems.' },
                { t: 'Self-service sign-up', d: 'Open a business in minutes: pick a plan, add your details and start taking orders.' },
              ].map((c) => (
                <Reveal key={c.t} className="relative">
                  <span className={cn('relative z-10 block size-2.5 rounded-full border-2 border-[#08090a]', c.first ? 'bg-[#2142e7] ring-4 ring-[#2142e7]/20' : 'bg-[#3e4248]')} />
                  <p className="mt-6 text-[14px] font-medium">{c.t}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#8a8f98]">{c.d}</p>
                  <p className="mt-3 font-mono text-[11px] text-[#62666d]">OCT 2026</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Final call to action */}
        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-28 text-center sm:py-36">
            <Reveal>
              <h2 className="text-[36px] leading-[1.05] font-medium tracking-[-0.035em] sm:text-[56px]">Built for how you sell.<br />Available today.</h2>
              <div className="mt-8 flex justify-center gap-3">
                <Link to="/start" className="rounded-full bg-[#f7f8f8] px-5 py-2.5 text-sm font-medium text-[#08090a] hover:bg-white">Get started</Link>
                <a href="#contact" className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm text-[#d0d6e0] hover:bg-white/[0.08]">Contact us</a>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer id="contact" className="border-t border-white/[0.06]">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-[1fr_repeat(4,auto)] sm:gap-16">
          <div className="text-white"><Wordmark className="h-4" /></div>
          {[
            ['Product', [['Orders', '#orders'], ['Couriers', '#couriers'], ['Fraud check', '#fraud'], ['Store', '#store'], ['Pricing', '#pricing']]],
            ['Features', [['Theme editor', '#store'], ['Custom domains', '#store'], ['Insights', '#insights'], ['Changelog', '#changelog']]],
            ['Account', [['Sign up', '/start'], ['Log in', '/admin/login'], ['Forgot password', '/admin/forgot-password']]],
            ['Contact', [['Talk to us', '/start'], ['Track a parcel', '/track-order']]],
          ].map(([h, links]) => (
            <div key={h as string}>
              <p className="text-[13px] font-medium">{h as string}</p>
              <ul className="mt-4 space-y-2.5 text-[13px] text-[#8a8f98]">
                {(links as string[][]).map(([l, href]) => (
                  <li key={l}>{href.startsWith('#') ? <a href={href} className="hover:text-white">{l}</a> : <Link to={href} className="hover:text-white">{l}</Link>}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mx-auto max-w-6xl px-5 pb-10 text-[12px] text-[#62666d]">© {new Date().getFullYear()} Fullfilio. Made in Bangladesh.</p>
      </footer>
    </div>
  )
}

function Feature({ id, n, tag, title, text, subs, children }: { id: string; n: string; tag: string; title: ReactNode; text: string; subs: string[]; children: ReactNode }) {
  return (
    <section id={id} className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:py-28">
        <Reveal className="grid gap-6 md:grid-cols-2 md:gap-16">
          <h2 className="text-[30px] leading-[1.1] font-medium tracking-[-0.025em] sm:text-[40px]">{title}</h2>
          <div>
            <p className="text-[15px] leading-relaxed text-[#8a8f98]">{text}</p>
            <div className="mt-5"><MoreLink href={`#${id}`}><span className="font-mono text-[12px]">{n}</span> {tag}</MoreLink></div>
          </div>
        </Reveal>
        <Reveal className="mt-14">{children}</Reveal>
        <div className="mt-12 grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-[12px] text-[#62666d] sm:grid-cols-4">
          {subs.map((s) => <span key={s}>{s}</span>)}
        </div>
      </div>
    </section>
  )
}

function Pricing() {
  const q = useQuery({ queryKey: ['signup-options'], queryFn: signupOptions, staleTime: 5 * 60_000 })
  const plans = q.data?.plans ?? []
  return (
    <section id="pricing" className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid gap-6 md:grid-cols-2 md:gap-16">
          <h2 className="text-[30px] leading-[1.1] font-medium tracking-[-0.025em] sm:text-[40px]">Simple plans<br />that grow with you</h2>
          <p className="text-[15px] leading-relaxed text-[#8a8f98]">Start on a plan that fits today and change it any time from Plan &amp; Billing. Prices are in Bangladeshi taka.</p>
        </div>
        <div className={cn('mt-14 grid gap-3', plans.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
          {q.isLoading && [0, 1, 2].map((i) => <div key={i} className="h-72 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02]" />)}
          {plans.map((p) => {
            const highlight = p.code === q.data?.default_plan
            return (
              <div key={p.code} className={cn('flex flex-col rounded-2xl border p-6', highlight ? 'border-[#2142e7]/60 bg-[#2142e7]/[0.06]' : 'border-white/[0.08] bg-white/[0.02]')}>
                <div className="flex items-center justify-between">
                  <p className="text-[15px] font-medium">{p.name}</p>
                  {p.trial_days ? <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-[#d0d6e0]">{p.trial_days}-day trial</span> : null}
                </div>
                <p className="mt-4"><span className="text-[36px] font-medium tracking-tight tabular-nums">৳{Number(p.price).toLocaleString('en-IN')}</span><span className="text-[13px] text-[#8a8f98]"> / {p.billing_interval === 'YEAR' ? 'year' : 'month'}</span></p>
                {p.description && <p className="mt-2 text-[13px] text-[#8a8f98]">{p.description}</p>}
                <ul className="mt-6 flex-1 space-y-2 text-[13px] text-[#d0d6e0]">
                  {(p.features ?? []).slice(0, 8).map((f) => <li key={f} className="flex gap-2"><span className="text-[#7b8fff]">✓</span>{f}</li>)}
                </ul>
                <Link to={`/start?plan=${encodeURIComponent(p.code)}`}
                  className={cn('mt-6 rounded-full px-4 py-2 text-center text-sm font-medium', highlight ? 'bg-[#f7f8f8] text-[#08090a] hover:bg-white' : 'border border-white/10 text-[#d0d6e0] hover:bg-white/[0.04]')}>Choose {p.name}</Link>
              </div>
            )
          })}
          {!q.isLoading && !plans.length && <p className="text-[13px] text-[#8a8f98]">Plans are being updated. <Link to="/start" className="text-white underline">Contact us</Link> to get started.</p>}
        </div>
        {q.data?.order_fee && <p className="mt-6 text-[13px] text-[#8a8f98]">Plus ৳{q.data.order_fee.fee} per approved order{q.data.order_fee.free_per_month ? ` after the first ${q.data.order_fee.free_per_month} each month` : ''}.</p>}
      </div>
    </section>
  )
}

// Isometric line drawings for the three pillars.
function Stack() {
  return (
    <svg viewBox="0 0 160 140" className="h-full" fill="none" stroke="currentColor" strokeWidth="1">
      {[0, 14, 28, 42].map((y) => <path key={y} d={`M80 ${30 + y} L140 ${60 + y} L80 ${90 + y} L20 ${60 + y} Z`} />)}
      <path d="M20 60v42M140 60v42M80 90v42" />
    </svg>
  )
}
function Cubes() {
  const cube = (x: number, y: number) => <g key={`${x}${y}`} transform={`translate(${x} ${y})`}><path d="M0 12 L20 0 L40 12 L20 24 Z M0 12v24l20 12V24M40 12v24L20 48" /></g>
  return <svg viewBox="0 0 160 140" className="h-full" fill="none" stroke="currentColor" strokeWidth="1">{[[60, 10], [30, 28], [90, 28], [60, 46], [30, 64], [90, 64], [60, 82]].map(([x, y]) => cube(x, y))}</svg>
}
function Steps() {
  return (
    <svg viewBox="0 0 160 140" className="h-full" fill="none" stroke="currentColor" strokeWidth="1">
      {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${20 + i * 12} ${110 - i * 9} L${50 + i * 12} ${125 - i * 9} L${50 + i * 12} ${130} M${20 + i * 12} ${110 - i * 9} v${20 + i * 9}`} />)}
    </svg>
  )
}

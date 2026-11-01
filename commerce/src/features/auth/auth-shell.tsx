import { MessagesSquare, RotateCcw, ShieldCheck, Store, Truck, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { cn } from '@/lib/utils'

/** The website (sign-in also opens on a store's own domain, where these pages are not the store's). */
const SITE = 'https://fullfilio.com'

/** What Fullfilio does, as tiles (sign-in). Facts only: no made-up counts. */
const TILES = [
  { icon: Truck, title: 'Steadfast · Pathao · RedX · Carrybee', text: 'Couriers booked in bulk' },
  { icon: ShieldCheck, title: 'Fake-order check', text: 'Courier success rate on every order' },
  { icon: MessagesSquare, title: 'Messenger · Instagram · WhatsApp', text: 'One inbox for every chat' },
  { icon: Store, title: 'Shopify · WooCommerce', text: 'Orders and stock in sync' },
  { icon: Wallet, title: 'Real profit', text: 'After courier and ad costs' },
  { icon: RotateCcw, title: 'Returns and RTS', text: 'Every parcel followed home' },
]

/** What sellers come to Fullfilio for, as cards (sign-up). */
const PROMISES = [
  { icon: ShieldCheck, line: 'Stop fake COD orders before you ship.', text: 'A courier history check on every order' },
  { icon: Truck, line: 'Book 100 parcels to Steadfast, Pathao or RedX in one click.', text: 'Bulk booking with live progress' },
  { icon: Wallet, line: 'See the real profit of every order after courier and ad costs.', text: 'On your dashboard from the day you approve' },
  { icon: MessagesSquare, line: 'Answer Messenger, Instagram and WhatsApp in one place.', text: 'And create the order right from the chat' },
]

/**
 * The dark brand panel on the right (large screens): a dotted blue glow, a headline and what
 * Fullfilio does. One screen high, and it stays in view while a long form on the left scrolls.
 */
function BrandPanel({ kind }: { kind: 'signin' | 'signup' }) {
  return (
    <div className="relative isolate hidden overflow-hidden rounded-[22px] bg-[#0c0d11] p-10 text-white ring-1 ring-white/[0.06] lg:sticky lg:top-2 lg:flex lg:h-[calc(100dvh-6.75rem)] lg:flex-col lg:self-start xl:p-12">
      {/* Fine dots everywhere, and brighter blue dots gathered in a glow behind the headline. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(rgb(255_255_255/0.07)_1px,transparent_1.2px)] bg-[size:6px_6px]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(rgb(96_128_255/0.75)_1.1px,transparent_1.4px)] bg-[size:7px_7px] [mask-image:radial-gradient(circle_at_72%_30%,black_0%,rgb(0_0_0/0.6)_14%,transparent_38%)]" />
      <div aria-hidden className="pointer-events-none absolute top-[-6rem] right-[-4rem] -z-10 size-[30rem] rounded-full bg-[radial-gradient(closest-side,rgb(33_66_231/0.35),transparent)] blur-2xl" />

      {kind === 'signin' ? (
        <div className="my-auto">
          <h2 className="max-w-md text-[40px] leading-[1.08] font-semibold tracking-[-0.03em] text-balance xl:text-[46px]">
            Welcome back. Your orders are where you left them.
          </h2>
          <div className="mt-10 grid grid-cols-2 gap-3">
            {TILES.map((t) => (
              <div key={t.title} className="rounded-2xl bg-white/[0.045] p-4 ring-1 ring-white/[0.08] backdrop-blur-sm">
                <t.icon className="size-[18px] text-[#8ea2ff]" aria-hidden />
                <p className="mt-3 text-[14px] leading-snug font-semibold">{t.title}</p>
                <p className="mt-0.5 text-[12.5px] text-white/55">{t.text}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <h2 className="mt-6 max-w-lg text-[40px] leading-[1.08] font-semibold tracking-[-0.03em] text-balance xl:text-[46px]">
            Ready to grow your cash-on-delivery business?
          </h2>
          <p className="mt-3 text-sm text-white/55">Built for online sellers in Bangladesh.</p>
          {/* The cards run off the bottom of the panel and fade out. */}
          <div className="mt-10 grid min-h-0 flex-1 content-start gap-3 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
            {PROMISES.map((p) => (
              <div key={p.line} className="rounded-2xl bg-white/[0.045] p-5 ring-1 ring-white/[0.08] backdrop-blur-sm">
                <p className="text-[15px] leading-snug font-medium">“{p.line}”</p>
                <div className="mt-4 flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-[#2142e7]/25 ring-1 ring-[#8ea2ff]/30"><p.icon className="size-4 text-[#b7c3ff]" aria-hidden /></span>
                  <span className="text-[13px] text-white/60">{p.text}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Sign-in, sign-up and the password screens: the logo on top, then one large rounded box with the
 * form on the left and the dark brand panel on the right (the panel only on large screens). Light
 * and dark follow the admin's theme; the brand panel is always dark.
 */
export function AuthShell({ children, footer, wide, className, panel = 'signin' }: {
  children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string; panel?: 'signin' | 'signup'
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#f2f3f6] px-2 pb-2 sm:px-4 sm:pb-4 dark:bg-[#0a0a0b]">
      <header className="flex justify-center py-4 sm:py-5">
        <a href={`${SITE}/`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="Fullfilio home">
          <Logo size="lg" />
        </a>
      </header>
      <div className="mx-auto grid w-full max-w-[1400px] flex-1 gap-2 rounded-[28px] bg-white p-2 shadow-sm ring-1 ring-black/[0.05] lg:grid-cols-2 dark:bg-[#18181b] dark:ring-white/[0.06]">
        <div className="flex min-h-[calc(100dvh-6.75rem)] flex-col px-3 py-8 sm:px-10">
          <div className={cn('mx-auto flex w-full flex-1 flex-col justify-center', wide ? 'max-w-[560px]' : 'max-w-[400px]', className)}>
            {children}
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {footer ?? (
              <>
                <span>© {new Date().getFullYear()} Fullfilio</span>
                <a href={`${SITE}/privacy`} className="hover:text-foreground">Privacy</a>
                <a href={`${SITE}/terms`} className="hover:text-foreground">Terms</a>
                <a href={`${SITE}/contact`} className="hover:text-foreground">Help</a>
              </>
            )}
          </div>
        </div>
        <BrandPanel kind={panel} />
      </div>
    </div>
  )
}

/**
 * A small form page (password reset and similar): the sign-in look in the admin,
 * a plain card on the storefront (which carries the store's brand).
 */
export function AuthFrame({ admin, title, description, children }: { admin: boolean; title: string; description?: ReactNode; children: ReactNode }) {
  if (admin) {
    return (
      <AuthShell>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">{title}</h1>
        {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-8">{children}</div>
      </AuthShell>
    )
  }
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <div className="rounded-2xl border bg-card p-6 shadow-xs">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}

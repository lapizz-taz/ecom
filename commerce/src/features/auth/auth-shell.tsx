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
    <div className="relative isolate hidden overflow-hidden rounded-[22px] bg-[#0c0d11] p-10 text-white ring-1 ring-white/[0.06] lg:sticky lg:top-4 lg:flex lg:h-[calc(100dvh-2rem)] lg:flex-col lg:self-start xl:p-12">
      {/* Fine dots everywhere, and brighter blue dots gathered in a glow behind the headline. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(rgb(255_255_255/0.07)_1px,transparent_1.2px)] bg-[size:6px_6px]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(rgb(96_128_255/0.75)_1.1px,transparent_1.4px)] bg-[size:7px_7px] [mask-image:radial-gradient(circle_at_72%_30%,black_0%,rgb(0_0_0/0.6)_14%,transparent_38%)]" />
      <div aria-hidden className="pointer-events-none absolute top-[-6rem] right-[-4rem] -z-10 size-[30rem] rounded-full bg-[radial-gradient(closest-side,rgb(33_66_231/0.35),transparent)] blur-2xl" />

      {kind === 'signin' ? (
        <div className="my-auto">
          <h2 className="max-w-sm text-[30px] leading-[1.15] font-medium tracking-[-0.025em] text-balance xl:text-[34px]">
            Welcome back. Your orders are where you left them.
          </h2>
          <div className="mt-9 grid grid-cols-2 gap-2.5">
            {TILES.map((t) => (
              <div key={t.title} className="rounded-2xl bg-white/[0.045] p-4 ring-1 ring-white/[0.08] backdrop-blur-sm">
                <t.icon className="size-4 text-[#8ea2ff]" aria-hidden />
                <p className="mt-2.5 text-[13px] leading-snug font-medium">{t.title}</p>
                <p className="mt-0.5 text-[12px] text-white/50">{t.text}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="my-auto">
          <h2 className="max-w-md text-[30px] leading-[1.15] font-medium tracking-[-0.025em] text-balance xl:text-[34px]">
            Ready to grow your cash-on-delivery business?
          </h2>
          <p className="mt-3 text-[13px] text-white/50">Built for online sellers in Bangladesh.</p>
          <div className="mt-9 grid gap-2.5">
            {PROMISES.map((p) => (
              <div key={p.line} className="rounded-2xl bg-white/[0.045] p-4 ring-1 ring-white/[0.08] backdrop-blur-sm">
                <p className="text-[13.5px] leading-snug">“{p.line}”</p>
                <div className="mt-3 flex items-center gap-2.5">
                  <span className="flex size-7 items-center justify-center rounded-full bg-[#2142e7]/25 ring-1 ring-[#8ea2ff]/30"><p.icon className="size-3.5 text-[#b7c3ff]" aria-hidden /></span>
                  <span className="text-[12px] text-white/50">{p.text}</span>
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
 * Sign-in, sign-up and the password screens: the logo and the form straight on the page on the
 * left, and the dark brand panel on the right (the panel only on large screens). Light and dark
 * follow the admin's theme; the brand panel is always dark.
 */
export function AuthShell({ children, footer, wide, className, panel = 'signin' }: {
  children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string; panel?: 'signin' | 'signup'
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background p-2 sm:p-4">
      <div className="mx-auto grid w-full max-w-[1400px] flex-1 gap-4 lg:grid-cols-2">
        <div className="flex min-h-[calc(100dvh-1rem)] flex-col px-3 py-8 sm:min-h-[calc(100dvh-2rem)] sm:px-10">
          <div className={cn('mx-auto flex w-full flex-1 flex-col justify-center', wide ? 'max-w-[560px]' : 'max-w-[380px]', className)}>
            <a href={`${SITE}/`} className="mb-8 w-fit rounded-lg focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="Fullfilio home">
              <Logo />
            </a>
            {children}
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
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

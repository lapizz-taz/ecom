import { PackageCheck, ShieldCheck, Truck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Logo } from '@/components/brand/logo'
import { Sparkline } from '@/components/common/sparkline'
import { cn } from '@/lib/utils'

const POINTS = [
  { icon: PackageCheck, title: 'Every order in one list', text: 'Facebook, your website, Shopify and WooCommerce orders land together.' },
  { icon: ShieldCheck, title: 'Check before you ship', text: 'Courier history and duplicate checks flag risky orders first.' },
  { icon: Truck, title: 'Book couriers in one click', text: 'Steadfast, Pathao, RedX and more, with labels ready to print.' },
]

/** The brand side of the sign-in and sign-up screens (large screens only). */
function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden rounded-3xl bg-[#0b0b0d] p-10 text-white lg:sticky lg:top-2 lg:flex lg:h-[calc(100dvh-1rem)] lg:flex-col">
      {/* Soft light from the top corner and a faint grid; no images to download. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 -right-32 size-[34rem] rounded-full bg-[radial-gradient(closest-side,rgb(33_66_231/0.55),transparent)] blur-2xl" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]" />
      <div className="relative">
        <p className="text-sm text-white/60">Order management for online sellers</p>
        <h2 className="mt-3 max-w-md text-[34px] leading-[1.1] font-semibold tracking-[-0.025em]">Every order, from click to doorstep, in one calm place.</h2>
      </div>
      <div className="relative mt-10 grid gap-5">
        {POINTS.map((p) => (
          <div key={p.title} className="flex gap-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.07] ring-1 ring-white/10"><p.icon className="size-[18px] text-white/90" /></span>
            <div>
              <p className="text-[15px] font-medium">{p.title}</p>
              <p className="mt-0.5 text-sm text-white/55">{p.text}</p>
            </div>
          </div>
        ))}
      </div>
      {/* An illustration of the dashboard's order card (not live data). */}
      <div aria-hidden className="relative mt-auto ml-auto w-72 rounded-2xl bg-white/[0.06] p-4 shadow-2xl ring-1 ring-white/10 backdrop-blur">
        <div className="flex items-center justify-between text-xs text-white/55"><span>Approved orders</span><span className="rounded-full bg-emerald-400/15 px-1.5 py-px text-emerald-300">+18%</span></div>
        <p className="mt-1.5 text-2xl font-semibold tracking-[-0.02em]">1,284</p>
        <Sparkline values={[12, 18, 15, 22, 21, 30, 27, 35, 33, 41, 46, 52]} className="mt-2 h-10 text-[#7b8fff]" />
      </div>
    </div>
  )
}

/** Split screen used by sign-in, sign-up and the finishing step: the form on the left, the brand on the right. */
export function AuthShell({ children, footer, wide, className }: { children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="grid min-h-dvh items-start bg-background p-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] lg:gap-2">
      <div className="flex min-h-[calc(100dvh-1rem)] flex-col px-4 py-5 sm:px-8">
        <Link to="/start" className="w-fit rounded-xl focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="Fullfilio">
          <Logo />
        </Link>
        <div className={cn('mx-auto flex w-full flex-1 flex-col justify-center py-10', wide ? 'max-w-[560px]' : 'max-w-[380px]', className)}>
          {children}
        </div>
        <div className="text-center text-xs text-muted-foreground">{footer ?? <>© {new Date().getFullYear()} Fullfilio</>}</div>
      </div>
      <BrandPanel />
    </div>
  )
}

/**
 * A small form page (password reset and similar): the branded split screen
 * in the admin, a plain card on the storefront (which carries the store's brand).
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

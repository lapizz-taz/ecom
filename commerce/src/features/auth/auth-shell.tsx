import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { cn } from '@/lib/utils'

/** The website (sign-in also opens on a store's own domain, where these pages are not the store's). */
const SITE = 'https://fullfilio.com'

/**
 * Sign-in, sign-up and the password screens: one calm column in the middle of the page, on a
 * soft brand light, with the logo above and the small print below. Light and dark follow the
 * admin's theme.
 */
export function AuthShell({ children, footer, wide, className }: { children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-background px-4">
      {/* A soft blue light from the top and a faint grid that fades out; no images to download. */}
      <div aria-hidden className="pointer-events-none absolute top-[-26rem] left-1/2 -z-10 size-[52rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(33_66_231/0.14),transparent)] dark:bg-[radial-gradient(closest-side,rgb(33_66_231/0.32),transparent)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(rgb(15_23_42/0.045)_1px,transparent_1px),linear-gradient(90deg,rgb(15_23_42/0.045)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)] dark:bg-[linear-gradient(rgb(255_255_255/0.045)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.045)_1px,transparent_1px)]" />
      <main className={cn('mx-auto flex w-full flex-1 flex-col justify-center pt-12 pb-8', wide ? 'max-w-[560px]' : 'max-w-[400px]', className)}>
        <a href={`${SITE}/`} className="mx-auto mb-8 rounded-xl focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="Fullfilio home">
          <Logo size="lg" />
        </a>
        {children}
      </main>
      <footer className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 pt-2 pb-8 text-xs text-muted-foreground">
        {footer ?? (
          <>
            <span>© {new Date().getFullYear()} Fullfilio</span>
            <a href={`${SITE}/privacy`} className="hover:text-foreground">Privacy</a>
            <a href={`${SITE}/terms`} className="hover:text-foreground">Terms</a>
            <a href={`${SITE}/contact`} className="hover:text-foreground">Help</a>
          </>
        )}
      </footer>
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

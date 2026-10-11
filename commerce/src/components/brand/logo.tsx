import { cn } from '@/lib/utils'

export const BRAND_NAME = 'Fullfilio'

/**
 * The Fullfilio mark, drawn from public/favicon.svg (the same paths and
 * colours), so the sidebar, sign-in, onboarding and loading screens all show
 * the real logo. On dark grounds a hairline ring keeps its edge visible.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0 rounded-[25%] dark:ring-1 dark:ring-white/15', className)}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <rect width="32" height="32" rx="8" fill="#18181b" />
      <path d="M10 11h12l-1.2 12.2a2 2 0 0 1-2 1.8h-5.6a2 2 0 0 1-2-1.8L10 11Z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M13 11a3 3 0 0 1 6 0" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  )
}

/** Mark + wordmark. `size` scales both together. */
export function Logo({ className, size = 'md', subtitle }: { className?: string; size?: 'sm' | 'md' | 'lg'; subtitle?: string }) {
  const mark = size === 'sm' ? 'size-7' : size === 'lg' ? 'size-11' : 'size-8'
  const word = size === 'sm' ? 'text-[15px]' : size === 'lg' ? 'text-2xl' : 'text-[17px]'
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark className={mark} />
      <span className="min-w-0 leading-tight">
        <span className={cn('block truncate font-semibold tracking-[-0.02em]', word)}>{BRAND_NAME}</span>
        {subtitle && <span className="block truncate text-[11px] font-normal text-muted-foreground">{subtitle}</span>}
      </span>
    </span>
  )
}

/** Full-screen loading screen with the logo, for the admin, Super Admin and onboarding. */
export function BrandLoader({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex min-h-dvh flex-col items-center justify-center gap-5 bg-shell', className)} role="status" aria-live="polite">
      <div className="relative">
        <LogoMark className="size-12 shadow-lg" />
        <span className="absolute -inset-2 animate-pulse rounded-[1.1rem] ring-1 ring-foreground/10 motion-reduce:animate-none" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="h-0.5 w-24 overflow-hidden rounded-full bg-foreground/10">
          <span className="block h-full w-1/3 animate-[loader_1.1s_var(--ease-in-out)_infinite] rounded-full bg-foreground/70 motion-reduce:animate-none" />
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

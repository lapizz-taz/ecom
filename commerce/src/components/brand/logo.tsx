import { cn } from '@/lib/utils'

const BRAND_NAME = 'Fullfilio'

/* The Fullfilio logo, traced from the brand artwork: a split, slanted "F"
   followed by blocky lowercase letters. Paths share one coordinate space so
   the mark (the F alone) and the wordmark line up exactly. */
const F_TOP = 'M256,76H324Q328,76 325,80L294,112H264C248,112 234,118 223,131C219,136 212,134 213,128C217,104 228,76 256,76Z'
const F_BOTTOM = 'M220,178C216,178 215,175 218,172L250,140Q252,138 256,138H286Q291,138 288,142L256,176Q254,178 250,178Z'
const LETTERS = [
  'M322,101H348V158Q348,163 353,163H372V101H399V170Q399,178 391,178H330Q322,178 322,170V140L333,151L340,145L322,127Z',
  'M412,61h18a3,3 0 0 1 3,3v111a3,3 0 0 1-3,3h-18a3,3 0 0 1-3-3V64a3,3 0 0 1 3-3Z',
  'M451,61h18a3,3 0 0 1 3,3v111a3,3 0 0 1-3,3h-18a3,3 0 0 1-3-3V64a3,3 0 0 1 3-3Z',
  'M490,178V117H481a3,3 0 0 1-3-3V96a3,3 0 0 1 3-3H490V82Q490,61 511,61H533Q538,61 538,66V80H521Q516,80 516,85V93H531a3,3 0 0 1 3,3v18a3,3 0 0 1-3,3H516V178Z',
  'M549,98h17a3,3 0 0 1 3,3v74a3,3 0 0 1-3,3h-17a3,3 0 0 1-3-3v-74a3,3 0 0 1 3-3Z',
  'M551,64h13a5,5 0 0 1 5,5v17a5,5 0 0 1-5,5h-13a5,5 0 0 1-5-5v-17a5,5 0 0 1 5-5Z',
  'M587,61h17a3,3 0 0 1 3,3v111a3,3 0 0 1-3,3h-17a3,3 0 0 1-3-3V64a3,3 0 0 1 3-3Z',
  'M624,98h18a3,3 0 0 1 3,3v74a3,3 0 0 1-3,3h-18a3,3 0 0 1-3-3v-74a3,3 0 0 1 3-3Z',
  'M626,58h14a5,5 0 0 1 5,5v17a5,5 0 0 1-5,5h-14a5,5 0 0 1-5-5v-17a5,5 0 0 1 5-5Z',
  'M670,96H738Q746,96 746,104V150L722,178H670Q660,178 660,168V106Q660,96 670,96ZM690,122V150H714V122Z',
]

/** The "Fullfilio" wordmark in the current text colour. */
export function Wordmark({ className, title = BRAND_NAME }: { className?: string; title?: string }) {
  return (
    <svg viewBox="206 52 546 134" className={cn('h-6 w-auto shrink-0', className)} fill="currentColor" role="img" aria-label={title}>
      <path d={F_TOP} /><path d={F_BOTTOM} />
      {LETTERS.map((d) => <path key={d} d={d} fillRule="evenodd" />)}
    </svg>
  )
}

/* The app icon: two interlocking L shapes that form a cube around a square
   hole, on the brand blue. Same geometry as public/favicon.svg. */
const MARK_TOP = 'M8 24 24 8H56V38H40V24Z'
const MARK_BOTTOM = 'M8 26H24V40H56L40 56H8Z'

/** The app icon (same as favicon.svg). */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-8 shrink-0 rounded-[25%] dark:ring-1 dark:ring-white/15', className)}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <rect width="64" height="64" rx="16" fill="#2142e7" />
      <g fill="#fff" stroke="#fff" strokeWidth="1" strokeLinejoin="round"><path d={MARK_TOP} /><path d={MARK_BOTTOM} /></g>
    </svg>
  )
}

/** The wordmark with an optional subtitle. `size` scales it. */
export function Logo({ className, size = 'md', subtitle }: { className?: string; size?: 'sm' | 'md' | 'lg'; subtitle?: string }) {
  const h = size === 'sm' ? 'h-[18px]' : size === 'lg' ? 'h-8' : 'h-[22px]'
  return (
    <span className={cn('inline-flex min-w-0 flex-col justify-center gap-1', className)}>
      <Wordmark className={h} />
      {subtitle && <span className="block truncate text-[11px] leading-none font-medium tracking-wide text-muted-foreground uppercase">{subtitle}</span>}
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

import { cn } from '@/lib/utils'

const BRAND_NAME = 'Fullfilio'

/* The Fullfilio wordmark, traced from the brand artwork (October 2026): a split, slanted
   "F", blocky lowercase letters with an even 16-unit gap, an "i" cut on the same slant as
   the F, a round dot on the last "i", and an "o" drawn as the cube from the app icon.
   Coordinates are the artwork's pixels; the baseline is y = 283. */
const WORDMARK = [
  'M75,224C82,198 88,176 94,152C100,122 116,98 150,95H311L240,165H158C138,166 124,173 113,184C100,196 90,210 81,223C79,226 76,226 75,224Z', // F, top stroke
  'M157,214H238L168,284H86Z', // F, bottom stroke
  'M298,132H349V231A25,25 0 0 0 399,231V132H450V238A45,45 0 0 1 405,283H303Q298,283 298,278V233H346L298,178Z', // u (notched like the F)
  'M467,70H512V283H467Z', // l
  'M529,70H574V283H529Z', // l
  'M616,283V110A40,40 0 0 1 656,70H705V108H660V134H698V170H660V283ZM590,134H616V170H590Z', // f
  'M721,70H772V115H758L721,139.7Z', // i, above the cut
  'M721,157.5L756,134H772V283H721Z', // i, below the cut
  'M789,70H834V283H789Z', // l
  'M876.5,63A26,26 0 1 1 876.5,115A26,26 0 1 1 876.5,63Z', // i, dot
  'M854,134H899V283H854Z', // i, stem
  'M972,117H1083V231H1028V175H919V170Z', // o, upper block (the cube icon)
  'M916,178H974V233H1083L1033,283H916Z', // o, lower block
]
const VIEWBOX = '73 60 1015 226'

/** The "Fullfilio" wordmark in the current text colour. */
export function Wordmark({ className, title = BRAND_NAME }: { className?: string; title?: string }) {
  return (
    <svg viewBox={VIEWBOX} className={cn('h-6 w-auto shrink-0', className)} fill="currentColor" role="img" aria-label={title}>
      {WORDMARK.map((d) => <path key={d} d={d} fillRule="evenodd" />)}
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

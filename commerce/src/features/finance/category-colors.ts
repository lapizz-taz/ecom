/** Category colours: a dot, a soft tint for matrix cells and a readable text tone. Full class names so Tailwind keeps them. */
export const CATEGORY_COLORS = {
  violet: { dot: 'bg-violet-500', soft: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-300', ring: 'ring-violet-500/30' },
  blue: { dot: 'bg-blue-500', soft: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-300', ring: 'ring-blue-500/30' },
  teal: { dot: 'bg-teal-500', soft: 'bg-teal-500/10', text: 'text-teal-600 dark:text-teal-300', ring: 'ring-teal-500/30' },
  amber: { dot: 'bg-amber-500', soft: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-300', ring: 'ring-amber-500/30' },
  orange: { dot: 'bg-orange-500', soft: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-300', ring: 'ring-orange-500/30' },
  red: { dot: 'bg-red-500', soft: 'bg-red-500/10', text: 'text-red-600 dark:text-red-300', ring: 'ring-red-500/30' },
  emerald: { dot: 'bg-emerald-500', soft: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-300', ring: 'ring-emerald-500/30' },
  pink: { dot: 'bg-pink-500', soft: 'bg-pink-500/10', text: 'text-pink-600 dark:text-pink-300', ring: 'ring-pink-500/30' },
  cyan: { dot: 'bg-cyan-500', soft: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-300', ring: 'ring-cyan-500/30' },
  lime: { dot: 'bg-lime-500', soft: 'bg-lime-500/10', text: 'text-lime-700 dark:text-lime-300', ring: 'ring-lime-500/30' },
  indigo: { dot: 'bg-indigo-500', soft: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-300', ring: 'ring-indigo-500/30' },
  rose: { dot: 'bg-rose-500', soft: 'bg-rose-500/10', text: 'text-rose-600 dark:text-rose-300', ring: 'ring-rose-500/30' },
  sky: { dot: 'bg-sky-500', soft: 'bg-sky-500/10', text: 'text-sky-600 dark:text-sky-300', ring: 'ring-sky-500/30' },
  yellow: { dot: 'bg-yellow-500', soft: 'bg-yellow-500/10', text: 'text-yellow-700 dark:text-yellow-300', ring: 'ring-yellow-500/30' },
  fuchsia: { dot: 'bg-fuchsia-500', soft: 'bg-fuchsia-500/10', text: 'text-fuchsia-600 dark:text-fuchsia-300', ring: 'ring-fuchsia-500/30' },
  slate: { dot: 'bg-slate-500', soft: 'bg-slate-500/10', text: 'text-slate-600 dark:text-slate-300', ring: 'ring-slate-500/30' },
} as const

export type CategoryColor = keyof typeof CATEGORY_COLORS
export const COLOR_NAMES = Object.keys(CATEGORY_COLORS) as CategoryColor[]
export const colorOf = (c: string | null | undefined) => CATEGORY_COLORS[(c ?? 'slate') as CategoryColor] ?? CATEGORY_COLORS.slate

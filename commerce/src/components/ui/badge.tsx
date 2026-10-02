import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
        warning: 'border-transparent bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
        danger: 'border-transparent bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
        info: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
        violet: 'border-transparent bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
        neutral: 'border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>
export { Badge, badgeVariants }

import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 ease-out outline-none active:not-disabled:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/80 ring-inset hover:bg-primary/88',
        brand: 'bg-brand text-brand-foreground shadow-sm ring-1 ring-black/10 ring-inset hover:bg-brand/90',
        destructive: 'bg-destructive text-white shadow-sm hover:bg-destructive/90 focus-visible:ring-destructive/25',
        outline: 'border border-input bg-card text-foreground shadow-xs hover:border-foreground/20 hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70 dark:hover:bg-accent',
        ghost: 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
        link: 'h-auto px-0 text-brand underline-offset-4 hover:underline has-[>svg]:px-0',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 rounded-[7px] px-3 text-[13px] has-[>svg]:px-2.5',
        lg: 'h-11 rounded-lg px-6 text-[15px] has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8 rounded-[7px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="button" data-variant={variant ?? 'default'} data-size={size ?? 'default'} className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }

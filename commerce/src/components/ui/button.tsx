import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 ease-out outline-none active:not-disabled:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Raised like a physical key (index.css, .btn-3d): black on light, white on dark.
        default: 'btn-3d btn-3d-ink bg-primary text-primary-foreground hover:bg-primary/92',
        brand: 'btn-3d btn-3d-brand bg-brand text-brand-foreground hover:bg-brand/95',
        destructive: 'btn-3d btn-3d-danger bg-destructive text-white hover:bg-destructive/92 focus-visible:ring-destructive/25',
        outline: 'btn-3d btn-3d-paper border border-input bg-card text-foreground hover:border-foreground/15 hover:bg-accent/60',
        secondary: 'btn-3d btn-3d-paper bg-secondary text-secondary-foreground hover:bg-secondary/80 dark:hover:bg-accent',
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

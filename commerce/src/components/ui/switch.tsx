import { Switch as SwitchPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '@/lib/utils'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-out data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-[#0f0f11]" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }

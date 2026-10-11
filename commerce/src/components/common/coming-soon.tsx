import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Shown in place of a feature the platform has not opened yet. */
export function ComingSoon({ title, description, icon, className }: { title: string; description?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center', className)}>
      <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-xs [&_svg]:size-5">{icon ?? <Sparkles />}</span>
      <span className="mt-5 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand">Coming soon</span>
      <h1 className="mt-3 text-xl font-semibold tracking-[-0.02em]">{title}</h1>
      {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

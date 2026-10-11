import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * Page title row: an optional back link, the title with a short description,
 * and the page's actions on the right (they wrap under the title on phones).
 */
export function PageHeader({ title, description, actions, className, back, icon }: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
  /** A link back to the parent page, shown above the title. */
  back?: { to: string; label: string }
  icon?: ReactNode
}) {
  return (
    <div className={cn('mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronLeft className="size-3.5" /> {back.label}
          </Link>
        )}
        <div className="flex min-w-0 items-center gap-3">
          {icon && <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground [&_svg]:size-4">{icon}</span>}
          <h1 className="truncate text-xl leading-tight font-semibold tracking-[-0.02em] sm:text-[22px]">{title}</h1>
        </div>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:max-w-[65%] sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  )
}

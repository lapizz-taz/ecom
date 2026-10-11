import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from 'react'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Label + control + hint/error, wired for accessibility (the label names its control). */
export function Field({ label, htmlFor, error, hint, required, className, children }: {
  label: ReactNode
  htmlFor?: string
  error?: string
  hint?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
}) {
  const auto = useId()
  // A single control without an id gets one, so clicking or reading the label finds it.
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null
  const ownId = only?.props.id
  const id = htmlFor ?? ownId ?? (only ? auto : undefined)
  const control = only && !htmlFor && !ownId ? cloneElement(only, { id: auto }) : children
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {control}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

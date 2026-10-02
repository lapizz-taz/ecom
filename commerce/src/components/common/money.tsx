import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Money({ value, className, signed, muted }: { value: unknown; className?: string; signed?: boolean; muted?: boolean }) {
  return <span className={cn('tabular-nums', muted && 'text-muted-foreground', className)}>{formatMoney(value, { signed })}</span>
}

import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { titleCase } from '@/lib/format'

export function StatusBadge<K extends string>({ value, map, className }: { value: K | null | undefined; map: Record<K, { label: string; variant: BadgeVariant }>; className?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  const meta = map[value]
  return <Badge variant={meta?.variant ?? 'neutral'} className={className}>{meta?.label ?? titleCase(value)}</Badge>
}

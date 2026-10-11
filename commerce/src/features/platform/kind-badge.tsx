import { Badge } from '@/components/ui/badge'

/** Labels a figure as recorded, estimated or calculated, so they are never mixed up. */
export function Kind({ kind }: { kind: 'actual' | 'estimate' | 'calculated' }) {
  const map = { actual: ['Recorded', 'success'], estimate: ['Estimate', 'warning'], calculated: ['Calculated', 'info'] } as const
  return <Badge variant={map[kind][1]} className="text-[10px]">{map[kind][0]}</Badge>
}

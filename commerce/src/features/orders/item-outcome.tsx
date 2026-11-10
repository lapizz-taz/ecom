import { cn } from '@/lib/utils'

// What happened to each item of a partly delivered (or returned) order: the customer kept it,
// it is on its way back (recorded with "Partial delivery…"), it came back to stock, or it came
// back damaged.

export interface ItemOutcome { kept: number; coming: number; returned: number; damaged: number }

/** One item's outcome. `partial`: the order is partly delivered. Null when there is nothing to say. */
export function itemOutcome(quantity: number, returned = 0, damaged = 0, expectedBack = 0, partial = false): ItemOutcome | null {
  const back = returned + damaged
  if (!partial) return back > 0 ? { kept: 0, coming: 0, returned, damaged } : null
  return {
    kept: Math.max(quantity - Math.max(expectedBack, back), 0),
    coming: Math.max(expectedBack - back, 0),
    returned,
    damaged,
  }
}

/** Whether anything was recorded for a partly delivered order (what was sent back, or what came back). */
export const partialRecorded = (lines: Array<{ returned?: number; damaged?: number; expected_back?: number }>) =>
  lines.some((l) => (l.expected_back ?? 0) > 0 || (l.returned ?? 0) + (l.damaged ?? 0) > 0)

/** What "Partial delivery…" last recorded as sent back, per order item (from the order's history). */
export function recordedBack(history: Array<{ created_at: string; metadata?: unknown }>): Map<string, number> {
  const out = new Map<string, number>()
  const last = [...history]
    .filter((h) => { const m = h.metadata as Record<string, unknown> | null | undefined; return !!m && 'returned_value' in m && Array.isArray(m.items) })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  for (const x of ((last?.metadata as { items?: Array<{ order_item_id?: string; quantity?: number }> } | undefined)?.items ?? [])) {
    if (x.order_item_id) out.set(x.order_item_id, (out.get(x.order_item_id) ?? 0) + Math.max(Number(x.quantity) || 0, 0))
  }
  return out
}

const TONE = {
  kept: 'bg-emerald-50 text-emerald-700',
  coming: 'bg-sky-50 text-sky-700',
  returned: 'bg-amber-50 text-amber-800',
  damaged: 'bg-red-50 text-red-700',
} as const
const LABEL = { kept: 'Delivered', coming: 'Coming back', returned: 'Returned', damaged: 'Damaged' } as const

/** "Delivered", "Coming back 1", "Returned", "Damaged": one small tag per part of the item. */
export function OutcomeTags({ outcome, quantity, className }: { outcome: ItemOutcome; quantity: number; className?: string }) {
  const parts = (['kept', 'coming', 'returned', 'damaged'] as const).filter((k) => outcome[k] > 0)
  if (!parts.length) return null
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {parts.map((k) => (
        <span key={k} className={cn('rounded px-1.5 py-px text-[10px] font-medium whitespace-nowrap', TONE[k])}>
          {LABEL[k]}{quantity > 1 || outcome[k] !== quantity ? ` ${outcome[k]}` : ''}
        </span>
      ))}
    </span>
  )
}

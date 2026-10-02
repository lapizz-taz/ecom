import { CircleCheck, Loader2, PhoneCall, ShieldAlert, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Money } from '@/components/common/money'
import { cn } from '@/lib/utils'
import type { PaymentMethod, PaymentRequirement } from '@/types/domain'

type CheckState = 'checking' | 'cod' | 'advance' | 'review' | 'blocked' | 'checked'

/** What the server decided for this number, from the customer's point of view. */
export function phoneCheckState(checking: boolean, requirement: PaymentRequirement | null | undefined, method: PaymentMethod): CheckState {
  if (checking || !requirement) return 'checking'
  if (requirement.mode === 'BLOCKED') return 'blocked'
  if (requirement.mode === 'REVIEW') return 'review'
  // The customer chose to pay online: nothing to say about cash on delivery.
  if (method !== 'COD') return 'checked'
  return requirement.mode === 'COD' ? 'cod' : 'advance'
}

/** Small icon inside the phone field. */
export function PhoneCheckIcon({ state }: { state: CheckState | null }) {
  if (!state) return null
  const cls = 'pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2'
  if (state === 'checking') return <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} aria-hidden />
  if (state === 'cod' || state === 'checked') return <CircleCheck className={cn(cls, 'text-emerald-600')} aria-hidden />
  if (state === 'advance') return <Wallet className={cn(cls, 'text-amber-600')} aria-hidden />
  if (state === 'review') return <PhoneCall className={cn(cls, 'text-sky-600')} aria-hidden />
  return <ShieldAlert className={cn(cls, 'text-red-600')} aria-hidden />
}

/**
 * One line under the phone field. Shows only what the customer has to do —
 * never a score, a delivery rate or courier history.
 */
export function PhoneCheckStatus({ state, requirement }: { state: CheckState | null; requirement: PaymentRequirement | null | undefined }) {
  if (!state) return null
  const lines: Record<CheckState, { cls: string; text: ReactNode }> = {
    checking: { cls: 'text-muted-foreground', text: 'Checking delivery options for this number…' },
    cod: { cls: 'text-emerald-700', text: 'Cash on delivery available' },
    checked: { cls: 'text-emerald-700', text: 'Number confirmed' },
    advance: { cls: 'text-amber-800', text: <>Pay <Money value={requirement?.amount ?? 0} /> delivery charge in advance to confirm</> },
    review: { cls: 'text-sky-800', text: "We'll call you to confirm this order" },
    blocked: { cls: 'text-red-700', text: 'Please call us to place this order' },
  }
  return (
    <p className={cn('text-xs font-medium', lines[state].cls)} role="status" aria-live="polite">{lines[state].text}</p>
  )
}

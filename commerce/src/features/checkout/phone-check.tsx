import { CircleCheck, Clock, Loader2, ShieldAlert, Wallet } from 'lucide-react'
import { Money } from '@/components/common/money'
import { cn } from '@/lib/utils'
import type { PaymentRequirement } from '@/types/domain'

/**
 * Result of the server-side delivery check for the number the customer typed.
 * Shows only what the customer has to do — never a score or delivery rate.
 */
export function PhoneCheckStatus({ checking, requirement, phoneValid }: {
  checking: boolean
  requirement: PaymentRequirement | null | undefined
  phoneValid: boolean
}) {
  if (!phoneValid) return null
  if (checking || !requirement) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
        <Loader2 className="size-4 animate-spin" /> Checking delivery options for this number…
      </p>
    )
  }
  const tone = {
    COD: { icon: CircleCheck, cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', title: 'Cash on delivery available', body: 'Pay when your order arrives.' },
    ADVANCE: { icon: Wallet, cls: 'border-amber-200 bg-amber-50 text-amber-950', title: 'Small advance needed', body: null },
    FULL: { icon: Wallet, cls: 'border-amber-200 bg-amber-50 text-amber-950', title: 'Payment needed', body: null },
    REVIEW: { icon: Clock, cls: 'border-sky-200 bg-sky-50 text-sky-950', title: 'We will call to confirm', body: requirement.message },
    BLOCKED: { icon: ShieldAlert, cls: 'border-red-200 bg-red-50 text-red-900', title: 'Online order unavailable', body: requirement.message },
  }[requirement.mode]
  const Icon = tone.icon
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm', tone.cls)} role="status" aria-live="polite">
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{tone.title}</p>
        <p className="mt-0.5 opacity-90">
          {tone.body ?? (
            <>
              Pay <strong><Money value={requirement.amount} /></strong> now with bKash or Nagad
              {requirement.remaining_cod !== undefined && requirement.remaining_cod > 0 && <>, and <Money value={requirement.remaining_cod} /> when it arrives</>}.
            </>
          )}
        </p>
      </div>
    </div>
  )
}

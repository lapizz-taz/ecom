import { useEffect } from 'react'
import { PageHeader } from '@/components/common/page-header'
import { CreditsSection } from '@/features/billing/credits-section'
import { DataDeletionCard } from '@/features/billing/data-deletion-card'
import { PlanPicker } from '@/features/billing/plan-picker'
import { PlanSummary } from '@/features/billing/plan-summary'
import { useUrlState } from '@/hooks/use-url-state'
import { toast } from '@/lib/toast'

const RESULT: Record<string, { ok: boolean; text: string }> = {
  success: { ok: true, text: 'Payment confirmed — thank you. It has been applied.' },
  failed: { ok: false, text: 'The payment did not go through. Nothing was charged.' },
  cancelled: { ok: false, text: 'Payment cancelled.' },
  review: { ok: false, text: 'We could not confirm the payment yet. If money was taken, it is checked again automatically within a few minutes.' },
  unknown: { ok: false, text: 'We could not match that payment. If money was taken, contact the platform team with the transaction ID.' },
}

export default function PlanBillingPage() {
  const [state, update] = useUrlState({ payment: '', invoice: '' })
  useEffect(() => {
    const r = RESULT[state.payment]
    if (!r) return
    if (r.ok) toast.success(r.text)
    else toast.error(r.text)
    update({ payment: '', invoice: '' })
  }, [state.payment, update])
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Plan & Billing" description="Your plan, what it includes, how much of it you use, your invoices and credits." />
        <PlanSummary />
      </div>
      <PlanPicker />
      <CreditsSection />
      <DataDeletionCard />
    </div>
  )
}

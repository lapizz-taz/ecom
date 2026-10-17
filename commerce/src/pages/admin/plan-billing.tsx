import { PageHeader } from '@/components/common/page-header'
import { BuySection, PaymentHistory, PaymentResultBanner } from '@/features/billing/billing-payments'
import { CreditsSection } from '@/features/billing/credits-section'
import { DataDeletionCard } from '@/features/billing/data-deletion-card'
import { PlanSummary } from '@/features/billing/plan-summary'
import { useUrlState } from '@/hooks/use-url-state'

export default function PlanBillingPage() {
  // Set by the gateway return (billing function): success, failed, cancelled, review or unknown.
  const [state, update] = useUrlState({ payment: '', invoice: '' })
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Billing & Payments" description="Your plan, credits and balance, buying more, and every payment you made." />
        {state.payment && (
          <div className="mb-4">
            <PaymentResultBanner outcome={state.payment} invoiceId={state.invoice} onDismiss={() => update({ payment: '', invoice: '' })} />
          </div>
        )}
        <PlanSummary />
      </div>
      <BuySection />
      <CreditsSection />
      <PaymentHistory />
      <DataDeletionCard />
    </div>
  )
}

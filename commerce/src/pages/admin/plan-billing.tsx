import { PageHeader } from '@/components/common/page-header'
import { PlanSummary } from '@/features/billing/plan-summary'

export default function PlanBillingPage() {
  return (
    <div>
      <PageHeader title="Plan & Billing" description="Your plan, what it includes, how much of it you use, and your invoices." />
      <PlanSummary />
    </div>
  )
}

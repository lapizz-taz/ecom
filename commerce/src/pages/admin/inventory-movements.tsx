import { PageHeader } from '@/components/common/page-header'
import { MovementsTable } from '@/features/inventory/movements-table'

export default function InventoryMovementsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Stock movements" description="The immutable ledger of every stock change — sales, returns, purchases, reservations and adjustments." />
      <MovementsTable title="Stock movements" />
    </div>
  )
}

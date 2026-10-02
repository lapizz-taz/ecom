import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { Can } from '@/components/common/permission-gate'
import { Button } from '@/components/ui/button'
import { AdjustStockDialog } from '@/features/inventory/adjust-stock-dialog'
import { MovementsTable } from '@/features/inventory/movements-table'

export default function InventoryAdjustmentsPage() {
  const [params] = useSearchParams()
  const [open, setOpen] = useState(params.get('new') === '1')
  return (
    <div className="space-y-4">
      <PageHeader title="Stock adjustments" description="Manual corrections, damage, losses and stock received without a purchase order."
        actions={<Can permission="inventory.adjust"><Button size="sm" onClick={() => setOpen(true)}><Plus /> New adjustment</Button></Can>} />
      <MovementsTable title="Stock adjustments" types={['ADJUSTMENT', 'DAMAGE', 'LOSS', 'TRANSFER', 'PURCHASE']} />
      <AdjustStockDialog target={null} open={open} onOpenChange={setOpen} />
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { toast } from '@/lib/toast'
import { branchesOverview, setOrdersBranch } from '@/services/branches'

const LOCKED = ['SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST', 'CANCELLED', 'REJECTED_FRAUD']

/** Which branch ships the order (only with branch stock on); its stock leaves that branch when it ships. */
export function OrderBranch({ orderId, branchId, status }: { orderId: string; branchId: string | null; status: string }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const overview = useQuery({ queryKey: ['branches'], queryFn: branchesOverview, enabled: can('inventory.view'), staleTime: 5 * 60_000 })
  const set = useMutation({
    mutationFn: (id: string | null) => setOrdersBranch([orderId], id),
    onSuccess: () => { toast.success('Branch changed'); void queryClient.invalidateQueries({ queryKey: ['order', orderId] }) },
    onError: (e) => toast.error(e),
  })
  const o = overview.data
  if (!o?.enabled) return null
  const branches = o.branches.filter((b) => b.is_active)
  const central = branches.find((b) => b.is_central)
  const current = branchId ?? central?.id ?? ''
  const editable = can('orders.update') && !LOCKED.includes(status)
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <span className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="size-3.5" /> Ships from</span>
      {editable ? (
        <Select value={current} onValueChange={(v) => set.mutate(v === central?.id && !branchId ? null : v)} disabled={set.isPending}>
          <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}{b.is_central ? ' (central)' : ''}</SelectItem>)}</SelectContent>
        </Select>
      ) : <span className="font-medium">{branches.find((b) => b.id === current)?.name ?? '—'}</span>}
    </div>
  )
}

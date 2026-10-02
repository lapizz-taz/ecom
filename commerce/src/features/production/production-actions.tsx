import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { PRODUCTION_ACTIONS, type ProductionAction, productionAction } from '@/services/production'
import type { Enums } from '@/types/database'

/** Buttons for the next production steps; the database validates each move. */
export function ProductionActions({ id, status, size = 'sm', compact }: { id: string; status: Enums<'production_status'>; size?: 'sm' | 'default'; compact?: boolean }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const run = useMutation({
    mutationFn: ({ action, note }: { action: ProductionAction; note?: string }) => productionAction(id, action, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['production'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      toast.success('Production updated')
    },
  })
  if (!can('production.manage')) return null
  const actions = PRODUCTION_ACTIONS[status].slice(0, compact ? 1 : undefined)
  return (
    <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
      {actions.map((a) => (
        <Button key={a.action} size={size} variant={a.variant ?? 'default'} disabled={run.isPending}
          onClick={() => (a.needsNote ? setRejecting(true) : run.mutate({ action: a.action }))}>
          {a.label}
        </Button>
      ))}
      <ConfirmDialog open={rejecting} onOpenChange={setRejecting} title="Reject in quality check" description="The order goes back to production."
        reason reasonRequired reasonLabel="What needs fixing?" destructive confirmLabel="Reject"
        onConfirm={(note) => run.mutateAsync({ action: 'REJECT', note })} />
    </div>
  )
}

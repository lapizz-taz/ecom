import { useMutation, useQuery } from '@tanstack/react-query'
import { Ban, Check, ChevronDown, CircleCheck, Loader2, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { StatusBadge } from '@/components/common/status-badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/features/auth/auth-context'
import { CANCEL_VIA_COURIER, CANCELLABLE, NEEDS_REASON, NEXT_ACTIONS, ORDER_STATUS } from '@/lib/status'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { approveOrders, listReviewStatuses, setWebOrderStatus, transitionOrder } from '@/services/orders'
import type { OrderStatus } from '@/types/domain'

/**
 * An order's status that can be changed in place: the same next steps the order
 * page offers (NEXT_ACTIONS), cancelling with a reason, and nothing the database
 * would refuse anyway (it checks the move and the staff member's permission).
 */
export function OrderStatusMenu({ orderId, orderNumber, status, web = false, reviewStatus, onChanged, className }: {
  orderId: string
  orderNumber: string
  status: OrderStatus
  /** A web order (not approved yet): approved with the fee, and worked with review statuses. */
  web?: boolean
  reviewStatus?: string | null
  onChanged?: () => void
  className?: string
}) {
  const { can } = useAuth()
  const [asking, setAsking] = useState<OrderStatus | null>(null)
  const move = useMutation({
    mutationFn: ({ to, note }: { to: OrderStatus; note: string }) => transitionOrder(orderId, to, note),
    onSuccess: (_, v) => {
      toast.success(`${orderNumber}: ${ORDER_STATUS[v.to]?.label ?? v.to}`)
      onChanged?.()
    },
  })
  // Approving goes through approve_orders (fraud and limit checks, the per-order charge), as on Web Orders.
  const approve = useMutation({
    mutationFn: () => approveOrders([orderId]),
    onSuccess: (r) => {
      if (r.failed.length) toast.error(`${orderNumber}: ${r.failed[0].error}`)
      else toast.success(`${orderNumber} approved`)
      onChanged?.()
    },
  })
  const review = useMutation({
    mutationFn: (code: string) => setWebOrderStatus([orderId], code),
    onSuccess: (r, code) => {
      if (r.failed.length) toast.error(`${orderNumber}: ${r.failed[0].error.replace(/^[A-Z_]+: /, '')}`)
      else toast.success(`${orderNumber}: ${reviews.data?.find((x) => x.code === code)?.label ?? code}`)
      onChanged?.()
    },
  })
  const reviews = useQuery({ queryKey: ['review-statuses'], queryFn: () => listReviewStatuses(), enabled: web, staleTime: 5 * 60_000 })
  // Statuses that need a follow-up time are set on Web Orders, where the time is chosen.
  const quickReviews = (reviews.data ?? []).filter((r) => !r.needs_follow_up && r.code !== reviewStatus)
  const busy = move.isPending || approve.isPending || review.isPending
  const next = (NEXT_ACTIONS[status] ?? []).filter((a) => !(web && a.to === 'CONFIRMED'))
  const cancel: OrderStatus | null = CANCEL_VIA_COURIER.includes(status) ? 'PENDING_CANCEL' : CANCELLABLE.includes(status) ? 'CANCELLED' : null
  const canApprove = web && ['PENDING', 'CONFIRMATION_REQUIRED'].includes(status)
  const allowed = can('orders.status') && (next.length > 0 || cancel !== null || canApprove || quickReviews.length > 0)

  if (!allowed) return <StatusBadge value={status} map={ORDER_STATUS} />
  const go = (to: OrderStatus) => (NEEDS_REASON.includes(to) ? setAsking(to) : move.mutate({ to, note: '' }))

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} aria-label={`Change status of ${orderNumber}`}
            className={cn('group inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60', className)}>
            <StatusBadge value={status} map={ORDER_STATUS} />
            {busy
              ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              : <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{web ? `Work on ${orderNumber}` : `Move ${orderNumber} to`}</DropdownMenuLabel>
          {canApprove && (
            <DropdownMenuItem onSelect={() => approve.mutate()}><CircleCheck className="size-4" /> Approve order</DropdownMenuItem>
          )}
          {quickReviews.length > 0 && (
            <>
              {canApprove && <DropdownMenuSeparator />}
              {quickReviews.map((r) => (
                <DropdownMenuItem key={r.code} onSelect={() => review.mutate(r.code)}>
                  <MessageSquare className="size-4" /> {r.label}
                </DropdownMenuItem>
              ))}
            </>
          )}
          {next.map((a) => (
            <DropdownMenuItem key={a.to} onSelect={() => go(a.to)}><Check className="size-4" /> {a.label}</DropdownMenuItem>
          ))}
          {cancel && (
            <>
              {next.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" onSelect={() => setAsking(cancel)}>
                <Ban className="size-4" /> {cancel === 'PENDING_CANCEL' ? 'Ask courier to cancel…' : 'Cancel order…'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asking === 'CANCELLED' ? `Cancel ${orderNumber}?` : `${ORDER_STATUS[asking ?? status]?.label ?? ''}: ${orderNumber}`}
        description={asking === 'CANCELLED' ? 'Reserved stock goes back and the customer is not charged. This cannot be undone.' : undefined}
        destructive={asking === 'CANCELLED' || asking === 'LOST'}
        reason
        reasonRequired={asking !== null && NEEDS_REASON.includes(asking)}
        reasonLabel="Reason (kept in the order history)"
        confirmLabel={asking === 'CANCELLED' ? 'Cancel order' : 'Confirm'}
        onConfirm={(note) => move.mutateAsync({ to: asking!, note })}
      />
    </>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useMemo } from 'react'
import { LoadingState } from '@/components/common/states'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { inboxThread } from '@/services/inbox'

const NewOrderPage = lazy(() => import('@/pages/admin/order-new'))

/**
 * "Open Order Draft": the New Order form over the chat, filled from the
 * conversation (name, number, address, and Smart paste over what the customer
 * wrote). Creating the order links it to the chat.
 */
export function OrderDraftDialog({ conversationId, open, onOpenChange }: { conversationId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const thread = useQuery({ queryKey: ['inbox-thread', conversationId], queryFn: () => inboxThread(conversationId), enabled: open })
  const c = thread.data?.conversation
  const text = useMemo(() => (thread.data?.messages ?? []).filter((m) => m.direction === 'IN' && m.body).slice(-8).map((m) => m.body).join('\n'), [thread.data])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[100dvh] max-h-[100dvh] max-w-full rounded-none sm:h-[94dvh] sm:max-h-[94dvh] sm:max-w-[min(1200px,96vw)] sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle>Chat order draft</DialogTitle>
          <DialogDescription>Review the prefilled New Order form before submitting. The order is linked to this chat.</DialogDescription>
        </DialogHeader>
        {open && c ? (
          <Suspense fallback={<LoadingState />}>
            <NewOrderPage key={c.id} draft={{
              conversation: c.id, name: c.customer_name ?? undefined, phone: c.customer_phone ?? undefined, address: c.customer_address ?? undefined, text,
            }} onCreated={() => {
              onOpenChange(false)
              void qc.invalidateQueries({ queryKey: ['inbox-thread', conversationId] })
              void qc.invalidateQueries({ queryKey: ['inbox-list'] })
            }} />
          </Suspense>
        ) : <LoadingState />}
      </DialogContent>
    </Dialog>
  )
}

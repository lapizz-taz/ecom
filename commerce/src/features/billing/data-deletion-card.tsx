import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate, formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cancelDataDeletion, myDeletionRequest, requestDataDeletion } from '@/services/platform-data'

const STATUS = {
  REQUESTED: { label: 'Waiting for the platform team', variant: 'warning' }, APPROVED: { label: 'Approved', variant: 'info' },
  REJECTED: { label: 'Not approved', variant: 'neutral' }, CANCELLED: { label: 'Withdrawn', variant: 'neutral' }, COMPLETED: { label: 'Erased', variant: 'success' },
} as const

/** The owner asks for the business to be closed and its customers' personal data erased. */
export function DataDeletionCard() {
  const { access } = useAuth()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['my-deletion-request'], queryFn: myDeletionRequest })
  const [asking, setAsking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['my-deletion-request'] })
  const cancel = useMutation({ mutationFn: cancelDataDeletion, onSuccess: () => { toast.success('Request withdrawn'); void refresh() } })
  const r = q.data
  const open = r && (r.status === 'REQUESTED' || r.status === 'APPROVED')
  const isOwner = access?.role === 'OWNER' && !access.support_session
  if (!isOwner && !open) return null
  return (
    <Card className="border-red-500/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Trash2 className="size-4" /> Close the account and erase customer data</CardTitle>
        <CardDescription>
          Your customers' names, phone numbers, emails and addresses are erased. Order amounts, invoices and payments are kept for accounting.
          The platform team checks the request with you first, and nothing is erased for at least two weeks after it is approved — you can withdraw it until then.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {r && (
          <p className="flex flex-wrap items-center gap-2">Request #{r.number} from {formatDate(r.created_at)}: <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
            {r.status === 'APPROVED' && r.erase_after && <span className="text-xs text-muted-foreground">not before {formatDateTime(r.erase_after)}</span>}
            {r.decision_note && r.status === 'REJECTED' && <span className="text-xs text-muted-foreground">{r.decision_note}</span>}</p>
        )}
        {isOwner && (open
          ? <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => setWithdrawing(true)}>Withdraw the request</Button>
          : <Button size="sm" variant="outline" className="text-red-600" onClick={() => setAsking(true)}>Ask to close and erase</Button>)}
      </CardContent>
      {asking && (
        <ConfirmDialog open onOpenChange={setAsking} title="Ask to close the account and erase customer data?" destructive confirmLabel="Send the request"
          reason reasonRequired reasonLabel="Why are you leaving? (at least 5 characters)"
          description="Ask Fullfilio support (help@fullfilio.com) for a copy of your data first if you need one. Your account keeps working until it is closed."
          onConfirm={async (reason) => { await requestDataDeletion(reason); toast.success('Request sent'); void refresh() }} />
      )}
      {withdrawing && (
        <ConfirmDialog open onOpenChange={setWithdrawing} title="Withdraw the request?" confirmLabel="Withdraw" onConfirm={() => cancel.mutateAsync()} />
      )}
    </Card>
  )
}

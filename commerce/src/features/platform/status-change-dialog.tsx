import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { MERCHANT_STATUS } from '@/features/platform/nav'
import { toast } from '@/lib/toast'
import { previewMerchantStatus, setMerchantStatus } from '@/services/platform'

const VERB = { ACTIVE: 'Activate', SUSPENDED: 'Suspend', CLOSED: 'Close' } as const

/**
 * Shows exactly which merchants a status change touches (open orders, live
 * stores, staff) before it runs. Closing an account goes to a second person.
 */
export function StatusChangeDialog({ ids, status, open, onOpenChange, onDone }: {
  ids: string[]
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED'
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const preview = useQuery({ queryKey: ['merchant-status-preview', ids, status], enabled: open, queryFn: () => previewMerchantStatus(ids, status) })
  const changing = preview.data?.items.filter((i) => i.changes && i.allowed) ?? []
  const skipped = preview.data?.items.filter((i) => !i.changes || !i.allowed) ?? []

  const run = async () => {
    if (!preview.data) return
    setBusy(true)
    try {
      const result = await setMerchantStatus(ids, status, reason.trim(), preview.data.token)
      if (result.approval_requests.length) toast.success(`Sent for approval (${result.approval_requests.length})`, { description: 'A second person with approval rights must confirm.' })
      else toast.success(`${VERB[status]}d ${result.changed} merchant${result.changed === 1 ? '' : 's'}`)
      onDone()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{VERB[status]} {ids.length === 1 ? 'merchant' : `${ids.length} merchants`}</DialogTitle>
          <DialogDescription>
            {status === 'SUSPENDED' && 'Staff keep their data; what they can still do follows the access rules for suspended accounts.'}
            {status === 'ACTIVE' && 'The account works normally again.'}
            {status === 'CLOSED' && 'Closing stops the account for good. It is sent to a second person for approval; nothing is deleted.'}
          </DialogDescription>
        </DialogHeader>
        {preview.error ? <ErrorState error={preview.error} /> : !preview.data ? <LoadingState /> : (
          <div className="max-h-72 overflow-y-auto rounded-md border text-sm">
            <table className="w-full">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">Merchant</th><th className="px-3 py-2 font-medium">Now</th><th className="px-3 py-2 text-right font-medium">Open orders</th>
                  <th className="px-3 py-2 text-right font-medium">Live stores</th><th className="px-3 py-2 text-right font-medium">Staff</th></tr>
              </thead>
              <tbody>
                {preview.data.items.map((i) => (
                  <tr key={i.id} className={i.changes && i.allowed ? '' : 'opacity-50'}>
                    <td className="px-3 py-1.5">#{i.number} {i.name}{!i.allowed && <span className="ml-1 text-xs">(not yours)</span>}{!i.changes && <span className="ml-1 text-xs">(already)</span>}</td>
                    <td className="px-3 py-1.5"><StatusBadge value={i.status} map={MERCHANT_STATUS} /></td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.open_orders}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.stores}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{i.staff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {skipped.length > 0 && <p className="text-xs text-muted-foreground">{skipped.length} will be left as they are.</p>}
        <div className="grid gap-2">
          <Label htmlFor="status-reason">Reason (kept in the audit log) *</Label>
          <Textarea id="status-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant={status === 'ACTIVE' ? 'default' : 'destructive'} disabled={busy || !preview.data || changing.length === 0 || reason.trim().length < 5} onClick={run}>
            {busy && <Spinner />} {status === 'CLOSED' ? 'Request approval' : `${VERB[status]} ${changing.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

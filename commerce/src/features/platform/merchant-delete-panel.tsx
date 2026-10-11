import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import type { MerchantDetail } from '@/services/platform'
import { requestMerchantDelete, storeResets } from '@/services/platform-data'

const REMOVES = 'The business and all its data: orders, customers, products and stock, couriers, stores and every connection with its keys, staff, roles, settings, HR, phone system set-up and logs. Logins that belong only to this business are removed here and from the sign-in service (Clerk).'
const KEEPS = 'Money records, for the accounts: plan, invoices and payments, credits and their ledger, order fees, metered usage, phone system charges, and every audit log. They stay under "Deleted merchant #N", with no contact details.'

/**
 * Deleting a merchant takes two people: this asks for it (typed name, reason,
 * fresh export); another Super Admin approves it under Security → Approvals.
 * The database checks every rule again.
 */
export function MerchantDeletePanel({ detail }: { detail: MerchantDetail }) {
  const m = detail.merchant
  const queryClient = useQueryClient()
  const resets = useQuery({ queryKey: ['platform-store-resets', m.id], queryFn: () => storeResets(m.id) })
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [reason, setReason] = useState('')
  const request = useMutation({
    meta: { silent: true },
    mutationFn: () => requestMerchantDelete(m.id, confirm, reason.trim()),
    onSuccess: () => {
      toast.success('Sent for approval', { description: 'Another Super Admin must approve it under Security → Approvals. Nothing is deleted until then.' })
      setOpen(false)
      setConfirm('')
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['platform-approvals'] })
    },
  })
  const exportUntil = resets.data?.export_valid_until
  const exportReady = !!exportUntil && new Date(exportUntil) > new Date()
  const deleted = /^Deleted merchant #\d+$/.test(m.name)
  return (
    <Card className="border-red-300 dark:border-red-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Trash2 className="size-4 text-red-500" /> Delete merchant</CardTitle>
        <p className="text-xs text-muted-foreground">Permanent. Needs a second Super Admin to approve, and a full export from the last 24 hours (step 1 above).</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Removes:</span> {REMOVES}</p>
        <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Keeps:</span> {KEEPS}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {deleted ? 'This merchant was deleted.' : !detail.can.manage ? 'Needs the "manage merchants" permission.'
              : exportReady ? 'You will type the merchant name to confirm.' : 'Download a full export first.'}
          </p>
          <Button size="sm" variant="destructive" disabled={deleted || !detail.can.manage || !exportReady} onClick={() => setOpen(true)}>
            <Trash2 /> Delete merchant…
          </Button>
        </div>
      </CardContent>
      {open && (
        <FormDialog open onOpenChange={(o) => !o && setOpen(false)} title={`Delete ${m.name}?`} submitLabel="Ask for approval" busy={request.isPending}
          disabled={confirm.trim().toLowerCase() !== m.name.trim().toLowerCase() || reason.trim().length < 10} onSubmit={() => request.mutate()}
          description={REMOVES}>
          <Field label={`Type the merchant name (${m.name}) to confirm`} required>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" placeholder={m.name} />
          </Field>
          <Field label="Why" required hint="At least 10 characters; the approver sees it, and it stays in the platform log">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The owner asked to close the account" />
          </Field>
          <p className="text-xs text-muted-foreground">After you ask, another Super Admin approves it under <Link to="/super-admin/security?tab=approvals" className="underline">Security → Approvals</Link>.</p>
          {request.error && <p className="text-sm text-red-500" role="alert">{(request.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
        </FormDialog>
      )}
    </Card>
  )
}

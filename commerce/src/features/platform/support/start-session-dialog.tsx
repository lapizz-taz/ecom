import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MerchantPicker } from '@/features/platform/services/merchant-picker'
import type { MerchantRef } from '@/services/platform'
import { listSupportSessions, startSupportSession } from '@/services/support-center'

/**
 * Opens a read-only, time-limited view of the merchant's own screens. The
 * reason is logged and shown to the merchant; the page reloads into the
 * merchant's admin so nothing from the panel is cached across.
 */
export function StartSessionDialog({ merchant, ticket, onClose }: { merchant?: MerchantRef | null; ticket?: { id: string; number: number } | null; onClose: () => void }) {
  const [picked, setPicked] = useState<MerchantRef | null>(merchant ?? null)
  const [reason, setReason] = useState(ticket ? `Ticket #${ticket.number}: ` : '')
  const settings = useQuery({ queryKey: ['platform-support-sessions', 'settings'], queryFn: () => listSupportSessions({ active: true }, 1) })
  const max = settings.data?.settings.max_minutes ?? 120
  const [minutes, setMinutes] = useState<string>('')
  const chosen = Number(minutes || settings.data?.settings.default_minutes || 30)
  const options = [15, 30, 60, 90, 120, 180, 240].filter((m) => m <= max)
  const start = useMutation({
    meta: { silent: true },
    mutationFn: () => startSupportSession(picked!.id, reason.trim(), chosen, ticket?.id),
    onSuccess: () => window.location.assign('/admin'),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="View as the merchant" submitLabel="Open read-only view"
      description="You will see the merchant's screens exactly as their staff do, but cannot change, send or book anything. The session ends by itself; the merchant can see that you looked and why."
      busy={start.isPending} disabled={!picked || reason.trim().length < 10} onSubmit={() => start.mutate()}>
      <div className="grid gap-3">
        {!merchant && <Field label="Merchant" required><MerchantPicker value={picked} onChange={setPicked} /></Field>}
        <Field label="Why do you need to look?" required hint="At least 10 characters. Shown to the merchant in their support access log.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #1042: orders page shows no orders" />
        </Field>
        <Field label="For how long">
          <Select value={String(chosen)} onValueChange={setMinutes}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{(options.includes(chosen) ? options : [...options, chosen].sort((a, b) => a - b)).map((m) =>
              <SelectItem key={m} value={String(m)}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {start.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{start.error.message}</p>}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Eye className="size-3.5" /> Read-only. No password is used and nothing is changed on the merchant's account.</p>
      </div>
    </FormDialog>
  )
}

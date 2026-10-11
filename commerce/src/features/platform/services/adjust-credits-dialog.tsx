import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { adjustCredits, type CreditType } from '@/services/credits'
import type { MerchantRef } from '@/services/platform'
import { MerchantPicker } from './merchant-picker'

type Mode = 'PROMO' | 'ADD' | 'DEDUCT'

/**
 * Add or remove credits by hand. One request id per dialog: a double click or
 * a retry can never add or remove twice. Large changes wait for a second person.
 */
export function AdjustCreditsDialog({ merchant: fixed, open, onOpenChange, threshold }: {
  merchant?: MerchantRef | null
  open: boolean
  onOpenChange: (o: boolean) => void
  threshold?: number
}) {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const requestId = useMemo(() => crypto.randomUUID(), [])
  const [merchant, setMerchant] = useState<MerchantRef | null>(fixed ?? null)
  const [mode, setMode] = useState<Mode>(can('credits', 'create', fixed?.id) && !can('credits', 'manage', fixed?.id) ? 'PROMO' : 'ADD')
  const [form, setForm] = useState({ type: 'SMS' as CreditType, amount: '', expires: '', reason: '' })
  const amount = Math.floor(Number(form.amount) || 0)
  const save = useMutation({
    mutationFn: () => adjustCredits({
      merchant: merchant!.id, type: form.type, kind: mode === 'PROMO' ? 'PROMO' : 'ADJUSTMENT', amount: mode === 'DEDUCT' ? -amount : amount,
      reason: form.reason.trim(), expiresAt: mode !== 'DEDUCT' && form.expires ? new Date(`${form.expires}T23:59:59`).toISOString() : null, requestId,
    }),
    onSuccess: (r) => {
      if (r.pending_approval) toast.success('Sent for approval', { description: 'A second person with approval rights must confirm it in the Security Center.' })
      else toast.success(`Done — new balance ${formatNumber(r.balance_after)}`)
      void queryClient.invalidateQueries({ queryKey: ['platform-credits'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant-credits'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const valid = merchant && amount > 0 && form.reason.trim().length >= 5
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Change credits" busy={save.isPending} disabled={!valid} onSubmit={() => save.mutate()}
      submitLabel={amount > (threshold ?? Infinity) ? 'Request approval' : 'Apply'}
      description={`Recorded in the merchant's ledger with your name, the reason and the new balance.${threshold != null ? ` Changes over ${formatNumber(threshold)} credits need a second person.` : ''}`}>
      {!fixed && <Field label="Merchant" required><MerchantPicker value={merchant} onChange={setMerchant} /></Field>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What">
          <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {can('credits', 'create', merchant?.id) && <SelectItem value="PROMO">Promotional grant</SelectItem>}
              {can('credits', 'manage', merchant?.id) && <SelectItem value="ADD">Add (adjustment)</SelectItem>}
              {can('credits', 'manage', merchant?.id) && <SelectItem value="DEDUCT">Remove (adjustment)</SelectItem>}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Credit type">
          <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as CreditType }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="SMS">SMS credits</SelectItem><SelectItem value="COURIER">Courier check credits</SelectItem><SelectItem value="AI">AI credits</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Credits" required><Input type="number" min={1} step={1} value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
        {mode !== 'DEDUCT' && (
          <Field label="Expires (optional)" hint="Unused credits are removed after this day">
            <Input type="date" min={new Date().toISOString().slice(0, 10)} value={form.expires} onChange={(e) => setForm((f) => ({ ...f, expires: e.target.value }))} />
          </Field>
        )}
      </div>
      <Field label="Reason" required hint="At least 5 characters; the merchant sees it in their history">
        <Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
      </Field>
    </FormDialog>
  )
}

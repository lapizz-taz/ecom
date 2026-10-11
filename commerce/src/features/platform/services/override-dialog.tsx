import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { type Service, setServiceOverride } from '@/services/credits'
import type { MerchantRef } from '@/services/platform'
import { MerchantPicker } from './merchant-picker'

/** A merchant's own free limit, monthly cap and (SMS) sender ID. Empty fields follow the policy. */
export function ServiceOverrideDialog({ service, merchant: fixed, current, senderIds, onClose }: {
  service: Service
  merchant?: MerchantRef | null
  current?: { free_limit: number | null; monthly_cap: number | null; sender_id: string | null } | null
  senderIds?: string[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [merchant, setMerchant] = useState<MerchantRef | null>(fixed ?? null)
  const [form, setForm] = useState({
    free: current?.free_limit != null ? String(current.free_limit) : '', cap: current?.monthly_cap != null ? String(current.monthly_cap) : '',
    sender: current?.sender_id ?? '', reason: '',
  })
  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))))
  const save = useMutation({
    mutationFn: () => setServiceOverride(merchant!.id, service, { freeLimit: num(form.free), monthlyCap: num(form.cap), senderId: service === 'SMS' ? form.sender || null : null, reason: form.reason.trim() }),
    onSuccess: () => {
      toast.success('Saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-service', service] })
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant-credits'] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`${service === 'SMS' ? 'SMS' : 'BD Courier'} limits for one merchant`}
      description="Leave a field empty to follow the policy. Clearing everything removes the exception. A free limit set here applies even if the merchant's plan or status would not get one."
      busy={save.isPending} disabled={!merchant || form.reason.trim().length < 3} onSubmit={() => save.mutate()} submitLabel="Save">
      {!fixed && <Field label="Merchant" required><MerchantPicker value={merchant} onChange={setMerchant} /></Field>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Free limit"><Input type="number" min={0} value={form.free} placeholder="Policy" onChange={(e) => setForm((f) => ({ ...f, free: e.target.value }))} /></Field>
        <Field label="Monthly cap"><Input type="number" min={0} value={form.cap} placeholder="Policy" onChange={(e) => setForm((f) => ({ ...f, cap: e.target.value }))} /></Field>
        {service === 'SMS' && (
          <Field label="Sender ID" className="sm:col-span-2" hint="Only approved sender IDs (set on this page)">
            {senderIds && senderIds.length > 0 ? (
              <Select value={form.sender || 'default'} onValueChange={(v) => setForm((f) => ({ ...f, sender: v === 'default' ? '' : v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="default">Platform default</SelectItem>{senderIds.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            ) : <Input value={form.sender} maxLength={20} placeholder="Platform default" onChange={(e) => setForm((f) => ({ ...f, sender: e.target.value }))} />}
          </Field>
        )}
      </div>
      <Field label="Reason" required><Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></Field>
    </FormDialog>
  )
}

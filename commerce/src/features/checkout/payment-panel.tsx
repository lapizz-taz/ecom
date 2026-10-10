import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { Copy, CreditCard, Smartphone } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { toast } from '@/lib/toast'
import { z } from 'zod'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { PAYMENT_CHANNEL } from '@/lib/status'
import { initiatePayment, submitManualPayment } from '@/services/storefront'
import type { PublicOrder } from '@/types/domain'

const manualSchema = z.object({
  channel: z.enum(['BKASH', 'NAGAD', 'ROCKET', 'BANK_TRANSFER', 'OTHER']),
  sender_phone: z.string().trim().min(6, 'Enter the number you paid from'),
  transaction_id: z.string().trim().min(6, 'Enter the transaction ID from the SMS').max(30),
})
type ManualValues = z.infer<typeof manualSchema>

/**
 * Shown when the order needs a payment before it can be confirmed. Payment is
 * only counted after the provider confirms it server-side or staff verify a
 * manual transfer.
 */
export function PaymentPanel({ order, phone, onSubmitted }: { order: PublicOrder; phone: string; onSubmitted: () => void }) {
  const { data: config } = useStoreConfig()
  const providers = config?.payments.providers ?? []
  const manual = providers.find((p) => p.type === 'manual')
  const redirects = providers.filter((p) => p.type === 'redirect')
  const purpose = order.payment_method === 'FULL_PAYMENT' ? 'FULL' : 'ADVANCE'
  const due = purpose === 'FULL' ? Number(order.total_amount) - Number(order.amount_paid) : Number(order.amount_due_now)

  const online = useMutation({
    meta: { silent: true },
    mutationFn: (provider: string) => initiatePayment({ order_number: order.order_number, phone, provider, purpose }),
    onSuccess: (res) => {
      if (res.redirectUrl) window.location.href = res.redirectUrl
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })

  const channels = [...new Set((manual?.accounts ?? []).map((a) => a.channel))]
  const form = useForm<ManualValues>({
    resolver: zodResolver(manualSchema),
    defaultValues: { channel: (channels[0] as ManualValues['channel']) ?? 'BKASH', sender_phone: '', transaction_id: '' },
  })
  const submit = useMutation({
    meta: { silent: true },
    mutationFn: (v: ManualValues) => submitManualPayment({
      order_number: order.order_number, phone, channel: v.channel, sender_phone: normalizePhone(v.sender_phone),
      transaction_id: v.transaction_id, amount: due,
    }),
    onSuccess: () => {
      toast.success('Thanks! We will verify your payment shortly.')
      form.reset()
      onSubmitted()
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })

  if (due <= 0) return null
  if (order.pending_payment_verification) {
    return (
      <Card className="border-amber-200 bg-amber-50/60">
        <CardHeader>
          <CardTitle className="text-base">Payment received — being verified</CardTitle>
          <CardDescription>We'll confirm your order as soon as we match your transaction. This usually takes a few minutes during business hours.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle className="text-base">Pay <Money value={due} /> to confirm your order</CardTitle>
        <CardDescription>
          {purpose === 'ADVANCE' ? <>The remaining <Money value={Math.max(Number(order.total_amount) - Number(order.amount_paid) - due, 0)} /> is paid on delivery. </> : null}
          {order.advance_due_at && <>Please pay before {formatDateTime(order.advance_due_at)}, otherwise the order is cancelled automatically.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {redirects.map((p) => (
          <Button key={p.code} size="lg" className="w-full" onClick={() => online.mutate(p.code)} disabled={online.isPending}>
            {online.isPending ? <Spinner /> : <CreditCard />} {p.label}
          </Button>
        ))}

        {manual && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 font-medium"><Smartphone className="size-4" /> {manual.label}</div>
            {manual.instructions && <p className="text-sm text-muted-foreground">{manual.instructions}</p>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {manual.accounts.map((a) => (
                <li key={`${a.channel}-${a.number}`} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <div><p className="font-medium">{a.label}</p><p className="font-mono tabular-nums">{a.number}</p></div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Copy ${a.label} number`}
                    onClick={() => navigator.clipboard.writeText(a.number).then(() => toast.success('Number copied'))}><Copy /></Button>
                </li>
              ))}
            </ul>
            <p className="text-sm">Amount to send: <strong><Money value={due} /></strong> · Reference: <strong>{order.order_number}</strong></p>
            <form onSubmit={form.handleSubmit((v) => submit.mutate(v))} className="grid gap-3 sm:grid-cols-3" noValidate>
              <Field label="Paid with">
                <Select value={form.watch('channel')} onValueChange={(v) => form.setValue('channel', v as ManualValues['channel'])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(channels.length ? channels : ['BKASH', 'NAGAD']).map((c) => (
                      <SelectItem key={c} value={c}>{PAYMENT_CHANNEL[c as keyof typeof PAYMENT_CHANNEL] ?? c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Your number" htmlFor="sender_phone" error={form.formState.errors.sender_phone?.message}>
                <Input id="sender_phone" inputMode="tel" {...form.register('sender_phone')} />
              </Field>
              <Field label="Transaction ID" htmlFor="transaction_id" error={form.formState.errors.transaction_id?.message}>
                <Input id="transaction_id" className="uppercase" {...form.register('transaction_id')} />
              </Field>
              <Button type="submit" className="sm:col-span-3" disabled={submit.isPending}>
                {submit.isPending && <Spinner />} I have paid — submit transaction ID
              </Button>
            </form>
          </div>
        )}
        {!manual && redirects.length === 0 && (
          <p className="text-sm text-muted-foreground">Our team will contact you to arrange payment{config?.store.phone ? ` (or call ${config.store.phone})` : ''}.</p>
        )}
      </CardContent>
    </Card>
  )
}

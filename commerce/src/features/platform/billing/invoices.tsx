import { useMutation } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type BillingPayment, type Invoice, PAYMENT_METHODS, recordPayment, verifyPayment, voidInvoice } from '@/services/billing'

const INVOICE_STATUS = { OPEN: 'warning', PAID: 'success', VOID: 'neutral' } as const
const PAYMENT_STATUS = { PENDING: 'warning', SUCCEEDED: 'success', FAILED: 'danger', REJECTED: 'neutral' } as const

const isOverdue = (i: Pick<Invoice, 'status' | 'due_at'>) => i.status === 'OPEN' && new Date(i.due_at).getTime() < Date.now()

/** A payment received outside a gateway. It counts only after a second person verifies it. */
function RecordPaymentDialog({ invoice, open, onOpenChange, onDone }: { invoice: Invoice; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ amount: String(Math.max(invoice.total - invoice.amount_paid, 0)), method: 'BANK', reference: '', note: '' })
  const save = useMutation({
    mutationFn: () => recordPayment(invoice.id, { amount: Number(form.amount), method: form.method, reference: form.reference.trim(), note: form.note || undefined }),
    onSuccess: () => {
      toast.success('Payment recorded', { description: 'It counts once a second person verifies it against the statement.' })
      onDone()
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={`Record a payment for ${invoice.number}`} busy={save.isPending}
      description="For bank transfers, Send Money and cash. The invoice stays unpaid until another team member with approval rights verifies it."
      disabled={!(Number(form.amount) > 0) || !form.reference.trim()} onSubmit={() => save.mutate()} submitLabel="Record payment">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (BDT)" required><Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
        <Field label="Method">
          <Select value={form.method} onValueChange={(method) => setForm((f) => ({ ...f, method }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m === 'BKASH' ? 'bKash' : m === 'NAGAD' ? 'Nagad' : m.charAt(0) + m.slice(1).toLowerCase()}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Transaction or receipt reference" required className="sm:col-span-2" hint="Each reference can be recorded once per method"><Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} /></Field>
        <Field label="Note" className="sm:col-span-2"><Textarea rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
      </div>
    </FormDialog>
  )
}

/** Payments waiting for a second person. Whoever recorded one cannot verify it. */
export function PendingPayments({ payments, onChanged }: { payments: BillingPayment[]; onChanged: () => void }) {
  const [deciding, setDeciding] = useState<{ payment: BillingPayment; approve: boolean } | null>(null)
  if (!payments.length) return null
  return (
    <Card className="gap-0 border-amber-500/40 py-0">
      <p className="border-b px-4 py-2 text-sm font-medium">Payments waiting for verification ({payments.length})</p>
      {payments.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm last:border-0">
          <span className="min-w-0">
            <span className="font-medium">{formatMoney(p.amount)}</span> · {p.method.toLowerCase()} · <code className="text-xs">{p.reference}</code>
            <span className="block text-xs text-muted-foreground">{p.invoice_number}{p.merchant && ` · ${p.merchant}`} · recorded {formatDateTime(p.created_at)}{p.note && ` · ${p.note}`}</span>
          </span>
          {p.can_verify ? (
            <span className="flex gap-2">
              <Button size="sm" onClick={() => setDeciding({ payment: p, approve: true })}><Check /> Verify</Button>
              <Button size="sm" variant="outline" onClick={() => setDeciding({ payment: p, approve: false })}><X /> Reject</Button>
            </span>
          ) : <span className="text-xs text-muted-foreground">Needs another team member with approval rights</span>}
        </div>
      ))}
      {deciding && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeciding(null)} reason reasonLabel="Note (optional)"
          title={deciding.approve ? `Verify ${formatMoney(deciding.payment.amount)} (${deciding.payment.reference})?` : 'Reject this payment?'}
          description={deciding.approve ? 'Only if the money is in the account statement. The invoice is marked paid when fully covered, and the subscription period starts.' : 'The invoice stays unpaid.'}
          confirmLabel={deciding.approve ? 'Verify payment' : 'Reject'} destructive={!deciding.approve}
          onConfirm={async (note) => {
            try {
              const r = await verifyPayment(deciding.payment.id, deciding.approve, note || undefined)
              toast.success(deciding.approve ? (r.invoice?.status === 'PAID' ? 'Verified — invoice paid' : 'Verified — invoice partly paid') : 'Payment rejected')
              onChanged()
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </Card>
  )
}

export function InvoiceTable({ invoices, payments = [], showMerchant, canManage, onChanged }: {
  invoices: Invoice[]
  payments?: BillingPayment[]
  showMerchant?: boolean
  canManage: (invoice: Invoice) => boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [paying, setPaying] = useState<Invoice | null>(null)
  const [voiding, setVoiding] = useState<Invoice | null>(null)
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-8" /><TableHead>Invoice</TableHead>{showMerchant && <TableHead>Merchant</TableHead>}<TableHead>Period</TableHead>
            <TableHead className="text-right">Total</TableHead><TableHead className="text-right">Paid</TableHead><TableHead>Status</TableHead><TableHead>Due</TableHead><TableHead />
          </TableRow></TableHeader>
          <TableBody>
            {invoices.map((i) => (
              <Fragment key={i.id}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(open === i.id ? null : i.id)}>
                  <TableCell>{open === i.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                  <TableCell className="font-mono text-xs">{i.number}</TableCell>
                  {showMerchant && <TableCell className="text-xs"><Link className="underline" to={`/super-admin/merchants/${i.merchant_id}?tab=billing`} onClick={(e) => e.stopPropagation()}>#{i.merchant_number} {i.merchant_name}</Link></TableCell>}
                  <TableCell className="text-xs whitespace-nowrap">{i.period_start ? `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.amount_paid)}</TableCell>
                  <TableCell><Badge variant={isOverdue(i) ? 'danger' : INVOICE_STATUS[i.status]}>{isOverdue(i) ? 'overdue' : i.status.toLowerCase()}</Badge></TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{i.status === 'PAID' ? `paid ${formatDate(i.paid_at)}` : formatDate(i.due_at)}</TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {i.status === 'OPEN' && canManage(i) && (
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => setPaying(i)}>Record payment</Button>
                        {i.amount_paid === 0 && <Button size="sm" variant="ghost" onClick={() => setVoiding(i)}>Void</Button>}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                {open === i.id && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell />
                    <TableCell colSpan={showMerchant ? 8 : 7} className="space-y-1 py-3 text-xs">
                      {i.lines.map((l, n) => <div key={n} className="flex justify-between gap-4"><span>{l.label}</span><span className="tabular-nums">{formatMoney(l.amount)}</span></div>)}
                      {i.void_reason && <p className="text-muted-foreground">Voided: {i.void_reason}</p>}
                      {payments.filter((p) => p.invoice_id === i.id).map((p) => (
                        <p key={p.id} className="text-muted-foreground">Payment {formatMoney(p.amount)} · {p.method.toLowerCase()} · {p.reference} · <Badge variant={PAYMENT_STATUS[p.status]}>{p.status.toLowerCase()}</Badge></p>
                      ))}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      {paying && <RecordPaymentDialog invoice={paying} open onOpenChange={(o) => !o && setPaying(null)} onDone={onChanged} />}
      {voiding && (
        <ConfirmDialog open onOpenChange={(o) => !o && setVoiding(null)} reason reasonRequired title={`Void ${voiding.number}?`} destructive confirmLabel="Void invoice"
          description="The merchant no longer owes it. The invoice stays on record, marked void, with your reason."
          onConfirm={async (reason) => {
            try {
              await voidInvoice(voiding.id, reason)
              toast.success('Invoice voided')
              onChanged()
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </>
  )
}

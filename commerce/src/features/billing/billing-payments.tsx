import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock, MessageSquare, Printer, Receipt as ReceiptIcon, Wallet, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  billingReceipt, buyCredits, type BuyType, type MyBilling, myBilling, PAYMENT_STATUS, priceFor, type Pricing, PURPOSE_LABEL,
} from '@/services/billing-payments'
import { payInvoice } from '@/services/credits'
import { GATEWAY_SHORT, PayDialog, useMyCredits } from './credits-section'

export function useMyBilling() {
  return useQuery({ queryKey: ['my-billing'], queryFn: myBilling, staleTime: 15_000 })
}

/**
 * Buy SMS credits at the platform's price per credit, or top up the balance.
 * The total shown is worked out here for the customer to see; the database
 * prices the purchase again from the quantity alone.
 */
function BuyCard({ type, pricing, billing, balance }: { type: BuyType; pricing: Pricing; billing: MyBilling; balance: string }) {
  const money = type === 'BALANCE'
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          {money ? <Wallet className="size-4" /> : <MessageSquare className="size-4" />}
          {money ? 'Top up balance' : type === 'SMS' ? 'Buy SMS credits' : 'Buy courier check credits'}
        </CardTitle>
        <CardDescription>
          {money ? 'Pays the fee for each order you approve.' : type === 'SMS'
            ? `${formatMoney(pricing.unit_price)} per SMS credit. One credit sends one SMS part: 160 characters, or 70 with Bangla.`
            : `${formatMoney(pricing.unit_price)} per courier history check.`}
          {' '}You have <span className="font-medium text-foreground tabular-nums">{balance}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent><BuyForm type={type} pricing={pricing} billing={billing} /></CardContent>
    </Card>
  )
}

/** Amount, total and the pay button; the gateway (bKash, PayStation, SSLCommerz) is chosen next. */
function BuyForm({ type, pricing, billing, onStarted }: { type: BuyType; pricing: Pricing; billing: MyBilling; onStarted?: () => void }) {
  const money = type === 'BALANCE'
  const [qty, setQty] = useState(String(pricing.presets[1] ?? pricing.presets[0] ?? pricing.min))
  const [paying, setPaying] = useState<number | null>(null)
  const n = Math.floor(Number(qty))
  const total = money ? n : priceFor(n, pricing.unit_price ?? 0)
  const tooFew = !(n >= pricing.min)
  const tooMany = n > pricing.max
  const overLimit = total > billing.max_payment_tk
  const canBuy = billing.can_pay && billing.gateways.length > 0
  const invalid = !Number.isFinite(n) || tooFew || tooMany || overLimit
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {pricing.presets.map((p) => (
          <button key={p} type="button" onClick={() => setQty(String(p))}
            className={cn('rounded-[10px] border px-3 py-1 text-sm tabular-nums transition-colors',
              Number(qty) === p ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted')}>
            {money ? formatMoney(p) : formatNumber(p)}
          </button>
        ))}
      </div>
      <Field label={money ? 'Amount (Tk)' : type === 'SMS' ? 'SMS credits' : 'Credits'} hint={`Between ${money ? formatMoney(pricing.min) : formatNumber(pricing.min)} and ${money ? formatMoney(pricing.max) : formatNumber(pricing.max)}`}>
        <Input type="number" inputMode="numeric" min={pricing.min} max={pricing.max} step={1} value={qty} onChange={(e) => setQty(e.target.value)} className="tabular-nums" />
      </Field>
      <div className="flex items-center justify-between rounded-[10px] bg-muted/60 px-3 py-2.5 text-sm">
        <span className="text-muted-foreground">
          {money ? 'Balance added' : `${formatNumber(Number.isFinite(n) ? n : 0)} × ${formatMoney(pricing.unit_price)}`}
        </span>
        <span className="text-base font-semibold tabular-nums">{formatMoney(Number.isFinite(total) ? total : 0)}</span>
      </div>
      {(tooFew || tooMany) && Number.isFinite(n) && qty !== '' && (
        <p className="text-xs text-destructive">Choose between {formatNumber(pricing.min)} and {formatNumber(pricing.max)}.</p>
      )}
      {overLimit && !tooMany && <p className="text-xs text-destructive">One online payment can be at most {formatMoney(billing.max_payment_tk)}.</p>}
      <Button className="w-full" disabled={!canBuy || invalid} onClick={() => setPaying(n)}>
        Pay {formatMoney(Number.isFinite(total) ? total : 0)}
      </Button>
      {canBuy ? (
        <p className="text-center text-xs text-muted-foreground">With {billing.gateways.map((g) => GATEWAY_SHORT[g]).join(', ')}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{billing.can_pay ? 'Online payment is not available yet — e-mail help@fullfilio.com to recharge.' : 'Only the owner or staff who manage settings can pay.'}</p>
      )}
      {paying != null && (
        <PayDialog title={money ? `Top up ${formatMoney(paying)}` : `Buy ${formatNumber(paying)} ${type === 'SMS' ? 'SMS' : 'courier check'} credits`}
          amount={money ? paying : priceFor(paying, pricing.unit_price ?? 0)} gateways={billing.gateways} onClose={() => setPaying(null)}
          start={async (gateway) => {
            const invoice = await buyCredits(type, paying)
            onStarted?.()
            await payInvoice(invoice.id, gateway)
          }} />
      )}
    </div>
  )
}

/** "Add SMS Balance" on the SMS page: buy SMS credits and pay with bKash, PayStation or SSLCommerz. */
export function AddSmsBalanceDialog({ onClose }: { onClose: () => void }) {
  const billing = useMyBilling()
  const credits = useMyCredits()
  const b = billing.data
  const balance = credits.data?.balances.find((x) => x.code === 'SMS')?.available ?? 0
  const included = !!credits.data?.usage.sms?.unmetered
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add SMS balance</DialogTitle>
          <DialogDescription>
            {b?.pricing.SMS.enabled
              ? <>{formatMoney(b.pricing.SMS.unit_price)} per SMS. One SMS is 160 characters, or 70 with Bangla. You have <span className="font-medium text-foreground tabular-nums">{formatNumber(balance)} SMS</span>.</>
              : 'Buy SMS for your store.'}
          </DialogDescription>
        </DialogHeader>
        {included && (
          <p className="rounded-[10px] bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            Your plan includes SMS right now, so messages do not use this balance. What you add stays yours for when your plan no longer includes SMS.
          </p>
        )}
        {billing.error ? <ErrorState error={billing.error} onRetry={() => billing.refetch()} />
          : !b ? <LoadingState />
            : !b.pricing.SMS.enabled ? <p className="text-sm text-muted-foreground">SMS cannot be bought online right now — e-mail help@fullfilio.com to recharge.</p>
              : <BuyForm type="SMS" pricing={b.pricing.SMS} billing={b} />}
      </DialogContent>
    </Dialog>
  )
}

/** SMS credits and balance top-up, side by side. */
export function BuySection() {
  const billing = useMyBilling()
  const credits = useMyCredits()
  if (billing.error) return <ErrorState error={billing.error} onRetry={() => billing.refetch()} />
  if (!billing.data || !credits.data) return <LoadingState />
  const b = billing.data
  const bal = (code: string) => credits.data.balances.find((x) => x.code === code)?.available ?? 0
  const smsIncluded = !!credits.data.usage.sms?.unmetered
  const cards: Array<{ type: BuyType; pricing: Pricing; balance: string }> = [
    ...(b.pricing.SMS.enabled ? [{ type: 'SMS' as const, pricing: b.pricing.SMS, balance: `${formatNumber(bal('SMS'))} SMS credits${smsIncluded ? ' (your plan includes SMS right now)' : ''}` }] : []),
    ...(b.pricing.BALANCE.enabled ? [{ type: 'BALANCE' as const, pricing: b.pricing.BALANCE, balance: formatMoney(bal('BALANCE') / 100) }] : []),
    ...(b.pricing.COURIER.enabled ? [{ type: 'COURIER' as const, pricing: b.pricing.COURIER, balance: `${formatNumber(bal('COURIER'))} checks` }] : []),
  ]
  if (cards.length === 0) return null
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Buy credits</h2>
      <div className={cn('grid gap-4', cards.length > 1 && 'lg:grid-cols-2', cards.length > 2 && 'xl:grid-cols-3')}>
        {cards.map((c) => <BuyCard key={c.type} type={c.type} pricing={c.pricing} billing={b} balance={c.balance} />)}
      </div>
    </section>
  )
}

/** Every payment the store made to Fullfilio, with its state and a receipt for the paid ones. */
export function PaymentHistory() {
  const billing = useMyBilling()
  const [receipt, setReceipt] = useState<string | null>(null)
  if (billing.error) return <ErrorState error={billing.error} onRetry={() => billing.refetch()} />
  if (!billing.data) return <LoadingState />
  const rows = billing.data.payments
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Payments</h2>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No payments yet.</p> : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead><TableHead>For</TableHead><TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(p.created_at)}</TableCell>
                      <TableCell className="min-w-40 text-sm">
                        <span className="font-medium">{p.purpose ? PURPOSE_LABEL[p.purpose] : 'Payment'}</span>
                        <span className="block text-xs text-muted-foreground">{p.invoice.description ?? p.invoice.number}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.reference}<span className="block text-muted-foreground">{p.invoice.number}</span></TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(p.amount)}
                        {p.refunded_amount > 0 && <span className="block text-xs text-muted-foreground">{formatMoney(p.refunded_amount)} refunded</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PAYMENT_STATUS[p.status].variant}>{PAYMENT_STATUS[p.status].label}</Badge>
                        {p.status_reason && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(p.status) && <span className="mt-0.5 block max-w-48 truncate text-xs text-muted-foreground">{p.status_reason}</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        {['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status) && (
                          <Button size="sm" variant="ghost" onClick={() => setReceipt(p.id)}><ReceiptIcon /> Receipt</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {receipt && <ReceiptDialog paymentId={receipt} onClose={() => setReceipt(null)} />}
    </section>
  )
}

function ReceiptDialog({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const r = useQuery({ queryKey: ['billing-receipt', paymentId], queryFn: () => billingReceipt(paymentId) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Receipt</DialogTitle></DialogHeader>
        {r.error ? <ErrorState error={r.error} /> : !r.data ? <LoadingState /> : (
          <div className="space-y-4 text-sm" id="billing-receipt">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold">{r.data.issuer}</p>
                <p className="text-muted-foreground">Payment receipt</p>
              </div>
              <Badge variant={PAYMENT_STATUS[r.data.payment.status].variant}>{PAYMENT_STATUS[r.data.payment.status].label}</Badge>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Store</dt><dd>{r.data.store.name} (#{r.data.store.number})</dd>
              <dt className="text-muted-foreground">Invoice</dt><dd className="font-mono">{r.data.invoice.number}</dd>
              <dt className="text-muted-foreground">Reference</dt><dd className="font-mono">{r.data.payment.reference}</dd>
              <dt className="text-muted-foreground">Paid</dt><dd>{formatDateTime(r.data.payment.paid_at)}</dd>
              <dt className="text-muted-foreground">Method</dt><dd>{r.data.payment.provider === 'bkash' ? 'bKash' : r.data.payment.provider ?? r.data.payment.method}</dd>
              {r.data.payment.transaction && <><dt className="text-muted-foreground">Transaction</dt><dd className="font-mono">{r.data.payment.transaction}</dd></>}
              {r.data.invoice.period_start && <><dt className="text-muted-foreground">Period</dt><dd>{formatDate(r.data.invoice.period_start)} – {formatDate(r.data.invoice.period_end)}</dd></>}
            </dl>
            <div className="divide-y rounded-[10px] border">
              {r.data.invoice.lines.map((l, i) => (
                <div key={i} className="flex justify-between gap-3 px-3 py-2"><span>{l.label}</span><span className="tabular-nums">{formatMoney(l.amount)}</span></div>
              ))}
              <div className="flex justify-between gap-3 px-3 py-2 font-semibold"><span>Total paid</span><span className="tabular-nums">{formatMoney(r.data.payment.amount)}</span></div>
              {r.data.payment.refunded_amount > 0 && (
                <div className="flex justify-between gap-3 px-3 py-2 text-muted-foreground"><span>Refunded</span><span className="tabular-nums">−{formatMoney(r.data.payment.refunded_amount)}</span></div>
              )}
            </div>
            <Button variant="outline" className="w-full print:hidden" onClick={() => window.print()}><Printer /> Print</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const RESULT = {
  success: { icon: CheckCircle2, tone: 'border-emerald-200 bg-emerald-50 text-emerald-900', title: 'Payment confirmed', text: 'bKash confirmed the payment and it has been applied.' },
  review: { icon: Clock, tone: 'border-amber-200 bg-amber-50 text-amber-900', title: 'Checking your payment', text: 'We have not been able to confirm it with the gateway yet. If money was taken, it is checked again automatically and applied within a few minutes.' },
  failed: { icon: XCircle, tone: 'border-red-200 bg-red-50 text-red-900', title: 'Payment did not go through', text: 'Nothing was charged. You can try again.' },
  cancelled: { icon: XCircle, tone: 'border-border bg-muted text-foreground', title: 'Payment cancelled', text: 'Nothing was charged.' },
  unknown: { icon: Clock, tone: 'border-amber-200 bg-amber-50 text-amber-900', title: 'We could not match that payment', text: 'If money was taken, e-mail help@fullfilio.com with the bKash transaction ID.' },
} as const

/**
 * What happened to the payment the merchant just came back from. While it is
 * still being checked, the page asks again every few seconds and shows the
 * final answer — never a success the gateway has not confirmed.
 */
export function PaymentResultBanner({ outcome, invoiceId, onDismiss }: { outcome: string; invoiceId: string; onDismiss: () => void }) {
  const qc = useQueryClient()
  const billing = useMyBilling()
  const latest = billing.data?.payments.find((p) => p.invoice.id === invoiceId)
  const settled = latest && latest.status !== 'PENDING'
  const effective = outcome === 'review' && latest
    ? latest.status === 'SUCCEEDED' ? 'success' : ['FAILED', 'EXPIRED', 'REJECTED'].includes(latest.status) ? 'failed' : latest.status === 'CANCELLED' ? 'cancelled' : 'review'
    : outcome
  const r = RESULT[effective as keyof typeof RESULT] ?? RESULT.unknown
  const Icon = r.icon
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['my-credits'] })
    void qc.invalidateQueries({ queryKey: ['my-plan'] })
  }, [qc, effective])
  const { refetch } = billing
  useEffect(() => {
    if (outcome !== 'review' || settled) return
    // Up to two minutes: the reconcile job confirms late payments within a few.
    let n = 0
    const t = window.setInterval(() => { if (++n > 24) window.clearInterval(t); else void refetch() }, 5000)
    return () => window.clearInterval(t)
  }, [outcome, settled, refetch])
  return (
    <div role="status" className={cn('flex items-start gap-3 rounded-[10px] border px-4 py-3', r.tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{r.title}</p>
        <p className="opacity-90">{r.text}</p>
        {latest && <p className="mt-1 font-mono text-xs opacity-75">{latest.reference} · {formatMoney(latest.amount)}{latest.transaction ? ` · ${latest.transaction}` : ''}</p>}
      </div>
      <Button size="sm" variant="ghost" onClick={onDismiss}>Close</Button>
    </div>
  )
}

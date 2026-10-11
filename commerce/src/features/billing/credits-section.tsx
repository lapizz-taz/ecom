import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FormDialog } from '@/components/common/form-dialog'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type CreditPackage, LEDGER_KIND, myCredits, payInvoice, startRecharge } from '@/services/credits'

const GATEWAY_NAME = { bkash: 'bKash', paystation: 'PayStation (card, mobile banking)' } as const

export function useMyCredits() {
  return useQuery({ queryKey: ['my-credits'], queryFn: myCredits, staleTime: 30_000 })
}

/** Choose how to pay, then go to the gateway. Nothing is credited until the gateway confirms the payment. */
export function PayDialog({ title, amount, gateways, start, onClose }: {
  title: string
  amount: number
  gateways: Array<'bkash' | 'paystation'>
  start: (gateway: 'bkash' | 'paystation') => Promise<void>
  onClose: () => void
}) {
  const [gateway, setGateway] = useState(gateways[0])
  const pay = useMutation({ mutationFn: () => start(gateway), onError: (e) => toast.error((e as Error).message) })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={title} submitLabel={`Pay ${formatMoney(amount)}`} busy={pay.isPending} onSubmit={() => pay.mutate()}
      description="You are sent to the payment page. When the payment is confirmed you come back here and it is applied automatically.">
      <RadioGroup value={gateway} onValueChange={(v) => setGateway(v as typeof gateway)} className="gap-2">
        {gateways.map((g) => (
          <label key={g} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><RadioGroupItem value={g} /> {GATEWAY_NAME[g]}</label>
        ))}
      </RadioGroup>
    </FormDialog>
  )
}

/** SMS and courier-check credits: balance, free use left, buying more, and every change. */
export function CreditsSection() {
  const data = useMyCredits()
  const [buying, setBuying] = useState<CreditPackage | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const d = data.data
  const usage = { SMS: d.usage.sms, COURIER: d.usage.bd_courier }
  const canBuy = d.can_pay && d.gateways.length > 0
  return (
    <section id="credits" className="space-y-4">
      <h2 className="text-lg font-semibold">Credits</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {d.balances.map((b) => {
          const u = usage[b.code as 'SMS' | 'COURIER']
          const packages = d.packages.filter((k) => k.credit_type === b.code)
          return (
            <Card key={b.code}>
              <CardHeader><CardTitle className="text-sm">{b.name}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-2xl font-semibold tabular-nums">{u?.unmetered ? 'Included' : formatNumber(b.available)}</p>
                  <p className="text-xs text-muted-foreground">{b.description}</p>
                  {u && !u.unmetered && (
                    <p className="mt-1 text-sm">
                      {u.free.eligible ? `${formatNumber(u.free.remaining)} free ${b.unit}s left${u.free.period === 'MONTH' ? ' this month' : ''}` : 'No free allowance on your current plan or status'}
                      {u.monthly_cap != null && <span className="text-muted-foreground"> · {formatNumber(u.month_used)} of {formatNumber(u.monthly_cap)} used this month</span>}
                    </p>
                  )}
                  {b.expiring.map((x, i) => <p key={i} className="text-xs text-amber-600">{formatNumber(x.amount)} expire on {formatDate(x.expires_at)}</p>)}
                </div>
                {!u?.unmetered && packages.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {packages.map((k) => (
                      <div key={k.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <span><span className="font-medium">{k.name}</span><span className="block text-xs text-muted-foreground">{formatNumber(k.credits)}{k.bonus_credits > 0 && ` + ${formatNumber(k.bonus_credits)} bonus`} · {formatMoney(k.price)}</span></span>
                        <Button size="sm" variant="outline" disabled={!canBuy} onClick={() => setBuying(k)}>Buy</Button>
                      </div>
                    ))}
                  </div>
                )}
                {!u?.unmetered && !canBuy && (
                  <p className="text-xs text-muted-foreground">{d.can_pay ? 'Online payment is not available yet — contact the platform team to recharge.' : 'Only the owner or staff who manage settings can buy credits.'}</p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        SMS: charged when the provider accepts a message; rejected messages are refunded{d.sms_policy.refund_undelivered ? ', and so are messages reported undelivered' : ''}; retries are never charged twice; without credits, messages wait up to {d.sms_policy.hold_hours} hours.
        Courier checks: one lookup = one check; checking the same number again soon after reuses the result; failed lookups are not counted.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Recharges</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {d.recharges.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
            {d.recharges.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
                <span>{r.lines.map((l) => l.label).join(', ')} <span className="text-xs text-muted-foreground">· {r.number} · {formatDateTime(r.created_at)}</span></span>
                <span className="flex items-center gap-2"><span className="tabular-nums">{formatMoney(r.total)}</span><Badge variant={r.status === 'PAID' ? 'success' : 'neutral'}>{r.status === 'PAID' ? 'paid' : 'not paid'}</Badge></span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Credit history</CardTitle></CardHeader>
          <CardContent className="max-h-80 space-y-1.5 overflow-y-auto">
            {d.ledger.length === 0 && <p className="text-sm text-muted-foreground">No credit changes yet.</p>}
            {d.ledger.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate"><Badge variant={LEDGER_KIND[e.kind].variant}>{LEDGER_KIND[e.kind].label}</Badge> <span className="text-xs text-muted-foreground">{e.credit_type.toLowerCase()} · {e.reason} · {formatDateTime(e.created_at)}</span></span>
                <span className={`shrink-0 tabular-nums ${e.amount > 0 ? 'text-emerald-600' : ''}`}>{e.amount > 0 ? '+' : ''}{formatNumber(e.amount)} → {formatNumber(e.balance_after)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      {buying && (
        <PayDialog title={`Buy ${buying.name}`} amount={buying.price} gateways={d.gateways} onClose={() => setBuying(null)}
          start={async (gateway) => {
            const invoice = await startRecharge(buying.id)
            await payInvoice(invoice.id, gateway)
          }} />
      )}
    </section>
  )
}

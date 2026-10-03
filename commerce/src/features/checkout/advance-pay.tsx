import type { ReactNode } from 'react'
import { Money } from '@/components/common/money'
import { cn } from '@/lib/utils'
import type { PaymentAccount } from '@/types/domain'
import { type AdvancePaymentValues, AdvancePaymentFields } from './advance-payment-fields'

export interface Gateway { code: string; label: string }

const HINT: Record<string, string> = {
  bkash: 'Approve in the bKash app or page',
  paystation: 'Nagad, Rocket, Upay or card',
  sslcommerz: 'Card or mobile banking',
}

const ACCENT: Record<string, string> = {
  bkash: 'data-[active=true]:border-[#e2136e] data-[active=true]:bg-[#e2136e]/5',
}

/** The amount to pay now, and how: an online gateway (instant) or Send Money with a TrxID. */
export function AdvancePay({ title, note, amount, gateways, accounts, via, onVia, manual, onManual, errors }: {
  title: string
  note?: ReactNode
  amount: number
  gateways: Gateway[]
  accounts: PaymentAccount[]
  via: string
  onVia: (code: string) => void
  manual: AdvancePaymentValues
  onManual: (v: AdvancePaymentValues) => void
  errors: Partial<Record<keyof AdvancePaymentValues, string>>
}) {
  const hasManual = accounts.some((a) => ['BKASH', 'NAGAD', 'ROCKET'].includes(a.channel) && a.number)
  const options = [
    ...gateways.map((g) => ({ code: g.code, label: g.label, hint: HINT[g.code] ?? 'Pay online' })),
    ...(hasManual ? [{ code: 'manual', label: 'Send Money', hint: 'Pay to our number, then enter the TrxID' }] : []),
  ]
  const chosen = gateways.find((g) => g.code === via)
  return (
    <div className="space-y-4 rounded-xl bg-muted/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
        </div>
        <p className="text-xl font-semibold tabular-nums"><Money value={amount} /></p>
      </div>
      {options.length > 1 && (
        <div role="radiogroup" aria-label="How to pay" className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => (
            <button key={o.code} type="button" role="radio" aria-checked={via === o.code} data-active={via === o.code} onClick={() => onVia(o.code)}
              className={cn('press group flex items-center gap-3 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:bg-muted data-[active=true]:border-foreground',
                ACCENT[o.code])}>
              <span className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/30 transition-all group-data-[active=true]:border-[5px] group-data-[active=true]:border-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {via === 'manual' ? (
        <AdvancePaymentFields bare title="" amount={amount} accounts={accounts} value={manual} onChange={onManual} errors={errors} />
      ) : chosen && (
        <p className="text-xs text-muted-foreground">You'll approve the payment on {chosen.label.replace(/^Pay with /, '')}'s secure page and come straight back. Your order is confirmed the moment it goes through.</p>
      )}
    </div>
  )
}

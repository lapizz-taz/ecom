import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { PaymentAccount } from '@/types/domain'

export type WalletChannel = 'BKASH' | 'NAGAD' | 'ROCKET'
export interface AdvancePaymentValues {
  channel: WalletChannel
  sender_phone: string
  transaction_id: string
}

const WALLET: Record<WalletChannel, { name: string; cls: string }> = {
  BKASH: { name: 'bKash', cls: 'data-[active=true]:border-[#e2136e] data-[active=true]:bg-[#e2136e]/5' },
  NAGAD: { name: 'Nagad', cls: 'data-[active=true]:border-[#f6921e] data-[active=true]:bg-[#f6921e]/5' },
  ROCKET: { name: 'Rocket', cls: 'data-[active=true]:border-[#8c3494] data-[active=true]:bg-[#8c3494]/5' },
}

/**
 * "Send Money" advance at checkout. The customer pays the shown number, then
 * enters their wallet number and the transaction ID from the SMS. The order is
 * confirmed only after staff match it against the statement.
 */
export function AdvancePaymentFields({ title, note, amount, accounts, value, onChange, errors }: {
  title: string
  note?: ReactNode
  amount: number
  accounts: PaymentAccount[]
  value: AdvancePaymentValues
  onChange: (v: AdvancePaymentValues) => void
  errors: Partial<Record<keyof AdvancePaymentValues, string>>
}) {
  const wallets = (['BKASH', 'NAGAD', 'ROCKET'] as const).filter((c) => accounts.some((a) => a.channel === c && a.number))
  const account = accounts.find((a) => a.channel === value.channel && a.number)
  const [copied, setCopied] = useState(false)

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => {
    setCopied(true)
    toast.success('Number copied')
    setTimeout(() => setCopied(false), 1500)
  })

  if (wallets.length === 0) return null
  return (
    <div className="space-y-4 rounded-xl bg-muted/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
        </div>
        <p className="text-xl font-semibold tabular-nums"><Money value={amount} /></p>
      </div>

      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Wallet">
        {wallets.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={value.channel === c} data-active={value.channel === c}
            onClick={() => onChange({ ...value, channel: c })}
            className={cn('rounded-lg border bg-card px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted', WALLET[c].cls)}>
            {WALLET[c].name}
          </button>
        ))}
      </div>

      {account && (
        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-card text-xs font-semibold">1</span>
            <div className="min-w-0 flex-1">
              <p>Open {WALLET[value.channel].name} and <strong>Send Money</strong> <Money value={amount} /> to</p>
              <div className="mt-1.5 flex items-center justify-between rounded-lg border bg-card px-3 py-2">
                <span className="font-mono text-base tracking-wide tabular-nums">{account.number}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => copy(account.number)} aria-label="Copy number">
                  {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {account.label && <p className="mt-1 text-xs text-muted-foreground">{account.label}</p>}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-card text-xs font-semibold">2</span>
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <Field label={`Your ${WALLET[value.channel].name} number`} htmlFor="adv-sender" error={errors.sender_phone}>
                <Input id="adv-sender" className="bg-card" inputMode="tel" placeholder="01XXXXXXXXX" value={value.sender_phone}
                  onChange={(e) => onChange({ ...value, sender_phone: e.target.value })} aria-invalid={!!errors.sender_phone} />
              </Field>
              <Field label="Transaction ID (TrxID)" htmlFor="adv-trx" error={errors.transaction_id} hint="From the payment SMS">
                <Input id="adv-trx" className="bg-card font-mono uppercase" placeholder="e.g. 9JK4L2M8NP" value={value.transaction_id}
                  onChange={(e) => onChange({ ...value, transaction_id: e.target.value.toUpperCase().replace(/\s/g, '') })}
                  aria-invalid={!!errors.transaction_id} />
              </Field>
            </div>
          </li>
        </ol>
      )}
      <p className="text-xs text-muted-foreground">We confirm your order as soon as we verify the payment — usually within minutes.</p>
    </div>
  )
}

export function validateAdvancePayment(v: AdvancePaymentValues, isPhone: (p: string) => boolean): Partial<Record<keyof AdvancePaymentValues, string>> {
  const errors: Partial<Record<keyof AdvancePaymentValues, string>> = {}
  if (!isPhone(v.sender_phone)) errors.sender_phone = 'Enter the number you paid from'
  if (!/^[A-Z0-9]{6,30}$/.test(v.transaction_id)) errors.transaction_id = 'Enter the transaction ID from the SMS'
  return errors
}

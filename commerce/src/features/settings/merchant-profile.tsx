import { Plus, Star, Trash2 } from 'lucide-react'
import { Field } from '@/components/common/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingCard, TextareaSetting, TextSetting, useSettingDraft } from './setting-form'

interface PayoutAccount { type: string; account_name: string; account_number: string; bank?: string; branch?: string; routing?: string; is_default?: boolean }
const TYPES = [
  { value: 'BKASH', label: 'bKash' }, { value: 'NAGAD', label: 'Nagad' }, { value: 'ROCKET', label: 'Rocket' }, { value: 'BANK', label: 'Bank account' },
]

/** Owner and legal details plus where couriers and gateways pay you. Private: only staff with settings access can read it. */
export function MerchantProfile() {
  const m = useSettingDraft('merchant')
  const accounts = (m.get(['payout_accounts']) as PayoutAccount[] | undefined) ?? []
  const setAccounts = (next: PayoutAccount[]) => m.set(['payout_accounts'], next)
  const patch = (i: number, p: Partial<PayoutAccount>) => setAccounts(accounts.map((a, j) => (j === i ? { ...a, ...p } : a)))

  return (
    <div className="grid gap-4">
      <SettingCard setting={m} title="Merchant / owner" description="The person responsible for the business. Private — not shown to customers.">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextSetting s={m} path={['owner_name']} label="Owner name" />
          <TextSetting s={m} path={['owner_phone']} label="Owner phone" />
          <TextSetting s={m} path={['owner_email']} label="Owner email" />
          <TextSetting s={m} path={['nid_number']} label="NID number" mono />
          <TextSetting s={m} path={['tin']} label="TIN (e-TIN)" mono />
          <TextSetting s={m} path={['established']} label="Started in" placeholder="2022" />
        </div>
      </SettingCard>

      <SettingCard setting={m} title="Payout accounts" description="Where courier COD settlements and gateway payouts go. Used to check statements; nothing is paid from here."
        validate={() => accounts.some((a) => !a.account_name?.trim() || !a.account_number?.trim()) ? 'Every account needs a name and a number' : null}>
        {accounts.length === 0 && <p className="text-sm text-muted-foreground">No payout accounts yet.</p>}
        <div className="grid gap-3">
          {accounts.map((a, i) => (
            <div key={i} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[150px_1fr_1fr_auto] sm:items-end">
              <Field label="Type">
                <Select value={a.type} onValueChange={(v) => patch(i, { type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Account name"><Input value={a.account_name ?? ''} onChange={(e) => patch(i, { account_name: e.target.value })} /></Field>
              <Field label={a.type === 'BANK' ? 'Account number' : 'Wallet number'}>
                <Input className="font-mono" value={a.account_number ?? ''} onChange={(e) => patch(i, { account_number: e.target.value })} />
              </Field>
              <div className="flex gap-1">
                <Button type="button" size="icon" variant={a.is_default ? 'secondary' : 'ghost'} aria-label="Default account" title="Default account"
                  onClick={() => setAccounts(accounts.map((x, j) => ({ ...x, is_default: j === i })))}>
                  <Star className={a.is_default ? 'fill-current' : undefined} />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Remove account" onClick={() => setAccounts(accounts.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
              {a.type === 'BANK' && (
                <div className="grid gap-3 sm:col-span-4 sm:grid-cols-3">
                  <Field label="Bank"><Input value={a.bank ?? ''} onChange={(e) => patch(i, { bank: e.target.value })} /></Field>
                  <Field label="Branch"><Input value={a.branch ?? ''} onChange={(e) => patch(i, { branch: e.target.value })} /></Field>
                  <Field label="Routing number"><Input className="font-mono" value={a.routing ?? ''} onChange={(e) => patch(i, { routing: e.target.value })} /></Field>
                </div>
              )}
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" className="w-fit"
          onClick={() => setAccounts([...accounts, { type: 'BKASH', account_name: '', account_number: '', is_default: accounts.length === 0 }])}>
          <Plus /> Add account
        </Button>
      </SettingCard>

      <SettingCard setting={m} title="Notes">
        <TextareaSetting s={m} path={['notes']} label="Internal notes" rows={3} hint="Bank contacts, courier account managers, renewal dates…" />
      </SettingCard>
    </div>
  )
}

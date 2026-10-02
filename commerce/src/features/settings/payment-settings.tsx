import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ADVANCE_TYPE, PAYMENT_CHANNEL } from '@/lib/status'
import { NumberSetting, SelectSetting, SettingCard, SwitchSetting, TextareaSetting, TextSetting, useSettingDraft } from './setting-form'

interface Account { channel: string; label: string; number: string }

export const ADVANCE_OPTIONS = Object.entries(ADVANCE_TYPE).map(([value, label]) => ({ value, label }))

export function PaymentSettings() {
  const s = useSettingDraft('payments')
  const accounts = (s.get(['providers', 'manual', 'accounts']) as Account[] | undefined) ?? []
  const validate = () => {
    if (!s.get(['cod_enabled']) && !s.get(['advance_enabled']) && !s.get(['full_payment_enabled'])) return 'Enable at least one payment method'
    if (s.get(['providers', 'manual', 'enabled']) && accounts.every((a) => !a.number.trim())) return 'Add at least one account number for manual payments'
    return null
  }
  return (
    <div className="grid gap-4">
      <SettingCard setting={s} title="Payment methods" validate={validate}
        description="Payment confirmations are always verified on the server: gateway payments by the provider's validation API, manual transfers by a staff member.">
        <div className="grid gap-3 sm:grid-cols-3">
          <SwitchSetting s={s} path={['cod_enabled']} label="Cash on delivery" />
          <SwitchSetting s={s} path={['advance_enabled']} label="Advance + COD" hint="Customer pays part now, the rest on delivery" />
          <SwitchSetting s={s} path={['full_payment_enabled']} label="Full payment online" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectSetting s={s} path={['voluntary_advance', 'type']} label="Advance a customer can choose to pay" options={ADVANCE_OPTIONS.filter((o) => o.value !== 'FULL')} />
          {['FIXED', 'PERCENTAGE'].includes(String(s.get(['voluntary_advance', 'type']))) && (
            <NumberSetting s={s} path={['voluntary_advance', 'value']} label={s.get(['voluntary_advance', 'type']) === 'PERCENTAGE' ? 'Percentage' : 'Amount'} min={0} />
          )}
        </div>

        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="font-medium">bKash / Nagad / Rocket (manual)</p>
            <SwitchSetting s={s} path={['providers', 'manual', 'enabled']} label="Enabled" />
          </div>
          <div className="grid gap-4">
            <TextSetting s={s} path={['providers', 'manual', 'label']} label="Label at checkout" />
            <TextareaSetting s={s} path={['providers', 'manual', 'instructions']} label="Instructions" rows={2} />
            <div className="grid gap-2">
              <p className="text-sm font-medium">Accounts customers send money to</p>
              {accounts.map((a, i) => (
                <div key={i} className="grid grid-cols-[8rem_1fr_1fr_auto] items-center gap-2">
                  <Select value={a.channel} onValueChange={(v) => s.set(['providers', 'manual', 'accounts', i, 'channel'], v)}>
                    <SelectTrigger aria-label="Channel"><SelectValue /></SelectTrigger>
                    <SelectContent>{['BKASH', 'NAGAD', 'ROCKET', 'BANK_TRANSFER'].map((c) => <SelectItem key={c} value={c}>{PAYMENT_CHANNEL[c as keyof typeof PAYMENT_CHANNEL]}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input aria-label="Label" placeholder="bKash Personal" value={a.label} onChange={(e) => s.set(['providers', 'manual', 'accounts', i, 'label'], e.target.value)} />
                  <Input aria-label="Number" placeholder="01XXXXXXXXX" className="font-mono" value={a.number} onChange={(e) => s.set(['providers', 'manual', 'accounts', i, 'number'], e.target.value)} />
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove account" onClick={() => s.set(['providers', 'manual', 'accounts'], accounts.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => s.set(['providers', 'manual', 'accounts'], [...accounts, { channel: 'BKASH', label: '', number: '' }])}>
                <Plus /> Add account
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="font-medium">SSLCommerz (cards & mobile banking)</p>
            <SwitchSetting s={s} path={['providers', 'sslcommerz', 'enabled']} label="Enabled" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextSetting s={s} path={['providers', 'sslcommerz', 'label']} label="Label at checkout" />
            <SwitchSetting s={s} path={['providers', 'sslcommerz', 'sandbox']} label="Sandbox mode" hint="Use the test environment" />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Store ID and password are never stored here. Set <code>SSLCOMMERZ_STORE_ID</code> and <code>SSLCOMMERZ_STORE_PASSWORD</code> as
            Supabase Edge Function secrets.
          </p>
        </div>
      </SettingCard>
    </div>
  )
}

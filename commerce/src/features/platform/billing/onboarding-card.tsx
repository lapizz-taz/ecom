import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CreditCard, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDateTime, formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { activateMerchant, type OnboardingSettings, pendingActivations, platformSettings, saveOnboarding } from '@/services/billing'

const PLACEHOLDERS = ['{business}', '{name}', '{phone}', '{email}', '{plan}', '{price}', '{interval}']

/**
 * How new businesses that sign up are activated. The choice decides the sign-up's last step:
 * pay online (opens only after the gateway confirms) or a prefilled WhatsApp message (opens
 * when someone here activates it).
 */
export function OnboardingCard() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['platform-settings'], queryFn: platformSettings })
  const [draft, setDraft] = useState<OnboardingSettings | null>(null)
  const [confirm, setConfirm] = useState(false)
  const server = settings.data?.onboarding?.value as Partial<OnboardingSettings> | undefined
  useEffect(() => {
    if (!settings.data || draft) return
    setDraft({
      method: server?.method ?? 'online_payment', whatsapp_number: server?.whatsapp_number ?? '',
      whatsapp_template: server?.whatsapp_template ?? '', reminder_days: server?.reminder_days ?? [3, 1],
    })
  }, [settings.data, server, draft])
  const save = useMutation({
    mutationFn: (reason: string) => saveOnboarding(draft!, reason),
    onSuccess: (v) => { toast.success('Onboarding saved'); setDraft({ ...v, whatsapp_number: v.whatsapp_number ?? '' }); void queryClient.invalidateQueries({ queryKey: ['platform-settings'] }) },
    onError: (e) => toast.error(e),
  })
  if (settings.error) return <ErrorState error={settings.error} />
  if (!draft) return <LoadingState />
  const editable = can('subscriptions', 'manage')
  const set = (patch: Partial<OnboardingSettings>) => setDraft({ ...draft, ...patch })
  const Option = ({ value, icon: Icon, title, text }: { value: OnboardingSettings['method']; icon: typeof CreditCard; title: string; text: string }) => (
    <button type="button" disabled={!editable} onClick={() => set({ method: value })}
      className={cn('flex gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-70', draft.method === value ? 'border-foreground bg-muted/50' : 'hover:bg-muted/30')}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{text}</span></span>
    </button>
  )
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-sm">New business onboarding</CardTitle>
        <CardDescription>What happens after someone signs up on the public page. Plans with a free trial start the trial at once with online payment.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <Option value="online_payment" icon={CreditCard} title="Online payment, automatic activation"
            text="They pay the first invoice with bKash or PayStation; the account opens when the gateway confirms the payment." />
          <Option value="whatsapp" icon={MessageCircle} title="WhatsApp, activated by the team"
            text="They send a prefilled WhatsApp message to the official number; someone here activates the account." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Official WhatsApp number" hint="With country code, e.g. 8801712345678">
            <Input value={draft.whatsapp_number ?? ''} disabled={!editable} inputMode="tel" onChange={(e) => set({ whatsapp_number: e.target.value })} />
          </Field>
          <Field label="Renewal reminders (days before it ends)" hint="Comma-separated, 1–30. The merchant's admin shows “Expires in N days” and staff here get a notification.">
            <Input value={draft.reminder_days.join(', ')} disabled={!editable}
              onChange={(e) => set({ reminder_days: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) })} />
          </Field>
        </div>
        <Field label="WhatsApp message" hint={`Filled in for each business: ${PLACEHOLDERS.join(' ')}`}>
          <Textarea rows={6} value={draft.whatsapp_template} disabled={!editable} maxLength={1000} onChange={(e) => set({ whatsapp_template: e.target.value })} />
        </Field>
        {editable && <Button className="w-fit" size="sm" onClick={() => setConfirm(true)}>Save onboarding</Button>}
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Change onboarding?" reason reasonRequired
          description={draft.method === 'whatsapp' ? 'New sign-ups will wait for activation by the team after their WhatsApp message.' : 'New sign-ups on a paid plan will pay online before their account opens.'}
          confirmLabel="Save" onConfirm={(reason) => save.mutateAsync(reason)} />
      </CardContent>
    </Card>
  )
}

/** Businesses that signed up and wait for payment or activation; activate one by hand with a reason. */
export function PendingActivations() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['platform-pending-activations'], queryFn: pendingActivations, refetchInterval: 60_000 })
  const [activating, setActivating] = useState<{ id: string; name: string } | null>(null)
  const activate = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => activateMerchant(id, reason),
    onSuccess: () => { toast.success('Account activated'); void queryClient.invalidateQueries({ queryKey: ['platform-pending-activations'] }) },
    onError: (e) => toast.error(e),
  })
  if (list.error) return <ErrorState error={list.error} />
  if (!list.data) return <LoadingState />
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-sm">Waiting for activation {list.data.length > 0 && <Badge variant="warning" className="ml-1">{list.data.length}</Badge>}</CardTitle>
        <CardDescription>Online-payment sign-ups open by themselves once their payment is confirmed; WhatsApp sign-ups wait for you.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.data.length === 0 ? <EmptyState title="Nobody is waiting" /> : (
          <ul className="divide-y rounded-xl border text-sm">
            {list.data.map((m) => (
              <li key={m.merchant_id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">{m.name} <Badge variant={m.state === 'awaiting_whatsapp' ? 'info' : 'warning'} className="ml-1">{m.state === 'awaiting_whatsapp' ? 'WhatsApp' : 'Payment due'}</Badge></p>
                  <p className="text-xs text-muted-foreground">
                    {[m.owner_email, m.phone, m.whatsapp && m.whatsapp !== m.phone ? `WhatsApp ${m.whatsapp}` : null].filter(Boolean).join(' · ')}
                    {m.plan ? ` · ${m.plan.name} ${formatMoney(m.plan.price)}/${m.plan.interval.toLowerCase()}` : ''} · signed up {formatDateTime(m.created_at)}
                  </p>
                </div>
                {can('subscriptions', 'manage') && <Button size="sm" variant="outline" onClick={() => setActivating({ id: m.merchant_id, name: m.name })}>Activate</Button>}
              </li>
            ))}
          </ul>
        )}
        <ConfirmDialog open={!!activating} onOpenChange={(o) => !o && setActivating(null)} title={`Activate ${activating?.name ?? ''}?`}
          description="The account opens now and its plan starts (its trial when the plan has one). Record how they paid or why." reason reasonRequired
          reasonLabel="Reason (kept in the audit log)" confirmLabel="Activate"
          onConfirm={(reason) => activate.mutateAsync({ id: activating!.id, reason })} />
      </CardContent>
    </Card>
  )
}

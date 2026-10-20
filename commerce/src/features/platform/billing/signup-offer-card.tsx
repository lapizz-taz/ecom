import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gift } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { usePlatform } from '@/features/platform/platform-context'
import { formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { listPlans, platformSettings, savePlatformSetting } from '@/services/billing'

interface Offer { enabled: boolean; trial_days: string; first_price: string; first_periods: string }

/**
 * The new-business offer: a short free trial, then the first month(s) at an introductory price,
 * then the plan's normal price. Applies to businesses that sign up while it is on (paid plans).
 */
export function SignupOfferCard() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['platform-settings'], queryFn: platformSettings })
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [draft, setDraft] = useState<Offer | null>(null)
  const [confirm, setConfirm] = useState(false)
  const server = settings.data?.signup_offer?.value as Partial<{ enabled: boolean; trial_days: number; first_price: number | null; first_periods: number }> | undefined
  useEffect(() => {
    if (!settings.data || draft) return
    setDraft({
      enabled: !!server?.enabled, trial_days: String(server?.trial_days ?? 2),
      first_price: server?.first_price == null ? '' : String(server.first_price), first_periods: String(server?.first_periods ?? 1),
    })
  }, [settings.data, server, draft])
  const save = useMutation({
    mutationFn: (reason: string) => savePlatformSetting('signup_offer', { ...draft }, reason),
    onSuccess: () => { toast.success('Offer saved'); setDraft(null); void queryClient.invalidateQueries({ queryKey: ['platform-settings'] }) },
  })
  if (settings.error) return <ErrorState error={settings.error} />
  if (!draft) return <LoadingState />
  const editable = can('subscriptions', 'manage')
  const days = Number(draft.trial_days)
  const price = draft.first_price.trim() === '' ? null : Number(draft.first_price)
  const months = Number(draft.first_periods) || 1
  const example = (plans.data?.plans ?? []).find((p) => p.status === 'ACTIVE' && p.is_public && Number(p.price) > 0)
  const dirty = draft.enabled !== !!server?.enabled || draft.trial_days !== String(server?.trial_days ?? 2)
    || draft.first_price !== (server?.first_price == null ? '' : String(server.first_price)) || draft.first_periods !== String(server?.first_periods ?? 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gift className="size-4" /> New business offer
          <Badge variant={server?.enabled ? 'success' : 'neutral'}>{server?.enabled ? 'On' : 'Off'}</Badge>
        </CardTitle>
        <CardDescription>
          A short free trial, then the first month at a low price, then the plan&apos;s normal price. For businesses that sign up while it is on (paid plans only).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={draft.enabled} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} /> Offer on
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Free trial (days)" hint="0 for no trial">
            <Input type="number" min={0} max={90} inputMode="numeric" disabled={!editable} value={draft.trial_days} onChange={(e) => setDraft({ ...draft, trial_days: e.target.value })} />
          </Field>
          <Field label="First month price (Tk)" hint="Empty: the plan price">
            <Input type="number" min={0} step="1" inputMode="decimal" disabled={!editable} value={draft.first_price} onChange={(e) => setDraft({ ...draft, first_price: e.target.value })} />
          </Field>
          <Field label="Months at that price">
            <Input type="number" min={1} max={12} inputMode="numeric" disabled={!editable} value={draft.first_periods} onChange={(e) => setDraft({ ...draft, first_periods: e.target.value })} />
          </Field>
        </div>
        {example && Number.isFinite(days) && (
          <p className="rounded-[10px] bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            A business on {example.name}: {days > 0 ? `${days} day${days === 1 ? '' : 's'} free, ` : ''}
            {price != null && price < Number(example.price) ? `then ${formatMoney(price)} for the first ${months > 1 ? `${months} months` : 'month'}, ` : ''}
            then {formatMoney(example.price)} a month. When the trial ends unpaid the account waits for that first payment
            (&quot;Trial ended, first payment not made&quot; under Rules).
          </p>
        )}
        {editable && <Button size="sm" disabled={!dirty || save.isPending} onClick={() => setConfirm(true)}>Save offer</Button>}
      </CardContent>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} reason reasonRequired title="Save the new business offer?"
        description="Applies to businesses that sign up from now on. Businesses already signed up keep what they started with."
        confirmLabel="Save" onConfirm={async (reason) => {
          try { await save.mutateAsync(reason) } catch (e) { toast.error((e as Error).message); throw e }
        }} />
    </Card>
  )
}

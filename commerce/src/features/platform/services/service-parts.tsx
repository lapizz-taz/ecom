import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDate, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { saveFeature } from '@/services/billing'
import type { Service, ServiceStatus } from '@/services/credits'
import { ServiceOverrideDialog } from './override-dialog'

const NAME: Record<Service, string> = { SMS: 'SMS', BD_COURIER: 'BD Courier checks' }

/** The feature's switch for every merchant at once (Features & Access uses the same switch). */
export function GlobalSwitchCard({ service, status }: { service: Service; status: ServiceStatus }) {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [to, setTo] = useState<boolean | null>(null)
  const f = status.feature
  if (!f) return null
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{NAME[service]} for all merchants</p>
          <p className="text-xs text-muted-foreground">
            {f.globally_enabled ? 'On. Merchants get it according to their plan and any exception below.' : 'Off for everyone. Nothing is sent or looked up until it is switched back on.'}
            {' '}Plans that include it: {status.plans.filter((p) => p.includes).map((p) => p.name).join(', ') || 'none'}.
          </p>
        </div>
        <Switch aria-label={`${NAME[service]} for all merchants`} checked={f.globally_enabled} disabled={!can('features', 'manage')} onCheckedChange={setTo} />
      </CardContent>
      {to !== null && (
        <ConfirmDialog open onOpenChange={(o) => !o && setTo(null)} reason reasonRequired destructive={!to}
          title={to ? `Switch ${NAME[service]} back on?` : `Switch ${NAME[service]} off for every merchant?`}
          description={to ? 'Merchants whose plan includes it can use it again straight away.' : 'The backend refuses it for all merchants immediately. Queued SMS fail with the reason; checkouts fall back to the store\'s own history.'}
          confirmLabel={to ? 'Switch on' : 'Switch off'}
          onConfirm={async (reason) => {
            try {
              await saveFeature(f.code, { globally_enabled: to, reason })
              toast.success('Saved')
              void queryClient.invalidateQueries({ queryKey: ['platform-service', service] })
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </Card>
  )
}

/** Merchants with their own limits, and merchants switched on/off by exception. */
export function MerchantExceptions({ service, status }: { service: Service; status: ServiceStatus }) {
  const [editing, setEditing] = useState<ServiceStatus['overrides'][number] | 'new' | null>(null)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center justify-between border-b py-3">
          <CardTitle className="text-sm">Own limits{service === 'SMS' ? ' and sender IDs' : ''}</CardTitle>
          {status.can.edit && <Button size="sm" variant="outline" onClick={() => setEditing('new')}><Plus /> Add</Button>}
        </CardHeader>
        {status.overrides.length === 0 ? <EmptyState title="Every merchant follows the policy" /> : status.overrides.map((o) => (
          <div key={o.merchant.id} className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-sm last:border-0">
            <span className="min-w-0">
              <Link className="font-medium underline" to={`/super-admin/merchants/${o.merchant.id}?tab=credits`}>#{o.merchant.number} {o.merchant.name}</Link>
              <span className="block text-xs text-muted-foreground">
                {[o.free_limit != null && `free ${formatNumber(o.free_limit)}`, o.monthly_cap != null && `cap ${formatNumber(o.monthly_cap)}/month`, o.sender_id && `sender ${o.sender_id}`]
                  .filter(Boolean).join(' · ')} — “{o.reason}”
              </span>
            </span>
            {status.can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>Edit</Button>}
          </div>
        ))}
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3"><CardTitle className="text-sm">Switched on or off by exception</CardTitle></CardHeader>
        {status.exceptions.length === 0 ? <EmptyState title="No exceptions" description="Set them on a merchant's Features tab, or in bulk under Features & Access." /> : status.exceptions.map((e) => (
          <div key={e.merchant.id} className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-sm last:border-0">
            <span className="min-w-0">
              <Link className="font-medium underline" to={`/super-admin/merchants/${e.merchant.id}?tab=features`}>#{e.merchant.number} {e.merchant.name}</Link>
              <span className="block text-xs text-muted-foreground">“{e.reason ?? 'no reason'}”{e.expires_at && ` · until ${formatDate(e.expires_at)}`}</span>
            </span>
            <Badge variant={e.enabled ? 'success' : 'danger'}>{e.enabled ? 'always on' : 'switched off'}</Badge>
          </div>
        ))}
      </Card>
      {editing && (
        <ServiceOverrideDialog service={service} onClose={() => setEditing(null)} senderIds={status.config.sender_ids}
          merchant={editing === 'new' ? null : editing.merchant} current={editing === 'new' ? null : editing} />
      )}
    </div>
  )
}

/** How SMS and lookups are counted and charged, in plain words (the same rules the database applies). */
export function ChargingRules({ service }: { service: Service }) {
  const rows = service === 'SMS' ? [
    ['Waiting in the queue', 'Not charged'],
    ['Handed to the provider', 'Charged: free allowance first, then credits'],
    ['Provider rejects it, or gives up after retries', 'Refunded in full'],
    ['Temporary failure, retried', 'Charged once; retries are free'],
    ['Delivered', 'Charged'],
    ['Reported undelivered', 'Charged, unless “refund undelivered” is on'],
    ['Not a mobile number, or refused by policy', 'Never charged'],
    ['No credits', 'Waits (up to the hold time), then fails without charge'],
  ] : [
    ['Lookup reaches BD Courier', 'One use: free allowance first, then credits'],
    ['Same number again within the merchant’s cache window', 'Not counted (the saved result is reused)'],
    ['BD Courier error or timeout', 'Refunded; does not use the free allowance'],
    ['Refused (no credits, cap, feature off)', 'Not sent to BD Courier; checkout uses the store’s own history'],
  ]
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">How it is charged</CardTitle></CardHeader>
      <CardContent className="space-y-1.5">
        {rows.map(([when, what]) => (
          <div key={when} className="flex justify-between gap-4 border-b pb-1.5 text-sm last:border-0"><span className="text-muted-foreground">{when}</span><span className="text-right">{what}</span></div>
        ))}
      </CardContent>
    </Card>
  )
}

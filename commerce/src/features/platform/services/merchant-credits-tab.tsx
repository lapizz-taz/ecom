import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDate, formatDateTime, formatNumber } from '@/lib/format'
import { ENTITLEMENT, type EntitlementState } from '@/services/billing'
import { LEDGER_KIND, merchantCredits, type Service, type UsageState } from '@/services/credits'
import type { MerchantDetail } from '@/services/platform'
import { AdjustCreditsDialog } from './adjust-credits-dialog'
import { ServiceOverrideDialog } from './override-dialog'

/** What a merchant may use now: feature, free allowance, monthly cap and how extra use is paid. */
export function UsageStateCard({ title, state, onEdit }: { title: string; state: UsageState; onEdit?: () => void }) {
  const unit = state.unit === 'LOOKUP' ? 'lookups' : state.unit === 'MESSAGE' ? 'messages' : 'SMS parts'
  const ent = ENTITLEMENT[state.feature_state as EntitlementState]
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">{title} {ent && <Badge variant={ent.variant}>{ent.label}</Badge>}</CardTitle>
        {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>Set limits</Button>}
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {state.unmetered ? <p>Unmetered on the {state.plan} plan — use is recorded, never charged.</p> : (
          <>
            <p>Free: {state.free.eligible ? `${formatNumber(state.free.remaining)} of ${formatNumber(state.free.limit)} ${unit} left ${state.free.period === 'MONTH' ? 'this month' : '(one-time)'}` : 'not eligible'}{state.free.merchant_limit != null && ' · merchant-specific limit'}</p>
            <p>After that: {state.after_free === 'BLOCK' ? 'stopped' : `${state.credits_per_unit} ${state.credit_type.toLowerCase()} credit${state.credits_per_unit === 1 ? '' : 's'} each · ${formatNumber(state.credits_available)} available`}</p>
          </>
        )}
        <p className="text-muted-foreground">This month: {formatNumber(state.month_used)} {unit}{state.monthly_cap != null && ` of ${formatNumber(state.monthly_cap)} allowed`}</p>
        {state.sender_id && <p className="text-muted-foreground">Sender ID: {state.sender_id}</p>}
      </CardContent>
    </Card>
  )
}

export function MerchantCreditsTab({ detail }: { detail: MerchantDetail }) {
  const id = detail.merchant.id
  const { can } = usePlatform()
  const data = useQuery({ queryKey: ['platform-merchant-credits', id], queryFn: () => merchantCredits(id) })
  const [adjust, setAdjust] = useState(false)
  const [limits, setLimits] = useState<Service | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const d = data.data
  const ref = { id, number: detail.merchant.number, name: detail.merchant.name }
  const override = (service: Service) => d.overrides.find((o) => o.service === service) ?? null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-3">
          {d.balances.map((b) => (
            <Card key={b.code} className="min-w-44 gap-1 px-4 py-3">
              <p className="text-xs text-muted-foreground">{b.name}</p>
              <p className="text-xl font-semibold tabular-nums">{formatNumber(b.available)}</p>
              {b.expiring_30d > 0 && <p className="text-xs text-amber-600">{formatNumber(b.expiring_30d)} expire within 30 days</p>}
            </Card>
          ))}
        </div>
        {(can('credits', 'create', id) || can('credits', 'manage', id)) && <Button size="sm" onClick={() => setAdjust(true)}><Plus /> Change credits</Button>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageStateCard title="SMS" state={d.usage.sms} onEdit={can('sms', 'edit', id) ? () => setLimits('SMS') : undefined} />
        <UsageStateCard title="BD Courier checks" state={d.usage.bd_courier} onEdit={can('bd_courier', 'edit', id) ? () => setLimits('BD_COURIER') : undefined} />
      </div>
      {d.lots.some((l) => l.expires_at) && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Credits with an expiry date</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {d.lots.filter((l) => l.expires_at).map((l) => (
              <p key={l.id}>{formatNumber(l.remaining)} of {formatNumber(l.granted)} {l.credit_type.toLowerCase()} credits · expire {formatDate(l.expires_at)} <span className="text-muted-foreground">— {l.reason}</span></p>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="gap-0 overflow-hidden py-0">
        <p className="border-b px-4 py-2 text-sm font-medium">Ledger (last 100)</p>
        {d.ledger.length === 0 ? <EmptyState title="No credit changes yet" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead className="text-right">Change</TableHead><TableHead className="text-right">Balance</TableHead><TableHead>Why</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
              <TableBody>
                {d.ledger.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell>
                    <TableCell><Badge variant={LEDGER_KIND[e.kind].variant}>{LEDGER_KIND[e.kind].label}</Badge> <span className="text-xs text-muted-foreground">{e.credit_type.toLowerCase()}</span></TableCell>
                    <TableCell className={`text-right tabular-nums ${e.amount > 0 ? 'text-emerald-600' : ''}`}>{e.amount > 0 ? '+' : ''}{formatNumber(e.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(e.balance_after)}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs">{e.reason}{e.expires_at && ` · expires ${formatDate(e.expires_at)}`}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.actor}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
      {adjust && <AdjustCreditsDialog merchant={ref} open onOpenChange={setAdjust} />}
      {limits && <ServiceOverrideDialog service={limits} merchant={ref} current={override(limits)} onClose={() => setLimits(null)} />}
    </div>
  )
}

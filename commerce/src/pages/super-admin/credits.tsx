import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePlatform } from '@/features/platform/platform-context'
import { AdjustCreditsDialog } from '@/features/platform/services/adjust-credits-dialog'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { savePlatformSetting } from '@/services/billing'
import { type CreditPackage, creditsOverview, type CreditType, LEDGER_KIND, savePackage } from '@/services/credits'

function PackageDialog({ pkg, onClose }: { pkg: CreditPackage | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: pkg?.name ?? '', credit_type: pkg?.credit_type ?? 'SMS', credits: String(pkg?.credits ?? ''), bonus: String(pkg?.bonus_credits ?? 0), price: String(pkg?.price ?? ''),
  })
  const save = useMutation({
    mutationFn: () => savePackage({ ...(pkg ? { id: pkg.id } : { credit_type: form.credit_type }), name: form.name.trim(), credits: Number(form.credits), bonus_credits: Number(form.bonus) || 0, price: Number(form.price) }),
    onSuccess: () => { toast.success('Package saved'); void queryClient.invalidateQueries({ queryKey: ['platform-credits'] }); onClose() },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={pkg ? `Edit ${pkg.name}` : 'New recharge package'} busy={save.isPending}
      description="What merchants can buy on their Plan & Billing page. Price changes apply to new purchases only."
      disabled={form.name.trim().length < 2 || !(Number(form.credits) > 0) || !(Number(form.price) > 0)} onSubmit={() => save.mutate()} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="SMS 1,000" /></Field>
        <Field label="Credit type">
          <Select disabled={!!pkg} value={form.credit_type} onValueChange={(v) => setForm((f) => ({ ...f, credit_type: v as CreditType }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="SMS">SMS credits</SelectItem><SelectItem value="COURIER">Courier check credits</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Credits" required><Input type="number" min={1} value={form.credits} onChange={(e) => setForm((f) => ({ ...f, credits: e.target.value }))} /></Field>
        <Field label="Bonus credits"><Input type="number" min={0} value={form.bonus} onChange={(e) => setForm((f) => ({ ...f, bonus: e.target.value }))} /></Field>
        <Field label="Price (BDT)" required><Input type="number" min={1} step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} /></Field>
        {Number(form.credits) > 0 && Number(form.price) > 0 && (
          <p className="self-end pb-2 text-xs text-muted-foreground">{formatMoney(Number(form.price) / (Number(form.credits) + (Number(form.bonus) || 0)))} per credit</p>
        )}
      </div>
    </FormDialog>
  )
}

export default function CreditsPage() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'balances', q: '', type: '' })
  const data = useQuery({ queryKey: ['platform-credits', state.q, state.type], queryFn: () => creditsOverview(state.q, state.type) })
  const [adjust, setAdjust] = useState(false)
  const [pkg, setPkg] = useState<CreditPackage | 'new' | null>(null)
  const [archiving, setArchiving] = useState<CreditPackage | null>(null)
  const [threshold, setThreshold] = useState<string | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const d = data.data
  const types = d.types.filter((t) => t.used_by)
  return (
    <div className="space-y-4">
      <PageHeader title="Credits & Wallets" description="Prepaid credits for SMS and BD Courier checks. Every change is a ledger entry with who, why and the new balance; nothing is ever edited or deleted."
        actions={(can('credits', 'create') || can('credits', 'manage')) && <Button size="sm" onClick={() => setAdjust(true)}><Plus /> Change credits</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {types.map((t) => (
          <StatCard key={t.code} label={`${t.name} outstanding`} value={formatNumber(t.outstanding)}
            hint={`${formatNumber(t.merchants_with_balance)} merchants · +${formatNumber(t.added_30d)} added, ${formatNumber(t.used_30d)} used in 30 days`} />
        ))}
        <StatCard label="AI credits" value="Not used yet" hint="Reserved; no feature spends them" />
      </div>
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="balances">Balances</TabsTrigger>
          <TabsTrigger value="ledger">Latest changes</TabsTrigger>
          <TabsTrigger value="packages">Recharge packages</TabsTrigger>
          <TabsTrigger value="settings">Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="balances" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Merchant name or number" />
          </div>
          <Card className="gap-0 overflow-hidden py-0">
            {d.merchants.length === 0 ? <EmptyState title="No merchants" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Merchant</TableHead>{types.map((t) => <TableHead key={t.code} className="text-right">{t.name}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>
                    {d.merchants.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell><Link className="underline" to={`/super-admin/merchants/${m.id}?tab=credits`}>#{m.number} {m.name}</Link> <span className="text-xs text-muted-foreground">{m.status.toLowerCase()}</span></TableCell>
                        {types.map((t) => <TableCell key={t.code} className="text-right tabular-nums">{formatNumber(m.balances?.[t.code] ?? 0)}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="ledger">
          <Card className="gap-0 overflow-hidden py-0">
            {d.recent.length === 0 ? <EmptyState title="No credit changes yet" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Merchant</TableHead><TableHead>What</TableHead><TableHead className="text-right">Change</TableHead><TableHead className="text-right">Balance</TableHead><TableHead>Why</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {d.recent.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell>
                        <TableCell className="text-xs">{e.merchant && <Link className="underline" to={`/super-admin/merchants/${e.merchant.id}?tab=credits`}>#{e.merchant.number} {e.merchant.name}</Link>}</TableCell>
                        <TableCell><Badge variant={LEDGER_KIND[e.kind].variant}>{LEDGER_KIND[e.kind].label}</Badge> <span className="text-xs text-muted-foreground">{e.credit_type.toLowerCase()}</span></TableCell>
                        <TableCell className={`text-right tabular-nums ${e.amount > 0 ? 'text-emerald-600' : ''}`}>{e.amount > 0 ? '+' : ''}{formatNumber(e.amount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(e.balance_after)}</TableCell>
                        <TableCell className="max-w-56 truncate text-xs">{e.reason}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{e.actor}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="packages" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">Merchants buy these on Plan & Billing and pay through the platform's gateway; credits arrive when the payment is confirmed.</p>
            {can('credits', 'manage') && <Button size="sm" onClick={() => setPkg('new')}><Plus /> New package</Button>}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {d.packages.map((k) => (
              <Card key={k.id} className={`gap-2 px-4 py-3 ${k.status === 'ARCHIVED' ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div><p className="font-medium">{k.name}</p><p className="text-xs text-muted-foreground">{k.credit_type === 'SMS' ? 'SMS credits' : 'Courier check credits'}</p></div>
                  {k.status === 'ARCHIVED' && <Badge variant="neutral">archived</Badge>}
                </div>
                <p className="text-xl font-semibold">{formatMoney(k.price)}</p>
                <p className="text-sm">{formatNumber(k.credits)} credits{k.bonus_credits > 0 && ` + ${formatNumber(k.bonus_credits)} bonus`} <span className="text-xs text-muted-foreground">· {formatMoney(k.price / (k.credits + k.bonus_credits))} each</span></p>
                {can('credits', 'manage') && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPkg(k)}><Pencil /> Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setArchiving(k)}>{k.status === 'ACTIVE' ? 'Archive' : 'Restore'}</Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <Card className="max-w-xl">
            <CardHeader><CardTitle className="text-sm">Second-person approval</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="Credit changes larger than this need a second person" hint="Applies to manual grants and adjustments; purchases and usage are automatic">
                <Input type="number" min={0} disabled={!(can('credits', 'manage') && can('settings', 'edit'))}
                  value={threshold ?? String(d.settings.approval_threshold ?? 1000)} onChange={(e) => setThreshold(e.target.value)} />
              </Field>
              {threshold !== null && (
                <Button size="sm" onClick={async () => {
                  try {
                    await savePlatformSetting('credits', { ...d.settings, approval_threshold: Math.max(0, Math.floor(Number(threshold) || 0)) }, 'Approval threshold changed')
                    toast.success('Saved')
                    setThreshold(null)
                    void queryClient.invalidateQueries({ queryKey: ['platform-credits'] })
                  } catch (e) { toast.error((e as Error).message) }
                }}>Save</Button>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {adjust && <AdjustCreditsDialog open onOpenChange={setAdjust} threshold={d.settings.approval_threshold} />}
      {pkg && <PackageDialog pkg={pkg === 'new' ? null : pkg} onClose={() => setPkg(null)} />}
      {archiving && (
        <ConfirmDialog open onOpenChange={(o) => !o && setArchiving(null)} title={archiving.status === 'ACTIVE' ? `Stop selling ${archiving.name}?` : `Sell ${archiving.name} again?`}
          description="Credits already bought are not affected." confirmLabel={archiving.status === 'ACTIVE' ? 'Archive' : 'Restore'}
          onConfirm={async () => {
            try {
              await savePackage({ id: archiving.id, status: archiving.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' })
              void queryClient.invalidateQueries({ queryKey: ['platform-credits'] })
            } catch (e) { toast.error((e as Error).message); throw e }
          }} />
      )}
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Tag } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type OrderFeeSettings, type OrderFeeState, orderFeeOverview, saveOrderFeeSettings, setOrderFeeOverride } from '@/services/credits'
import type { MerchantRef } from '@/services/platform'
import { AdjustCreditsDialog } from './adjust-credits-dialog'

type Store = OrderFeeState & { merchant_id: string; number: number; name: string; status: string }

const tk = (v: number) => formatMoney(v)

/** The platform price for each approved order: switch, price, empty-balance rule, free orders, plans never charged. */
function SettingsCard({ settings, plans, canEdit }: { settings: OrderFeeSettings; plans: Array<{ code: string; name: string }>; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    enabled: settings.enabled, fee: String(settings.fee ?? 1.5), on_empty: settings.on_empty ?? 'BLOCK', free: String(settings.free_per_month ?? 0),
    low: String(settings.low_balance_tk ?? 100), plans: settings.unmetered_plans ?? [], reason: '',
  })
  const dirty = form.enabled !== settings.enabled || Number(form.fee) !== settings.fee || form.on_empty !== settings.on_empty
    || Number(form.free) !== settings.free_per_month || Number(form.low) !== settings.low_balance_tk
    || form.plans.slice().sort().join() !== (settings.unmetered_plans ?? []).slice().sort().join()
  const save = useMutation({
    mutationFn: () => saveOrderFeeSettings({
      enabled: form.enabled, fee: Number(form.fee), on_empty: form.on_empty, free_per_month: Math.max(0, Math.floor(Number(form.free) || 0)),
      low_balance_tk: Math.max(0, Number(form.low) || 0), unmetered_plans: form.plans,
    }, form.reason.trim()),
    onSuccess: () => {
      toast.success('Order fee saved')
      setForm((f) => ({ ...f, reason: '' }))
      void queryClient.invalidateQueries({ queryKey: ['platform-order-fee'] })
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const feeOk = Number(form.fee) >= 0 && Number(form.fee) <= 1000 && /^\d+(\.\d{1,2})?$/.test(form.fee.trim())
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-sm">Fee for each approved order</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Charged once, when an order is first approved, from the store's balance. Cancelling it later does not refund it.</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Switch checked={form.enabled} disabled={!canEdit} onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
          {form.enabled ? 'On' : 'Off'}
        </label>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Price per approved order (Tk)" required>
            <Input type="number" min={0} max={1000} step="0.01" inputMode="decimal" disabled={!canEdit} value={form.fee}
              onChange={(e) => setForm((f) => ({ ...f, fee: e.target.value }))} />
          </Field>
          <Field label="When the balance is empty">
            <Select disabled={!canEdit} value={form.on_empty} onValueChange={(v) => setForm((f) => ({ ...f, on_empty: v as 'BLOCK' | 'ALLOW' }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="BLOCK">Stop approvals until recharged</SelectItem>
                <SelectItem value="ALLOW">Approve and record as unpaid</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Free orders each month">
            <Input type="number" min={0} step={1} disabled={!canEdit} value={form.free} onChange={(e) => setForm((f) => ({ ...f, free: e.target.value }))} />
          </Field>
          <Field label="Warn stores below (Tk)">
            <Input type="number" min={0} step="1" disabled={!canEdit} value={form.low} onChange={(e) => setForm((f) => ({ ...f, low: e.target.value }))} />
          </Field>
        </div>
        {plans.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Plans that are never charged</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {plans.map((p) => (
                <label key={p.code} className="flex items-center gap-2 text-sm">
                  <Checkbox disabled={!canEdit} checked={form.plans.includes(p.code)}
                    onCheckedChange={(c) => setForm((f) => ({ ...f, plans: c ? [...f.plans, p.code] : f.plans.filter((x) => x !== p.code) }))} />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {canEdit && dirty && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Reason for the change" required className="flex-1">
              <Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="New pricing from next month" />
            </Field>
            <Button disabled={!feeOk || form.reason.trim().length < 5 || save.isPending} onClick={() => save.mutate()}>Save</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** One store's price: the platform price, its own price, or no fee at all. */
function PriceDialog({ store, onClose }: { store: Store; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'PLATFORM' | 'CUSTOM' | 'EXEMPT'>(store.exempt ? 'EXEMPT' : store.store_fee != null ? 'CUSTOM' : 'PLATFORM')
  const [fee, setFee] = useState(String(store.store_fee ?? store.platform_fee))
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => setOrderFeeOverride(store.merchant_id, mode === 'CUSTOM' ? Number(fee) : null, mode === 'EXEMPT', reason.trim()),
    onSuccess: () => {
      toast.success(`Price saved for ${store.name}`)
      void queryClient.invalidateQueries({ queryKey: ['platform-order-fee'] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Order fee for ${store.name}`} busy={save.isPending} submitLabel="Save"
      disabled={reason.trim().length < 5 || (mode === 'CUSTOM' && !(Number(fee) >= 0 && Number(fee) <= 1000))} onSubmit={() => save.mutate()}
      description="Applies to orders approved from now on. Orders already charged keep their charge.">
      <Field label="Price">
        <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="PLATFORM">Platform price ({tk(store.platform_fee)})</SelectItem>
            <SelectItem value="CUSTOM">Own price for this store</SelectItem>
            <SelectItem value="EXEMPT">No fee for this store</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === 'CUSTOM' && (
        <Field label="Price per approved order (Tk)" required>
          <Input type="number" min={0} max={1000} step="0.01" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
      )}
      <Field label="Reason" required hint="Kept in the platform log">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormDialog>
  )
}

export function OrderFeePanel() {
  const { can } = usePlatform()
  const [q, setQ] = useState('')
  const data = useQuery({ queryKey: ['platform-order-fee', q], queryFn: () => orderFeeOverview(q) })
  const [topUp, setTopUp] = useState<MerchantRef | null>(null)
  const [pricing, setPricing] = useState<Store | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const d = data.data
  const canManage = can('credits', 'manage')
  return (
    <div className="space-y-4">
      <SettingsCard key={JSON.stringify(d.settings)} settings={d.settings} plans={d.plans} canEdit={canManage} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Charged this month" value={tk(d.totals.month_charged_tk)} hint={`${formatNumber(d.totals.month_orders)} approved orders recorded`} />
        <StatCard label="Unpaid orders" value={formatNumber(d.totals.unpaid_orders)} hint={`${tk(d.totals.unpaid_tk)} not collected`} />
        <StatCard label="Stores low on balance" value={formatNumber(d.stores.filter((s) => s.low_balance).length)} hint={`Below ${tk(d.settings.low_balance_tk)}`} />
        <StatCard label="Price" value={d.settings.enabled ? tk(d.settings.fee) : 'Off'} hint={d.settings.enabled ? 'per approved order' : 'Nothing is charged'} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Store name or number" />
        {canManage && <Button size="sm" onClick={() => setTopUp({ id: '', number: 0, name: '' } as MerchantRef)}><Plus /> Add balance</Button>}
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {d.stores.length === 0 ? <EmptyState title="No stores" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">This month</TableHead>
                  <TableHead className="text-right">Orders left</TableHead>
                  {canManage && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.stores.map((s) => (
                  <TableRow key={s.merchant_id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" to={`/super-admin/merchants/${s.merchant_id}?tab=credits`}>#{s.number} {s.name}</Link>
                      {s.low_balance && <Badge variant="warning" className="ml-2">low balance</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{tk(s.balance_tk)}</TableCell>
                    <TableCell className="text-right">
                      {s.exempt ? <Badge variant="info">no fee</Badge> : s.unmetered ? <Badge variant="info">plan: no fee</Badge> : (
                        <span className="tabular-nums">{tk(s.fee)}{s.store_fee != null && <span className="ml-1 text-xs text-muted-foreground">own</span>}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatNumber(s.month.charged)} · {tk(s.month.amount_tk)}
                      {(s.month.free > 0 || s.month.unpaid > 0) && (
                        <span className="block text-xs text-muted-foreground">
                          {s.month.free > 0 && `${formatNumber(s.month.free)} free`}{s.month.free > 0 && s.month.unpaid > 0 && ' · '}
                          {s.month.unpaid > 0 && <span className="text-amber-600">{formatNumber(s.month.unpaid)} unpaid</span>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.exempt || s.unmetered || s.orders_left == null ? '—' : formatNumber(s.orders_left)}</TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => setTopUp({ id: s.merchant_id, number: s.number, name: s.name } as MerchantRef)}><Plus /> Balance</Button>
                          <Button size="sm" variant="ghost" onClick={() => setPricing(s)}><Tag /> Price</Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
      {topUp && (
        <AdjustCreditsDialog open onOpenChange={(o) => !o && setTopUp(null)} merchant={topUp.id ? topUp : null} type="BALANCE" />
      )}
      {pricing && <PriceDialog store={pricing} onClose={() => setPricing(null)} />}
    </div>
  )
}

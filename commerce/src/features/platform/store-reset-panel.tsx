import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RotateCcw, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { MerchantDetail } from '@/services/platform'
import { exportMerchantData, resetStore, type ResetScope, storeResets } from '@/services/platform-data'

const SCOPES: Record<ResetScope, { title: string; removes: string; keeps: string }> = {
  ORDERS: {
    title: 'Orders and customers',
    removes: 'Orders with their items, history, payments, parcels and courier records; customers; incomplete orders and carts; fraud checks; sent messages; store import records; income and expense entries linked to orders.',
    keeps: 'Products and stock (anything held for orders is released), suppliers and purchases, other income and expense entries.',
  },
  EVERYTHING: {
    title: 'Everything (start fresh)',
    removes: 'All of the above, plus products, stock and its history, categories, coupons, suppliers and purchases, every income and expense entry, and everything the business connected, with its saved keys and history: Shopify and WooCommerce stores, courier accounts, ad accounts and synced ad data, payment, SMS and fraud-check providers, API keys, custom domains and the system log.',
    keeps: 'Nothing operational: the business starts like a new one, with the default "Own delivery" courier and connection settings. A store that sent visitors to Shopify or WooCommerce is closed until it is set up again.',
  },
}
const ALWAYS_KEPT = 'The account, staff and roles, store details and other settings, subscription and invoices, credit balance and its ledger, order fees, and every audit log. All connections stay after an orders-only reset.'

function download(number: number, r: Awaited<ReturnType<typeof exportMerchantData>>) {
  const blob = new Blob([JSON.stringify({ exported_at: r.exported_at, export_id: r.export_id, rows: r.rows, ...r.data }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `merchant-${number}-before-reset-${r.exported_at.slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * Wipes one store's day-to-day data so it can start again. The database checks
 * the permission, the typed store name, the reason and a fresh export again.
 */
export function StoreResetPanel({ detail }: { detail: MerchantDetail }) {
  const m = detail.merchant
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['platform-store-resets', m.id], queryFn: () => storeResets(m.id) })
  const [scope, setScope] = useState<ResetScope>('ORDERS')
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [reason, setReason] = useState('')
  const exporting = useMutation({
    meta: { silent: true },
    mutationFn: () => exportMerchantData(m.id, 'Copy kept before resetting the store'),
    onSuccess: (r) => {
      download(m.number, r)
      toast.success(`Exported ${formatNumber(Object.values(r.rows).reduce((s, n) => s + n, 0))} records`)
      void queryClient.invalidateQueries({ queryKey: ['platform-store-resets', m.id] })
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const reset = useMutation({
    meta: { silent: true },
    mutationFn: () => resetStore(m.id, scope, confirm, reason.trim()),
    onSuccess: (r) => {
      const total = Object.values(r.counts).reduce((s, n) => s + n, 0)
      toast.success(`${m.name} was reset`, { description: `${formatNumber(r.counts.orders ?? 0)} orders and ${formatNumber(total)} records in total removed.` })
      setOpen(false)
      setConfirm('')
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['platform-store-resets', m.id] })
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant', m.id] })
    },
  })
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const d = data.data
  const exportReady = !!d.export_valid_until && new Date(d.export_valid_until) > new Date()
  const canReset = detail.can.manage
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Card className="border-red-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ShieldAlert className="size-4 text-red-500" /> Reset store data</CardTitle>
          <p className="text-xs text-muted-foreground">Removes this store's day-to-day records so it can start again. This cannot be undone; the export below is the only copy.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={scope} onValueChange={(v) => setScope(v as ResetScope)} className="gap-2">
            {(Object.keys(SCOPES) as ResetScope[]).map((k) => (
              <label key={k} className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-foreground">
                <RadioGroupItem value={k} className="mt-0.5" />
                <span className="space-y-1">
                  <span className="block font-medium">{SCOPES[k].title}</span>
                  <span className="block text-xs text-muted-foreground"><span className="font-medium text-foreground">Removes:</span> {SCOPES[k].removes}</span>
                  <span className="block text-xs text-muted-foreground"><span className="font-medium text-foreground">Keeps:</span> {SCOPES[k].keeps}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Always kept:</span> {ALWAYS_KEPT}</p>
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium">1. Keep a copy</p>
              <p className="text-xs text-muted-foreground">
                {exportReady ? `Exported ${timeAgo(d.last_export_at!)} — reset allowed until ${formatDateTime(d.export_valid_until!)}`
                  : d.last_export_at ? `Last export ${timeAgo(d.last_export_at)} is too old; take a new one` : 'A full export from the last 24 hours is required'}
              </p>
            </div>
            <Button size="sm" variant={exportReady ? 'outline' : 'default'} disabled={exporting.isPending} onClick={() => exporting.mutate()}>
              <Download /> {exporting.isPending ? 'Exporting…' : 'Download full export'}
            </Button>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium">2. Reset</p>
              <p className="text-xs text-muted-foreground">{canReset ? 'You will type the store name to confirm.' : 'Needs the "manage merchants" permission.'}</p>
            </div>
            <Button size="sm" variant="destructive" disabled={!canReset || !exportReady} onClick={() => setOpen(true)}><RotateCcw /> Reset {SCOPES[scope].title.toLowerCase()}</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Previous resets</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {d.resets.length === 0 && <p className="text-sm text-muted-foreground">This store has never been reset.</p>}
          {d.resets.map((r) => (
            <div key={r.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={r.scope === 'EVERYTHING' ? 'danger' : 'warning'}>{SCOPES[r.scope].title.toLowerCase()}</Badge>
                <span className="text-muted-foreground">{formatDateTime(r.created_at)}</span>
              </div>
              <p className="mt-1">“{r.reason}”</p>
              <p className="text-muted-foreground">{r.requested_by_email ?? 'unknown'}{r.counts && ` · ${formatNumber(r.counts.orders ?? 0)} orders${r.counts.products != null ? `, ${formatNumber(r.counts.products)} products` : ''}`}</p>
            </div>
          ))}
        </CardContent>
      </Card>
      {open && (
        <FormDialog open onOpenChange={(o) => !o && setOpen(false)} title={`Reset ${m.name}?`} submitLabel="Reset now" busy={reset.isPending}
          disabled={confirm.trim().toLowerCase() !== m.name.trim().toLowerCase() || reason.trim().length < 10} onSubmit={() => reset.mutate()}
          description={`${SCOPES[scope].title}: ${SCOPES[scope].removes}`}>
          <Field label={`Type the store name (${m.name}) to confirm`} required>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" placeholder={m.name} />
          </Field>
          <Field label="Why" required hint="At least 10 characters; kept in the platform log and the store's audit log">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Test orders before going live" />
          </Field>
          {reset.error && <p className="text-sm text-red-500" role="alert">{(reset.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
        </FormDialog>
      )}
    </div>
  )
}

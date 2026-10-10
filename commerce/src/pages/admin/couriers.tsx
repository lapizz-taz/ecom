import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Copy, KeyRound, Pencil, Plug, PlugZap, Plus, RefreshCw, Settings2, Unplug, Wallet, Webhook } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { CourierPerformance } from '@/features/couriers/courier-performance'
import { CourierStatements } from '@/features/couriers/courier-statements'
import { CourierWebhookLog, WebhookSetupDialog } from '@/features/couriers/courier-webhooks'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { SHIPMENT_STATUS } from '@/lib/status'
import {
  codReceivable, connectCourier, courierConfig, type CourierOptions, type CourierProviderCode, type CourierRow, courierStores,
  courierWebhookUrl, disconnectCourier, listCouriers, listShipments, type PathaoStore, saveCourier, saveCourierOptions,
  settleCod, type ShipmentRow, syncAllShipments, syncShipment, testCourierConnection,
} from '@/services/couriers'
import type { CodReceivableItem } from '@/types/domain'

const PROVIDERS = [
  { value: 'manual', label: 'Manual (no API)' },
  { value: 'steadfast', label: 'Steadfast (API)' },
  { value: 'pathao', label: 'Pathao (API)' },
  { value: 'redx', label: 'RedX (API)' },
]

interface CredentialField { key: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean; login?: boolean }
const LOGIN_FIELDS: CredentialField[] = [
  { key: 'panel_email', label: 'Account email', placeholder: 'you@shop.com', optional: true, login: true },
  { key: 'panel_password', label: 'Account password', secret: true, optional: true, login: true },
]
const INTEGRATIONS: Array<{ code: CourierProviderCode; name: string; color: string; blurb: string; where: string; sandbox?: boolean; fields: CredentialField[] }> = [
  {
    code: 'steadfast', name: 'Steadfast', color: 'bg-[#00b795] text-white', blurb: 'Book parcels, print tracking on labels, live status updates.',
    where: 'Steadfast portal → Settings → API', fields: [
      { key: 'api_key', label: 'API key' }, { key: 'secret_key', label: 'Secret key', secret: true }, ...LOGIN_FIELDS,
    ],
  },
  {
    code: 'pathao', name: 'Pathao', color: 'bg-[#e1252e] text-white', blurb: 'Merchant API — city and zone are matched from the order address.',
    where: 'Pathao merchant panel → Developers API', sandbox: true, fields: [
      { key: 'client_id', label: 'Client ID' }, { key: 'client_secret', label: 'Client secret', secret: true },
      { key: 'username', label: 'Account email', placeholder: 'you@shop.com', login: true }, { key: 'password', label: 'Account password', secret: true, login: true },
    ],
  },
  {
    code: 'redx', name: 'RedX', color: 'bg-[#e8202a] text-white', blurb: 'Open API — delivery area is matched from the order address.',
    where: 'RedX merchant panel → Developer / API access', sandbox: true, fields: [
      { key: 'access_token', label: 'API access token', secret: true }, ...LOGIN_FIELDS,
    ],
  },
]

export default function CouriersPage() {
  const [state, update] = useUrlState({ tab: 'couriers' })
  return (
    <div className="space-y-4">
      <PageHeader title="Couriers" description="Courier accounts, parcel status updates, what each courier costs, and statements to check against your records." />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="couriers">Connections</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="shipments">Shipments</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="cod">COD receivable</TabsTrigger>
        </TabsList>
        <TabsContent value="performance"><CourierPerformance /></TabsContent>
        <TabsContent value="shipments"><Shipments /></TabsContent>
        <TabsContent value="statements"><CourierStatements /></TabsContent>
        <TabsContent value="webhooks"><CourierWebhookLog /></TabsContent>
        <TabsContent value="cod"><CodReceivable /></TabsContent>
        <TabsContent value="couriers"><CourierList /></TabsContent>
      </Tabs>
    </div>
  )
}

function Shipments() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'couriers', courier: '', status: '', q: '', page: '1' })
  const page = Number(state.page) || 1
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const shipments = useQuery({
    queryKey: ['shipments', state],
    placeholderData: keepPreviousData,
    queryFn: () => listShipments({ courierId: state.courier || undefined, status: state.status as never, q: state.q, page, pageSize: 25 }),
  })
  const sync = useMutation({
    mutationFn: async (id?: string) => { if (id) await syncShipment(id); else await syncAllShipments(state.courier || undefined) },
    onSuccess: () => { toast.success('Synced with courier'); void queryClient.invalidateQueries({ queryKey: ['shipments'] }) },
  })
  const columns: Column<ShipmentRow>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (s) => <Link to={`/admin/orders/${s.orders?.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{s.orders?.order_number}</Link> },
    { key: 'customer', header: 'Customer', cell: (s) => s.orders?.customer_name },
    { key: 'courier', header: 'Courier', cell: (s) => <span>{s.couriers?.name}<span className="block font-mono text-xs text-muted-foreground">{s.tracking_number ?? '—'}</span></span> },
    { key: 'status', header: 'Status', cell: (s) => <StatusBadge value={s.status} map={SHIPMENT_STATUS} /> },
    { key: 'cod', header: 'COD', align: 'right', cell: (s) => <Money value={s.cod_amount} /> },
    { key: 'cost', header: 'Charge', align: 'right', hideOnMobile: true, cell: (s) => <Money value={s.shipping_cost} muted /> },
    { key: 'date', header: 'Booked', hideOnMobile: true, cell: (s) => formatDate(s.created_at) },
    {
      key: 'sync', header: '', align: 'right',
      cell: (s) => s.couriers?.provider !== 'manual' && can('shipments.manage') ? (
        <Button size="icon-sm" variant="ghost" aria-label="Sync status" onClick={(e) => { e.stopPropagation(); sync.mutate(s.id) }}><RefreshCw /></Button>
      ) : null,
    },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Tracking number" />
        <Select value={state.courier || 'all'} onValueChange={(v) => update({ courier: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(SHIPMENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
        </Select>
        {can('shipments.manage') && <Button size="sm" variant="outline" className="ml-auto" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>{sync.isPending ? <Spinner /> : <RefreshCw />} Sync API couriers</Button>}
      </div>
      <DataTable columns={columns} rows={shipments.data?.items} rowKey={(s) => s.id} loading={shipments.isFetching} error={shipments.error}
        onRetry={() => shipments.refetch()} rowHref={(s) => `/admin/orders/${s.order_id}`} empty={<EmptyState title="No shipments" />}
        footer={<Pagination page={page} pageSize={25} total={shipments.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
    </div>
  )
}

function CodReceivable() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [courierId, setCourierId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const items = useQuery({ queryKey: ['cod-receivable', courierId], queryFn: () => codReceivable(courierId || undefined) })
  const total = (items.data ?? []).reduce((s, i) => s + Number(i.due), 0)
  const selectedTotal = (items.data ?? []).filter((i) => selected.has(i.shipment_id)).reduce((s, i) => s + Number(i.due), 0)
  const settle = useMutation({
    mutationFn: (reference: string) => settleCod([...selected], reference),
    onSuccess: (r) => {
      toast.success(`${r.settled} parcel(s) settled · ${formatMoney(r.amount)}`)
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['cod-receivable'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
  const columns: Column<CodReceivableItem>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (i) => <Link to={`/admin/orders/${i.order_id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{i.order_number}</Link> },
    { key: 'customer', header: 'Customer', cell: (i) => i.customer_name },
    { key: 'courier', header: 'Courier', cell: (i) => <span>{i.courier_name}<span className="block font-mono text-xs text-muted-foreground">{i.tracking_number}</span></span> },
    { key: 'delivered', header: 'Delivered', cell: (i) => formatDateTime(i.delivered_at) },
    { key: 'due', header: 'COD due', align: 'right', cell: (i) => <Money value={i.due} className="font-medium" /> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={courierId || 'all'} onValueChange={(v) => { setCourierId(v === 'all' ? '' : v); setSelected(new Set()) }}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">Outstanding: <strong className="text-foreground">{formatMoney(total)}</strong></span>
        {selected.size > 0 && can('payments.record') && (
          <Button size="sm" className="ml-auto" onClick={() => setConfirming(true)}><Wallet /> Mark {selected.size} paid out ({formatMoney(selectedTotal)})</Button>
        )}
      </div>
      <DataTable columns={columns} rows={items.data} rowKey={(i) => i.shipment_id} loading={items.isLoading} error={items.error}
        selected={can('payments.record') ? selected : undefined} onSelectedChange={setSelected}
        empty={<EmptyState title="Nothing outstanding" description="Delivered parcels whose cash hasn't been paid out by the courier appear here." />} />
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Record courier payout"
        description={`Records ${formatMoney(selectedTotal)} of COD as received for ${selected.size} order(s).`} reason reasonLabel="Payout reference (optional)"
        confirmLabel="Record payout" onConfirm={(ref) => settle.mutateAsync(ref)} />
    </div>
  )
}

function CourierList() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const [editing, setEditing] = useState<Partial<CourierRow> | null>(null)
  const save = useMutation({
    mutationFn: () => saveCourier({
      id: editing?.id, name: editing?.name ?? '', provider: editing?.provider ?? 'manual', api_enabled: editing?.api_enabled ?? false,
      tracking_url_template: editing?.tracking_url_template || null, phone: editing?.phone || null, notes: editing?.notes || null,
      default_shipping_cost: editing?.default_shipping_cost ?? null, is_active: editing?.is_active ?? true,
      config: editing?.config ?? {},
    }),
    onSuccess: () => { toast.success('Courier saved'); setEditing(null); void queryClient.invalidateQueries({ queryKey: ['couriers'] }) },
  })
  const test = useMutation({
    mutationFn: testCourierConnection,
    onSuccess: (r) => { (r.ok ? toast.success : toast.error)(r.message); void queryClient.invalidateQueries({ queryKey: ['couriers'] }) },
  })
  const [connecting, setConnecting] = useState<(typeof INTEGRATIONS)[number] | null>(null)
  const [webhookFor, setWebhookFor] = useState<{ courier: CourierRow; provider: 'pathao' | 'steadfast' } | null>(null)
  const [disconnecting, setDisconnecting] = useState<CourierRow | null>(null)
  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectCourier(id),
    onSuccess: () => { toast.success('Courier disconnected — its API keys were wiped'); void queryClient.invalidateQueries({ queryKey: ['couriers'] }) },
  })
  return (
    <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-3">
      {INTEGRATIONS.map((integration) => {
        const row = (couriers.data ?? []).find((c) => c.provider === integration.code && c.api_enabled)
          ?? (couriers.data ?? []).find((c) => c.provider === integration.code)
          ?? (couriers.data ?? []).find((c) => c.name.trim().toLowerCase() === integration.name.toLowerCase())
        const connected = !!row?.api_enabled && row.api_status !== 'NOT_CONFIGURED'
        const hint = (row?.config as { credential_hint?: string } | null)?.credential_hint
        return (
          <Card key={integration.code} className="gap-3 p-5">
            <div className="flex items-center gap-3">
              <span className={`flex size-10 items-center justify-center rounded-xl text-sm font-bold ${integration.color}`}>{integration.name[0]}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{integration.name}</p>
                {connected
                  ? <p className="flex items-center gap-1 text-xs text-emerald-700"><CircleCheck className="size-3.5" /> Connected{hint ? ` · key ${hint}` : ''}</p>
                  : <p className="text-xs text-muted-foreground">Not connected</p>}
              </div>
              {connected && row.api_status === 'ERROR' && <Badge variant="danger">Error</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{integration.blurb}</p>
            {can('couriers.manage') && (
              <div className="mt-auto flex flex-wrap gap-2">
                <Button size="sm" variant={connected ? 'outline' : 'default'} className="rounded-full" onClick={() => setConnecting(integration)}>
                  {connected ? <Settings2 /> : <PlugZap />} {connected ? 'Settings' : 'Connect'}
                </Button>
                {connected && row && (
                  <>
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => test.mutate(row.id)} disabled={test.isPending}><Plug /> Test</Button>
                    <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setDisconnecting(row)}><Unplug /> Disconnect</Button>
                  </>
                )}
                {row && (integration.code === 'pathao' || integration.code === 'steadfast') && (
                  <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setWebhookFor({ courier: row, provider: integration.code as 'pathao' | 'steadfast' })}>
                    <Webhook /> Webhook{(row.config as { webhook_secret_hint?: string } | null)?.webhook_secret_hint ? ' ✓' : ''}
                  </Button>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
    <ConnectCourierDialog integration={connecting} existing={connecting ? (couriers.data ?? []).find((c) => c.provider === connecting.code)
      ?? (couriers.data ?? []).find((c) => c.name.trim().toLowerCase() === connecting.name.toLowerCase()) : undefined}
      onClose={() => setConnecting(null)} onConnected={() => void queryClient.invalidateQueries({ queryKey: ['couriers'] })}
      onWebhook={(c) => { const p = connecting?.code as 'pathao' | 'steadfast'; setConnecting(null); setWebhookFor({ courier: c, provider: p }) }} />
    {webhookFor && <WebhookSetupDialog courier={webhookFor.courier} provider={webhookFor.provider} onClose={() => setWebhookFor(null)}
      onSaved={() => void queryClient.invalidateQueries({ queryKey: ['couriers'] })} />}
    <ConfirmDialog open={disconnecting !== null} onOpenChange={(o) => !o && setDisconnecting(null)} destructive
      title={`Disconnect ${disconnecting?.name}?`} description="The saved API keys are wiped. Booking and status sync stop until you connect again; existing shipments are kept."
      confirmLabel="Disconnect" onConfirm={() => disconnect.mutateAsync(disconnecting!.id)} />
    <Card>
      <CardContent className="space-y-3">
        {can('couriers.manage') && <Button size="sm" onClick={() => setEditing({ provider: 'manual', is_active: true })}><Plus /> Add courier</Button>}
        <ul className="divide-y">
          {(couriers.data ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="flex items-center gap-2 font-medium">{c.name}
                  {!c.is_active && <Badge variant="neutral">inactive</Badge>}
                  {c.api_enabled && <Badge variant={c.api_status === 'CONNECTED' ? 'success' : c.api_status === 'ERROR' ? 'danger' : 'neutral'}>API {c.api_status.toLowerCase().replace('_', ' ')}</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">{PROVIDERS.find((p) => p.value === c.provider)?.label ?? c.provider}{c.phone ? ` · ${c.phone}` : ''}{c.default_shipping_cost != null ? ` · default charge ${formatMoney(c.default_shipping_cost)}` : ''}</p>
              </div>
              {can('couriers.manage') && (
                <div className="flex gap-1">
                  {c.api_enabled && <Button size="sm" variant="outline" onClick={() => test.mutate(c.id)} disabled={test.isPending}><Plug /> Test API</Button>}
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Edit courier' : 'New courier'}</DialogTitle>
            <DialogDescription>API keys are added with Connect above and kept encrypted on the server — never in this form.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="cr-name" required><Input id="cr-name" value={editing?.name ?? ''} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} /></Field>
            <Field label="Integration">
              <Select value={editing?.provider ?? 'manual'} onValueChange={(v) => setEditing((c) => ({ ...c, provider: v, api_enabled: v !== 'manual' && (c?.api_enabled ?? false) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Tracking URL" htmlFor="cr-url" hint="Use {tracking} as placeholder" className="sm:col-span-2">
              <Input id="cr-url" value={editing?.tracking_url_template ?? ''} onChange={(e) => setEditing((c) => ({ ...c, tracking_url_template: e.target.value }))} placeholder="https://courier.example/track/{tracking}" />
            </Field>
            <Field label="Phone" htmlFor="cr-phone"><Input id="cr-phone" value={editing?.phone ?? ''} onChange={(e) => setEditing((c) => ({ ...c, phone: e.target.value }))} /></Field>
            <Field label="Default charge" htmlFor="cr-cost"><Input id="cr-cost" type="number" min={0} value={editing?.default_shipping_cost ?? ''} onChange={(e) => setEditing((c) => ({ ...c, default_shipping_cost: e.target.value === '' ? null : Number(e.target.value) }))} /></Field>
            <Field label="COD fee (%)" htmlFor="cr-codfee" hint="Of the cash collected, e.g. 1 for Pathao. Used until a statement shows the real fee.">
              <Input id="cr-codfee" type="number" min={0} max={10} step="0.1"
                value={(editing?.config as { cod_fee_percent?: number } | null)?.cod_fee_percent ?? ''}
                onChange={(e) => setEditing((c) => {
                  const config = { ...((c?.config as Record<string, unknown> | null) ?? {}) }
                  if (e.target.value === '') delete config.cod_fee_percent
                  else config.cod_fee_percent = Number(e.target.value)
                  return { ...c, config: config as CourierRow['config'] }
                })} />
            </Field>
            <Field label="Notes" htmlFor="cr-notes" className="sm:col-span-2"><Textarea id="cr-notes" rows={2} value={editing?.notes ?? ''} onChange={(e) => setEditing((c) => ({ ...c, notes: e.target.value }))} /></Field>
            {editing?.provider !== 'manual' && <label className="flex items-center gap-2 text-sm"><Switch checked={editing?.api_enabled ?? false} onCheckedChange={(v) => setEditing((c) => ({ ...c, api_enabled: v }))} /> Use API</label>}
            <label className="flex items-center gap-2 text-sm"><Switch checked={editing?.is_active ?? true} onCheckedChange={(v) => setEditing((c) => ({ ...c, is_active: v }))} /> Active</label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!editing?.name || save.isPending}>{save.isPending && <Spinner />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
    </div>
  )
}

/**
 * The courier's settings in one form: keys (tested, then stored encrypted on the
 * server and never shown again), pickup store, how parcels are sent, webhook and
 * whether the courier is active. Options can be changed later without re-entering keys.
 */
function ConnectCourierDialog({ integration, existing, onClose, onConnected, onWebhook }: {
  integration: (typeof INTEGRATIONS)[number] | null
  existing: CourierRow | undefined
  onClose: () => void
  onConnected: () => void
  onWebhook: (courier: CourierRow) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [sandbox, setSandbox] = useState(false)
  const [name, setName] = useState('')
  const [opts, setOpts] = useState<CourierOptions>({})
  const [active, setActive] = useState(true)
  const [stores, setStores] = useState<PathaoStore[]>([])
  const [checked, setChecked] = useState<{ ok: boolean; message: string } | null>(null)
  const [manualStore, setManualStore] = useState(false)
  const code = integration?.code
  const hasStores = code === 'pathao' || code === 'redx'
  const connected = !!existing?.api_enabled && existing.api_status !== 'NOT_CONFIGURED'

  useEffect(() => {
    if (!integration) return
    const cfg = courierConfig(existing)
    setValues({}); setName(''); setChecked(null); setSandbox(false)
    setOpts({
      account_phone: cfg.account_phone ?? '', store_id: cfg.store_id ?? '', item_type: cfg.item_type ?? 2,
      allow_without_zone: cfg.allow_without_zone ?? false, send_weight: cfg.send_weight ?? true,
      default_note: cfg.default_note ?? '', send_product_names: cfg.send_product_names ?? false,
    })
    setStores(cfg.stores ?? []); setManualStore(false)
    setActive(existing?.is_active ?? true)
  }, [integration]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof CourierOptions>(k: K, v: CourierOptions[K]) => setOpts((o) => ({ ...o, [k]: v }))
  const filled = (k: string) => !!values[k]?.trim()
  const keysEntered = integration?.fields.some((f) => filled(f.key)) ?? false
  const loginFields = integration?.fields.filter((f) => f.optional) ?? []
  const keysIncomplete = integration?.fields.some((f) => !f.optional && !filled(f.key))
    || (loginFields.some((f) => filled(f.key)) && loginFields.some((f) => !filled(f.key)))
  // Keys are needed to connect; a saved connection can change its options alone.
  const blocked = (connected ? keysEntered && keysIncomplete : keysIncomplete) || (code === 'pathao' && !opts.store_id)
  const trimmed = () => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
  const options = (): CourierOptions => {
    const o: CourierOptions = { default_note: opts.default_note?.trim() ?? '', send_product_names: !!opts.send_product_names }
    if (code === 'pathao') Object.assign(o, {
      account_phone: opts.account_phone?.trim() ?? '', store_id: opts.store_id ?? '', item_type: opts.item_type ?? 2,
      allow_without_zone: !!opts.allow_without_zone, send_weight: opts.send_weight !== false,
    })
    if (code === 'redx') Object.assign(o, { store_id: opts.store_id ?? '', allow_without_zone: !!opts.allow_without_zone })
    return o
  }

  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (!keysEntered && existing) {
        await saveCourierOptions(existing.id, options(), active)
        return { message: `${existing.name} settings saved` }
      }
      return connectCourier({
        courier_id: existing?.id, provider: integration!.code, name: existing ? undefined : name.trim() || integration!.name,
        credentials: { ...trimmed(), ...(integration!.sandbox ? { sandbox } : {}) }, options: options(), is_active: active,
      })
    },
    onSuccess: (r) => { toast.success(r.message); setValues({}); onConnected(); onClose() },
  })
  const test = useMutation({
    meta: { silent: true },
    mutationFn: async (): Promise<{ ok: boolean; message: string; stores?: PathaoStore[] }> => {
      if (hasStores && (keysEntered || existing)) {
        const r = await courierStores(keysEntered
          ? { provider: code, credentials: { ...trimmed(), ...(sandbox ? { sandbox: 'true' } : {}) } }
          : { provider: code, courier_id: existing!.id })
        return { ok: true, message: `${code === 'redx' ? 'RedX token works' : 'Signed in to Pathao'} · ${r.stores.length} pickup store${r.stores.length === 1 ? '' : 's'} found`, stores: r.stores }
      }
      if (existing && !keysEntered) return testCourierConnection(existing.id)
      return { ok: true, message: 'The keys are tested with the courier when you save.' }
    },
    onSuccess: (r) => {
      setChecked(r)
      if (r.stores) {
        setStores(r.stores)
        if (!opts.store_id && r.stores.length) set('store_id', (r.stores.find((s) => s.active) ?? r.stores[0]).id)
      }
    },
    onError: (e) => setChecked({ ok: false, message: e.message }),
  })
  const toggle = (label: string, hint: string, on: boolean, change: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
      <Switch checked={on} onCheckedChange={change} />
    </label>
  )
  const section = (title: string) => <p className="pt-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</p>
  const webhookUrl = existing && (code === 'pathao' || code === 'steadfast') ? `${courierWebhookUrl(existing.id)}&provider=${code}` : null

  return (
    <Dialog open={integration !== null} onOpenChange={(o) => { if (!o) { save.reset(); test.reset(); setValues({}); onClose() } }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{connected ? `${integration?.name} settings` : `Connect ${integration?.name}`}</DialogTitle>
          <DialogDescription>
            Keys are in: {integration?.where}. They are tested with {integration?.name}, then stored encrypted on the server and never shown again.
            {connected && ' Leave the key fields empty to keep the saved ones.'}
          </DialogDescription>
        </DialogHeader>
        <form id="connect-courier" className="grid gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          {section('Account')}
          <div className="grid gap-3 sm:grid-cols-2">
            {!existing && (
              <Field label="Name in your admin" htmlFor="cc-name"><Input id="cc-name" value={name} placeholder={integration?.name} onChange={(e) => setName(e.target.value)} /></Field>
            )}
            {code === 'pathao' && (
              <Field label="Account mobile number" htmlFor="cc-phone">
                <Input id="cc-phone" inputMode="tel" value={opts.account_phone ?? ''} placeholder="01XXXXXXXXX" onChange={(e) => set('account_phone', e.target.value)} />
              </Field>
            )}
            {integration?.fields.filter((f) => !f.login).map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`cc-${f.key}`} required={!connected}>
                <Input id={`cc-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete="off"
                  placeholder={connected ? 'Saved — enter to replace' : f.placeholder}
                  value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          {integration?.fields.some((f) => f.login) && (
            <div className="grid gap-3 rounded-lg border p-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium"><KeyRound className="size-4" /> {integration.name} account login{integration.fields.some((f) => f.login && f.optional) && <span className="font-normal text-muted-foreground">· optional</span>}</p>
                <p className="text-xs text-muted-foreground">
                  {code === 'pathao'
                    ? 'The email and password of your Pathao merchant account — Pathao needs them to issue API access.'
                    : `The email and password you use on the ${integration.name} merchant panel. Fill both or leave both empty.`}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {integration.fields.filter((f) => f.login).map((f) => (
                  <Field key={f.key} label={f.label} htmlFor={`cc-${f.key}`} required={!f.optional && !connected}>
                    <Input id={`cc-${f.key}`} type={f.secret ? 'password' : 'email'} autoComplete={f.secret ? 'new-password' : 'off'}
                      placeholder={connected ? 'Saved — enter to replace' : f.placeholder}
                      value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                  </Field>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {integration?.sandbox && <label className="flex items-center gap-2 text-sm"><Switch checked={sandbox} onCheckedChange={setSandbox} /> Sandbox / test account</label>}
            {(hasStores ? (keysEntered && !keysIncomplete) || connected : connected && !keysEntered) && (
              <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => test.mutate()} disabled={test.isPending}>
                {test.isPending ? <Spinner /> : <Plug />} {code === 'redx' ? 'Test token' : 'Test connection'}
              </Button>
            )}
          </div>
          {checked && <p className={`rounded-lg p-2.5 text-sm ${checked.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`} role="status">{checked.message}</p>}

          {hasStores && (
            <>
              {section('Pickup store')}
              <div className="flex flex-wrap items-end gap-2">
                <Field label={code === 'redx' ? 'Pickup store (optional)' : 'Default store'} className="min-w-56 flex-1"
                  hint={code === 'redx' && !opts.store_id ? 'Empty: RedX uses your account’s default pickup store.' : stores.length > 1 ? 'You can pick another store when uploading parcels.' : undefined}>
                  {stores.length && !manualStore ? (
                    <Select value={opts.store_id || undefined} onValueChange={(v) => { if (v) set('store_id', v) }}>
                      <SelectTrigger className="w-full"><SelectValue placeholder="Choose a store" /></SelectTrigger>
                      <SelectContent>{stores.map((st) => <SelectItem key={st.id} value={st.id}>{st.name} · {st.id}{st.active ? '' : ' (inactive)'}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Input value={opts.store_id ?? ''} inputMode="numeric" placeholder="Sync stores, or type the store ID" onChange={(e) => set('store_id', e.target.value.replace(/\D/g, ''))} />
                  )}
                </Field>
                <Button type="button" variant="outline" onClick={() => { setManualStore(false); test.mutate() }} disabled={test.isPending || (!connected && (!keysEntered || !!keysIncomplete))}>
                  {test.isPending ? <Spinner /> : <RefreshCw />} Fetch stores
                </Button>
                {stores.length > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setManualStore((m) => !m)}>{manualStore ? 'Pick from list' : 'Enter manually'}</Button>
                )}
              </div>
            </>
          )}
          {code === 'redx' && (
            <>
              {section('Parcels')}
              {toggle('Allow parcel creation without area', 'If the address can’t be matched to a RedX delivery area, book it with the district’s first area instead of stopping', !!opts.allow_without_zone, (v) => set('allow_without_zone', v))}
            </>
          )}
          {code === 'pathao' && (
            <>
              {section('Parcels')}
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Item type">
                  <Select value={String(opts.item_type ?? 2)} onValueChange={(v) => set('item_type', v === '1' ? 1 : 2)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="2">Parcel</SelectItem><SelectItem value="1">Document</SelectItem></SelectContent>
                  </Select>
                </Field>
                <div />
                {toggle('Allow order without zone', 'If the address can’t be matched to a Pathao zone, book it anyway and let Pathao read the address', !!opts.allow_without_zone, (v) => set('allow_without_zone', v))}
                {toggle('Send parcel weight', 'Total of the product weights; off sends Pathao’s minimum (0.5 kg)', opts.send_weight !== false, (v) => set('send_weight', v))}
              </div>
            </>
          )}

          {section('Shipping note')}
          <div className="grid gap-2">
            <Field label="Default shipping note" htmlFor="cc-note" hint="Sent with every parcel unless the order has its own note">
              <Textarea id="cc-note" rows={2} maxLength={200} value={opts.default_note ?? ''} placeholder="e.g. Call before delivery. Handle with care."
                onChange={(e) => set('default_note', e.target.value)} />
            </Field>
            {(code === 'pathao' || code === 'steadfast' || code === 'redx') && toggle('Send product names', code === 'redx' ? 'Adds “2× Canvas Tote, 1× Cap” to the parcel instruction the rider sees' : 'Adds “2× Canvas Tote, 1× Cap” as the item description', !!opts.send_product_names, (v) => set('send_product_names', v))}
          </div>

          {webhookUrl && existing && (
            <>
              {section('Webhook')}
              <div className="grid gap-2 rounded-lg border p-3">
                <Field label="Callback URL">
                  <div className="flex gap-2">
                    <Input readOnly value={webhookUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                    <Button type="button" variant="outline" size="icon" aria-label="Copy URL" onClick={() => void navigator.clipboard.writeText(webhookUrl).then(() => toast.success('URL copied'))}><Copy /></Button>
                  </div>
                </Field>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{courierConfig(existing).webhook_secret_hint ? `Secret saved (ends ${courierConfig(existing).webhook_secret_hint!.slice(-4)})` : 'No webhook secret yet — status updates can’t arrive until you set one.'}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => onWebhook(existing)}><Webhook /> {courierConfig(existing).webhook_secret_hint ? 'New secret' : 'Set secret'}</Button>
                </div>
              </div>
            </>
          )}

          {section('Status')}
          {toggle('Active', 'Inactive couriers are hidden when booking parcels; saved keys are kept', active, setActive)}
          {save.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{save.error.message}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="connect-courier" disabled={!!blocked || save.isPending}>
            {save.isPending ? <Spinner /> : <PlugZap />} {connected && !keysEntered ? 'Save settings' : 'Test & connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

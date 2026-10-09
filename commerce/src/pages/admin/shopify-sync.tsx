import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, DownloadCloud, ExternalLink, Link2, Play, RotateCw, Unlink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { searchVariants } from '@/services/catalog'
import {
  importCatalog, linkVariant, listChannels, type ReconcilePlan, reconcileStock, retrySyncJob, runSyncJobs, saveSyncSettings, type SyncItem,
  type SyncOverview, syncOverview,
} from '@/services/channels'

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  OK: { label: 'In step', tone: 'ok' }, PENDING: { label: 'Updating', tone: 'muted' }, MISMATCH: { label: 'Changed in Shopify', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'warn' }, NEW: { label: 'Not synced yet', tone: 'muted' }, UNTRACKED: { label: 'Not tracked in Shopify', tone: 'muted' },
}
const F_STATUS: Record<string, string> = {
  PENDING: 'Queued', NEEDS_TRACKING: 'Needs tracking', PROCESSING: 'Sending', FULFILLED: 'Fulfilled', FAILED: 'Failed', SKIPPED: 'Skipped',
}
const REASON: Record<string, string> = {
  NO_SKU: 'No SKU in Shopify', DUPLICATE_SKU_SHOPIFY: 'SKU used twice in Shopify', DUPLICATE_SKU_HERE: 'SKU used twice here', NO_MATCH: 'No product here with this SKU',
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
    tone === 'ok' ? 'bg-foreground text-background' : tone === 'warn' ? 'ring-1 ring-foreground/60 ring-inset' : 'bg-muted text-muted-foreground')}>{children}</span>
}

/** Shopify fulfilment and stock: settings, mapping, differences, jobs. */
export default function ShopifySyncPage() {
  const channels = useQuery({ queryKey: ['sales-channels'], queryFn: listChannels })
  const shops = (channels.data ?? []).filter((c) => c.platform === 'SHOPIFY' && c.status !== 'DISCONNECTED')
  const [state, update] = useUrlState({ channel: '', tab: 'stock' })
  const channelId = state.channel || shops[0]?.id || ''

  if (channels.isLoading) return <LoadingState />
  if (channels.error) return <ErrorState error={channels.error} onRetry={() => channels.refetch()} />
  if (!shops.length) {
    return (
      <div className="space-y-4">
        <PageHeader title="Shopify sync" description="Fulfil Shopify orders when they ship here, and keep Shopify's stock in step with yours." />
        <EmptyState title="No Shopify store connected" description="Connect your Shopify store first." action={<Button asChild size="sm"><Link to="/admin/channels">Sales channels</Link></Button>} />
      </div>
    )
  }
  return <SyncBody channelId={channelId} shops={shops} tab={state.tab} onTab={(tab) => update({ tab }, { resetPage: false })} onChannel={(channel) => update({ channel }, { resetPage: false })} />
}

function SyncBody({ channelId, shops, tab, onTab, onChannel }: {
  channelId: string; shops: Array<{ id: string; name: string }>; tab: string; onTab: (t: string) => void; onChannel: (id: string) => void
}) {
  const { can } = useAuth()
  const qc = useQueryClient()
  const overview = useQuery({ queryKey: ['shopify-sync', channelId], queryFn: () => syncOverview(channelId), refetchInterval: 15_000 })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['shopify-sync', channelId] })
  const catalog = useMutation({
    mutationFn: () => importCatalog(channelId),
    onSuccess: (r) => { toast.success(`${formatNumber(r.items)} Shopify variants read · ${r.linked} newly linked by SKU · ${r.mapped} linked in total`); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const run = useMutation({
    mutationFn: runSyncJobs,
    onSuccess: (r) => { toast.success(r.processed ? `${r.processed} sync job${r.processed === 1 ? '' : 's'} run` : 'Nothing waiting'); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })

  if (overview.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const o = overview.data!
  const diffs = o.items.filter((i) => i.difference !== null && i.difference !== 0 && i.status !== 'UNTRACKED')
  const missingScopes = ['write_inventory', 'read_locations', 'write_merchant_managed_fulfillment_orders'].filter((s) => !o.channel.scopes.includes(s))

  return (
    <div className="space-y-4">
      <PageHeader title="Shopify sync" description="Shipped orders are fulfilled on Shopify with the courier's tracking link; your stock is the source of truth for Shopify's."
        actions={<>
          {shops.length > 1 && (
            <Select value={channelId} onValueChange={onChannel}>
              <SelectTrigger size="sm" className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {can('inventory.view') && <Button size="sm" variant="outline" onClick={() => catalog.mutate()} disabled={catalog.isPending}>{catalog.isPending ? <Spinner /> : <DownloadCloud />} Read Shopify catalog</Button>}
          {can('orders.update') && <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? <Spinner /> : <Play />} Run sync now</Button>}
        </>} />

      {missingScopes.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-foreground/40 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0" />
          The app is missing {missingScopes.join(', ')}. Add them to the Shopify app's access scopes, release a new version, then click Connect again on Sales channels.</p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Linked variants" value={formatNumber(o.items.length)} hint={o.channel.catalog_imported_at ? `Catalog read ${timeAgo(o.channel.catalog_imported_at)}` : 'Read the catalog first'} />
        <StatCard label="In step" value={formatNumber(o.items.filter((i) => i.status === 'OK').length)} />
        <StatCard label="Differences" value={formatNumber(diffs.length)} hint="Review under Stock" />
        <StatCard label="Not linked" value={formatNumber(o.unmapped.length)} />
        <StatCard label="Sync jobs" value={`${o.jobs.pending} waiting`} hint={o.jobs.failed ? `${o.jobs.failed} failed` : 'None failed'} />
      </div>

      <SettingsCard o={o} channelId={channelId} onSaved={refresh} />

      <Tabs value={tab} onValueChange={onTab}>
        <TabsList>
          <TabsTrigger value="stock">Stock{diffs.length ? ` · ${diffs.length}` : ''}</TabsTrigger>
          <TabsTrigger value="unmapped">Not linked{o.unmapped.length ? ` · ${o.unmapped.length}` : ''}</TabsTrigger>
          <TabsTrigger value="fulfilments">Fulfilments</TabsTrigger>
          <TabsTrigger value="jobs">Jobs{o.jobs.failed ? ` · ${o.jobs.failed} failed` : ''}</TabsTrigger>
        </TabsList>
        <TabsContent value="stock" className="animate-in fade-in-0"><StockTab o={o} channelId={channelId} onDone={refresh} /></TabsContent>
        <TabsContent value="unmapped" className="animate-in fade-in-0"><UnmappedTab o={o} channelId={channelId} onDone={refresh} /></TabsContent>
        <TabsContent value="fulfilments" className="animate-in fade-in-0"><FulfilmentsTab o={o} /></TabsContent>
        <TabsContent value="jobs" className="animate-in fade-in-0"><JobsTab o={o} onDone={refresh} /></TabsContent>
      </Tabs>
    </div>
  )
}

function SettingsCard({ o, channelId, onSaved }: { o: SyncOverview; channelId: string; onSaved: () => void }) {
  const { can } = useAuth()
  const [s, setS] = useState(o.channel.settings)
  useEffect(() => setS(o.channel.settings), [o.channel.settings])
  const dirty = JSON.stringify(s) !== JSON.stringify(o.channel.settings)
  const save = useMutation({
    mutationFn: () => saveSyncSettings(channelId, s),
    onSuccess: () => { toast.success('Saved'); onSaved() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const edit = can('settings.manage')
  const row = (label: string, hint: string, key: 'fulfill_on_ship' | 'notify_customer' | 'fulfill_without_tracking' | 'inventory_sync') => (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
      <Switch checked={s[key]} disabled={!edit} onCheckedChange={(v) => setS((x) => ({ ...x, [key]: v }))} />
    </label>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
        <CardDescription>Web Orders, approval and Ready to ship never touch Shopify. Only Shipped does.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Fulfilment</p>
          {row('Fulfil on Shopify when shipped', 'Creates the fulfilment with courier, tracking number and tracking link', 'fulfill_on_ship')}
          {row("Send Shopify's shipping e-mail", 'Shopify e-mails the customer the tracking link (when the order has an e-mail)', 'notify_customer')}
          {row('Allow fulfilment without tracking', 'Off: an order without a tracking number waits until one is added', 'fulfill_without_tracking')}
        </div>
        <div className="grid content-start gap-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Stock</p>
          {row('Keep Shopify stock in step', 'Your available stock (on hand − reserved) is set on Shopify after every change', 'inventory_sync')}
          <Field label="Shopify location">
            <Select value={s.location_id ?? ''} onValueChange={(v) => { if (v) setS((x) => ({ ...x, location_id: v })) }} disabled={!edit || !o.channel.locations.length}>
              <SelectTrigger className="w-full"><SelectValue placeholder={o.channel.locations.length ? 'Choose a location' : 'Read the catalog to load locations'} /></SelectTrigger>
              <SelectContent>{o.channel.locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}{l.active ? '' : ' (inactive)'}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="When stock is changed by hand in Shopify">
            <Select value={s.external_changes} onValueChange={(v) => setS((x) => ({ ...x, external_changes: v as 'FLAG' | 'SAAS_WINS' }))} disabled={!edit}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="FLAG">Flag it for me to review (recommended)</SelectItem>
                <SelectItem value="SAAS_WINS">This app wins — set Shopify back to my stock</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {edit && (
          <div className="flex gap-2 lg:col-span-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Check />} Save</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setS(o.channel.settings)}>Cancel</Button>}
            {s.inventory_sync && !o.channel.settings.inventory_sync && (
              <p className="self-center text-xs text-muted-foreground">Turning it on takes today's Shopify numbers as the starting point — nothing is overwritten until you review the differences.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StockTab({ o, channelId, onDone }: { o: SyncOverview; channelId: string; onDone: () => void }) {
  const { can } = useAuth()
  const [only, setOnly] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<{ action: 'PUSH' | 'ADOPT'; result: ReconcilePlan } | null>(null)
  const rows = useMemo(() => (only ? o.items.filter((i) => i.difference !== 0 && i.status !== 'UNTRACKED') : o.items), [o.items, only])
  const preview = useMutation({
    mutationFn: (action: 'PUSH' | 'ADOPT') => reconcileStock(channelId, [...sel].map((variant_id) => ({ variant_id, action })), false).then((result) => ({ action, result })),
    onSuccess: setPlan,
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const apply = useMutation({
    mutationFn: () => reconcileStock(channelId, plan!.result.plan.map((p) => ({ variant_id: p.variant_id, action: p.action })), true),
    onSuccess: (r) => {
      toast.success(plan!.action === 'PUSH' ? `${r.plan.length} item(s) will be set on Shopify` : `${r.plan.length} item(s) corrected here (recorded as stock corrections)`)
      setPlan(null); setSel(new Set()); onDone(); void runSyncJobs().then(onDone).catch(() => undefined)
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.variant_id))
  if (!o.items.length) return <EmptyState title="No variants linked yet" description="Click “Read Shopify catalog”: variants are linked to yours by SKU, and the rest are listed under Not linked." />
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="flex items-center gap-2 text-sm"><Switch checked={only} onCheckedChange={setOnly} /> Only differences</label>
        {sel.size > 0 && can('inventory.adjust') && (
          <div className="ml-auto flex flex-wrap gap-2 animate-in fade-in-0">
            <Button size="sm" variant="outline" onClick={() => preview.mutate('PUSH')} disabled={preview.isPending}><ArrowUpFromLine /> Set Shopify to mine ({sel.size})</Button>
            <Button size="sm" variant="outline" onClick={() => preview.mutate('ADOPT')} disabled={preview.isPending}><ArrowDownToLine /> Use Shopify's number ({sel.size})</Button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="w-8 px-3 py-2"><Checkbox checked={allOn} onCheckedChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.variant_id)))} aria-label="Select all" /></th>
            <th className="px-3 py-2">Product</th><th className="px-3 py-2">SKU</th>
            <th className="px-3 py-2 text-right">On hand</th><th className="px-3 py-2 text-right">Reserved</th><th className="px-3 py-2 text-right">Available here</th>
            <th className="px-3 py-2 text-right">Shopify</th><th className="px-3 py-2">Status</th>
          </tr></thead>
          <tbody>
            {rows.map((r: SyncItem) => (
              <tr key={r.variant_id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2"><Checkbox checked={sel.has(r.variant_id)} onCheckedChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.variant_id)) n.delete(r.variant_id); else n.add(r.variant_id); return n })} aria-label="Select" /></td>
                <td className="px-3 py-2"><span className="font-medium">{r.product}</span>{r.variant !== 'Default' && <span className="text-muted-foreground"> · {r.variant}</span>}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.sku}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.on_hand}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.reserved}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{r.available}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', r.difference ? 'font-semibold underline decoration-foreground/40' : '')}>{r.shopify ?? '—'}</td>
                <td className="px-3 py-2"><Pill tone={STATUS[r.status]?.tone ?? 'muted'}>{STATUS[r.status]?.label ?? r.status}</Pill>
                  {r.error && <span className="block max-w-64 truncate text-[11px] text-muted-foreground" title={r.error}>{r.error}</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">Everything is in step.</td></tr>}
          </tbody>
        </table>
      </div>
      <Dialog open={!!plan} onOpenChange={(v) => !v && setPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{plan?.action === 'PUSH' ? 'Set Shopify to your stock' : "Use Shopify's numbers here"}</DialogTitle>
            <DialogDescription>Preview — nothing has changed yet. {plan?.action === 'ADOPT' ? 'Each change is recorded as a stock correction in the movement history.' : 'Shopify is updated by the sync job right after.'}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
            {plan?.result.plan.map((p) => (
              <li key={p.variant_id} className="flex justify-between gap-3 px-3 py-2">
                <span className="font-mono text-xs">{p.sku}</span>
                <span className="tabular-nums">{plan.action === 'PUSH' ? 'Shopify' : 'Here'}: {p.from ?? '—'} → <strong>{p.to}</strong></span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>Cancel</Button>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending || !plan?.result.plan.length}>{apply.isPending && <Spinner />} Apply {plan?.result.plan.length ?? 0}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function VariantPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const found = useQuery({ queryKey: ['variant-search', q], queryFn: () => searchVariants(q, 8), enabled: open })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="sm" variant="outline"><Link2 /> Link</Button></PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="end">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search our products or SKU" className="h-8" />
        <ul className="mt-2 max-h-64 overflow-y-auto text-sm">
          {(found.data ?? []).map((v) => (
            <li key={v.variant_id}>
              <button type="button" className="w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { onPick(v.variant_id!); setOpen(false) }}>
                <span className="block truncate">{v.product_name}{v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{v.sku} · {v.available ?? 0} available</span>
              </button>
            </li>
          ))}
          {found.data && !found.data.length && <li className="px-2 py-2 text-xs text-muted-foreground">No match</li>}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function UnmappedTab({ o, channelId, onDone }: { o: SyncOverview; channelId: string; onDone: () => void }) {
  const { can } = useAuth()
  const link = useMutation({
    mutationFn: ({ ext, variant }: { ext: string; variant: string | null }) => linkVariant(channelId, ext, variant),
    onSuccess: () => { toast.success('Linked'); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!o.unmapped.length) return <EmptyState title="Every Shopify variant is linked" description="New products in Shopify appear here after the next catalog read." />
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">
        {o.unmapped.map((u) => (
          <li key={u.external_variant_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{u.title}</p>
              <p className="text-xs text-muted-foreground"><span className="font-mono">{u.sku ?? 'no SKU'}</span> · {REASON[u.reason]}{u.available !== null ? ` · ${u.available} in Shopify` : ''}</p>
            </div>
            {can('inventory.adjust') && <VariantPicker onPick={(variant) => link.mutate({ ext: u.external_variant_id, variant })} />}
          </li>
        ))}
      </ul>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">Tip: give each product the same SKU here and in Shopify — they link by themselves on the next catalog read. <Unlink className="inline size-3" /> Linking never changes either side's stock.</p>
    </Card>
  )
}

function FulfilmentsTab({ o }: { o: SyncOverview }) {
  if (!o.fulfillments.length) return <EmptyState title="No fulfilments yet" description="When a Shopify order is marked Shipped here, it shows up here." />
  return (
    <Card className="gap-0 py-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2">Order</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Courier · tracking</th><th className="px-3 py-2">Customer e-mail</th><th className="px-3 py-2">When</th>
          </tr></thead>
          <tbody>
            {o.fulfillments.map((f) => (
              <tr key={`${f.order_id}-${f.created_at}`} className="border-b last:border-0">
                <td className="px-3 py-2"><Link to={`/admin/orders/${f.order_id}`} className="font-medium hover:underline">{f.order_number}</Link>{f.source === 'SHOPIFY' && <span className="block text-[11px] text-muted-foreground">made in Shopify</span>}</td>
                <td className="px-3 py-2"><Pill tone={f.status === 'FULFILLED' ? 'ok' : f.status === 'FAILED' || f.status === 'NEEDS_TRACKING' ? 'warn' : 'muted'}>{F_STATUS[f.status] ?? f.status}</Pill>
                  {f.last_error && <span className="block max-w-64 truncate text-[11px] text-muted-foreground" title={f.last_error}>{f.last_error}</span>}</td>
                <td className="px-3 py-2 text-xs">{f.courier ?? '—'} {f.tracking_url ? <a href={f.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono underline">{f.tracking_number}<ExternalLink className="size-3" /></a> : <span className="font-mono">{f.tracking_number}</span>}</td>
                <td className="px-3 py-2 text-xs">{f.notification_status === 'REQUESTED' ? 'Requested from Shopify' : f.notification_status === 'NO_EMAIL' ? 'No e-mail on order' : f.notification_status === 'DISABLED' ? 'Turned off' : '—'}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(f.fulfilled_at ?? f.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function JobsTab({ o, onDone }: { o: SyncOverview; onDone: () => void }) {
  const { can } = useAuth()
  const retry = useMutation({
    mutationFn: async (id: string) => { await retrySyncJob(id); await runSyncJobs() },
    onSuccess: () => { toast.success('Retried'); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!o.recent_jobs.length) return <EmptyState title="No sync jobs yet" />
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y text-sm">
        {o.recent_jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="w-20 text-xs text-muted-foreground">{j.kind === 'FULFILL' ? 'Fulfilment' : 'Stock'}</span>
            <span className="min-w-0 flex-1 truncate">
              {j.kind === 'FULFILL' ? <Link to={`/admin/orders/${j.ref_id}`} className="font-medium hover:underline">{j.label}</Link> : <span className="font-mono text-xs">{j.label}</span>}
              {j.last_error && <span className="block truncate text-xs text-muted-foreground" title={j.last_error}>{j.last_error}</span>}
            </span>
            <Pill tone={j.status === 'DONE' ? 'ok' : j.status === 'FAILED' ? 'warn' : 'muted'}>{j.status.toLowerCase()}{j.attempts > 1 ? ` · ${j.attempts} tries` : ''}</Pill>
            <span className="w-24 text-right text-xs text-muted-foreground">{timeAgo(j.updated_at)}</span>
            {j.status === 'FAILED' && can('settings.manage') && <Button size="sm" variant="outline" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}><RotateCw /> Retry</Button>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

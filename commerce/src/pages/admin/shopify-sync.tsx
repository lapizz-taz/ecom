import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, CircleCheck, Clock, DownloadCloud, ExternalLink, HelpCircle, ImageOff, Link2, ListChecks, PackagePlus, Play,
  RefreshCw, RotateCw, Search, Settings2, Unlink,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
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
  adoptStoreProducts, type AdoptPlan, firstSync, type FirstSyncPlan, importCatalog, linkVariant, listChannels, type ReconcilePlan, reconcileStock, retrySyncJob, runSyncJobs,
  saveSyncSettings, type SyncItem, type SyncOverview, syncOverview, storeProducts,
} from '@/services/channels'
import { formatMoney } from '@/lib/format'

const status = (store: string): Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> => ({
  OK: { label: 'In step', tone: 'ok' }, PENDING: { label: 'Updating', tone: 'muted' }, MISMATCH: { label: `Changed in ${store}`, tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'warn' }, NEW: { label: 'Not synced yet', tone: 'muted' }, UNTRACKED: { label: `Stock not counted in ${store}`, tone: 'muted' },
})
const F_STATUS: Record<string, string> = {
  PENDING: 'Queued', NEEDS_TRACKING: 'Needs tracking', PROCESSING: 'Sending', FULFILLED: 'Fulfilled', FAILED: 'Failed', SKIPPED: 'Skipped',
}
const D_STATUS: Record<string, string> = { PENDING: 'Sending', MARKED: 'Delivered', FAILED: 'Failed', SKIPPED: 'Skipped' }
const reason = (store: string): Record<string, string> => ({
  NO_SKU: `No SKU in ${store}`, DUPLICATE_SKU_SHOPIFY: `SKU used twice in ${store}`, DUPLICATE_SKU_HERE: 'SKU used twice here', NO_MATCH: 'No product here with this SKU',
})
const storeName = (platform?: string) => (platform === 'WOOCOMMERCE' ? 'WooCommerce' : 'Shopify')

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
    tone === 'ok' ? 'bg-foreground text-background' : tone === 'warn' ? 'ring-1 ring-foreground/60 ring-inset' : 'bg-muted text-muted-foreground')}>{children}</span>
}

/** Store sync (Shopify and WooCommerce): fulfilment and stock settings, mapping, differences, product import, jobs. */
export default function StoreSyncPage() {
  const channels = useQuery({ queryKey: ['sales-channels'], queryFn: listChannels })
  const shops = (channels.data ?? []).filter((c) => c.status !== 'DISCONNECTED')
  const [state, update] = useUrlState({ channel: '', tab: 'activity' })
  const channelId = state.channel || shops[0]?.id || ''

  if (channels.isLoading) return <LoadingState />
  if (channels.error) return <ErrorState error={channels.error} onRetry={() => channels.refetch()} />
  if (!shops.length) {
    return (
      <div className="space-y-4">
        <PageHeader title="Store sync" description="Keep your Shopify or WooCommerce stock in step with yours, import their products, and mark orders shipped there." />
        <EmptyState title="No store connected" description="Connect your Shopify or WooCommerce store first." action={<Button asChild size="sm"><Link to="/admin/channels">Sales channels</Link></Button>} />
      </div>
    )
  }
  return <SyncBody channelId={channelId} shops={shops} tab={state.tab} onTab={(tab) => update({ tab }, { resetPage: false })} onChannel={(channel) => update({ channel }, { resetPage: false })} />
}

function SyncBody({ channelId, shops, tab, onTab, onChannel }: {
  channelId: string; shops: Array<{ id: string; name: string; platform: string }>; tab: string; onTab: (t: string) => void; onChannel: (id: string) => void
}) {
  const { can } = useAuth()
  const qc = useQueryClient()
  const store = storeName(shops.find((s) => s.id === channelId)?.platform)
  const overview = useQuery({ queryKey: ['shopify-sync', channelId], queryFn: () => syncOverview(channelId), refetchInterval: 15_000 })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['shopify-sync', channelId] })
  const catalog = useMutation({
    mutationFn: () => importCatalog(channelId),
    onSuccess: (r) => { toast.success(`${formatNumber(r.items)} ${store} items read · ${r.linked} newly linked by SKU · ${r.mapped} linked in total`); refresh() },
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
  const missingScopes = o.channel.platform !== 'SHOPIFY' ? []
    : ['write_inventory', 'read_locations', 'write_merchant_managed_fulfillment_orders', 'read_products', 'write_fulfillments', 'write_orders'].filter((s) => !o.channel.scopes.includes(s))
  const firstDone = !!o.channel.first_sync_at
  const health = connectionHealth(o, missingScopes)

  return (
    <div className="space-y-4">
      <PageHeader title={`${store} sync`} description={`Orders, stock and products kept in step with ${store} automatically.`}
        actions={<>
          {shops.length > 1 && (
            <Select value={channelId} onValueChange={onChannel}>
              <SelectTrigger size="sm" className="w-full sm:w-52"><SelectValue /></SelectTrigger>
              <SelectContent>{shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} · {storeName(s.platform)}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <Button size="sm" variant="outline" asChild><Link to="/admin/channels"><HelpCircle /> Guide</Link></Button>
          <Button size="sm" variant="outline" onClick={() => onTab('settings')}><Settings2 /> Settings</Button>
        </>} />

      {missingScopes.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Shopify has not given this app: {missingScopes.join(', ')}. Add them to the app in Shopify's Dev Dashboard, release the version, then connect again on Sales channels.</span></p>
      )}

      {!firstDone && o.channel.status === 'CONNECTED' && <FirstSyncCard o={o} channelId={channelId} store={store} onDone={refresh} />}

      <StatusCard o={o} store={store} health={health} />
      <QueueCard o={o} onView={() => onTab('activity')} onRun={() => run.mutate()} running={run.isPending} canRun={can('orders.update')} />

      <Tabs value={tab === 'stock' && !firstDone ? 'stock' : tab} onValueChange={onTab}>
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
          <TabsList>
            <TabsTrigger value="activity">Recent activity</TabsTrigger>
            <TabsTrigger value="stock">Stock{diffs.length ? ` · ${diffs.length}` : ''}</TabsTrigger>
            <TabsTrigger value="fulfilments">Orders</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="unmapped">Not linked{o.unmapped.length ? ` · ${o.unmapped.length}` : ''}</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="activity" className="animate-in fade-in-0"><JobsTab o={o} onDone={refresh} /></TabsContent>
        <TabsContent value="stock" className="animate-in fade-in-0"><StockTab o={o} channelId={channelId} onDone={refresh} store={store} /></TabsContent>
        <TabsContent value="fulfilments" className="animate-in fade-in-0"><FulfilmentsTab o={o} store={store} /></TabsContent>
        <TabsContent value="products" className="animate-in fade-in-0"><ProductsTab o={o} channelId={channelId} onDone={refresh} store={store} /></TabsContent>
        <TabsContent value="unmapped" className="animate-in fade-in-0"><UnmappedTab o={o} channelId={channelId} onDone={refresh} store={store} /></TabsContent>
        <TabsContent value="settings" className="animate-in fade-in-0 space-y-3">
          <SettingsCard o={o} channelId={channelId} onSaved={refresh} store={store} />
          {can('inventory.view') && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Products and stock are read from {store} by themselves (right after connecting and every hour).
              <Button size="sm" variant="ghost" className="h-7" onClick={() => catalog.mutate()} disabled={catalog.isPending}>{catalog.isPending ? <Spinner /> : <DownloadCloud />} Read {store} now</Button>
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

type Health = { tone: 'ok' | 'busy' | 'action' | 'failed'; title: string; detail: string }
/** Connected / Syncing / Action required / Sync failed, in plain words. */
function connectionHealth(o: SyncOverview, missing: string[]): Health {
  const store = storeName(o.channel.platform)
  if (o.channel.status !== 'CONNECTED') {
    return { tone: 'failed', title: 'Not connected', detail: o.channel.last_error ? `${o.channel.last_error}. Connect the store again on Sales channels.` : 'Connect the store again on Sales channels.' }
  }
  if (o.jobs.failed > 0) return { tone: 'failed', title: 'Sync failed', detail: `${o.jobs.failed} update${o.jobs.failed === 1 ? '' : 's'} could not be sent to ${store}. See Recent activity — they can be retried.` }
  if (!o.channel.first_sync_at) return { tone: 'action', title: 'Action required', detail: 'Run the first sync above to bring your products and stock in.' }
  if (missing.length) return { tone: 'action', title: 'Action required', detail: `Give the app the missing permissions (${missing.join(', ')}).` }
  if (o.jobs.pending + o.jobs.processing > 0) return { tone: 'busy', title: 'Syncing', detail: `${o.jobs.pending + o.jobs.processing} update${o.jobs.pending + o.jobs.processing === 1 ? '' : 's'} being sent to ${store}.` }
  return { tone: 'ok', title: 'Stock sync active', detail: `Your ${store} store is connected and everything is in step.` }
}

function StatusCard({ o, store, health }: { o: SyncOverview; store: string; health: Health }) {
  const loc = o.channel.locations.find((l) => l.id === o.channel.settings.location_id)
  const s = o.channel.settings
  const Icon = health.tone === 'ok' ? CircleCheck : health.tone === 'busy' ? RefreshCw : AlertTriangle
  const tile = (label: string, value: string) => (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5"><p className="text-xs text-muted-foreground">{label}</p><p className="truncate font-semibold">{value}</p></div>
  )
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={cn('size-4', health.tone === 'ok' ? 'text-emerald-500' : health.tone === 'busy' ? 'animate-spin text-sky-500' : health.tone === 'action' ? 'text-amber-500' : 'text-red-500')} />
          {health.title}
        </CardTitle>
        <CardDescription>{health.detail}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tile('Real-time sync', s.inventory_sync ? 'Enabled' : 'Off')}
        {tile('Order stock', 'Reserved when ordered')}
        {tile('Location', loc?.name ?? 'Not chosen')}
        {tile(`Changes made in ${store}`, s.external_changes === 'TWO_WAY' ? 'Two-way (applied here)' : s.external_changes === 'SAAS_WINS' ? 'This app wins' : 'Flagged for review')}
      </CardContent>
    </Card>
  )
}

function QueueCard({ o, onView, onRun, running, canRun }: { o: SyncOverview; onView: () => void; onRun: () => void; running: boolean; canRun: boolean }) {
  const box = (label: string, value: number, tone: string, icon: React.ReactNode) => (
    <div className={cn('rounded-lg border px-3 py-2.5', tone)}>
      <p className="flex items-center gap-1.5 text-xs">{icon}{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  )
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div><CardTitle className="text-base">Sync queue</CardTitle><CardDescription>Updates go out by themselves within about a minute.</CardDescription></div>
        <div className="flex gap-2">
          {canRun && <Button size="sm" variant="ghost" onClick={onRun} disabled={running}>{running ? <Spinner /> : <Play />} Send now</Button>}
          <Button size="sm" variant="outline" onClick={onView}><ListChecks /> View activity</Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {box('Pending', o.jobs.pending, 'border-amber-500/40 bg-amber-500/10', <Clock className="size-3.5" />)}
        {box('Processing', o.jobs.processing, 'border-sky-500/40 bg-sky-500/10', <RefreshCw className="size-3.5" />)}
        {box('Failed', o.jobs.failed, 'border-red-500/40 bg-red-500/10', <AlertTriangle className="size-3.5" />)}
        {box('Completed', o.jobs.completed, 'border-emerald-500/40 bg-emerald-500/10', <CircleCheck className="size-3.5" />)}
      </CardContent>
    </Card>
  )
}

/**
 * The one-time first sync: bring every store product here (SKU, prices, cost,
 * images, stock), take the store's stock once for products already here, then
 * keep stock in step with this app as the source of truth. Preview first.
 */
function FirstSyncCard({ o, channelId, store, onDone }: { o: SyncOverview; channelId: string; store: string; onDone: () => void }) {
  const { can } = useAuth()
  const [location, setLocation] = useState(o.channel.settings.location_id ?? (o.channel.locations.length === 1 ? o.channel.locations[0].id : ''))
  const [auto, setAuto] = useState(true)
  const [plan, setPlan] = useState<FirstSyncPlan | null>(null)
  useEffect(() => { if (!location && o.channel.locations.length === 1) setLocation(o.channel.locations[0].id) }, [o.channel.locations, location])
  const allowed = can('settings.manage') && can('products.manage') && can('inventory.adjust')
  const read = useMutation({
    mutationFn: () => importCatalog(channelId),
    onSuccess: (r) => { toast.success(`${formatNumber(r.items)} ${store} items read`); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const preview = useMutation({
    // Fresh numbers from the store first, so the preview shows today's stock.
    mutationFn: async () => { await importCatalog(channelId); return firstSync(channelId, location, auto, false) },
    onSuccess: setPlan,
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const apply = useMutation({
    mutationFn: () => firstSync(channelId, location, auto, true),
    onSuccess: (r) => {
      toast.success(`First sync done: ${r.create} new variant${r.create === 1 ? '' : 's'}, ${r.stock_changes.length} stock correction${r.stock_changes.length === 1 ? '' : 's'}. Your stock now leads.`)
      setPlan(null); onDone(); void runSyncJobs().then(onDone).catch(() => undefined)
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const step = (n: number, done: boolean, title: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold', done ? 'bg-foreground text-background' : 'border')}>{done ? <Check className="size-3.5" /> : n}</span>
      <div className="min-w-0 flex-1 space-y-1.5 pb-1"><p className="text-sm font-medium">{title}</p><div className="text-xs text-muted-foreground">{body}</div></div>
    </li>
  )
  return (
    <Card className="border-foreground/30">
      <CardHeader>
        <CardTitle className="text-base">First sync with {store}</CardTitle>
        <CardDescription>
          Brings every {store} product here with its SKU, prices, cost, images and stock. Products you already have (same SKU) are linked and take {store}'s stock once.
          After that your stock here is the source of truth: every sale, return, purchase or adjustment is sent to {store} automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {step(1, !!o.channel.catalog_imported_at, `Read the ${store} catalog`, o.channel.catalog_imported_at
            ? <span className="flex flex-wrap items-center gap-2">{formatNumber(o.channel.catalog_items)} items read {timeAgo(o.channel.catalog_imported_at)}
                <Button size="sm" variant="ghost" className="h-7" onClick={() => read.mutate()} disabled={read.isPending}>{read.isPending ? <Spinner /> : <RefreshCw />} Read again</Button></span>
            : <span className="flex flex-wrap items-center gap-2">It is read by itself right after connecting.
                <Button size="sm" variant="outline" className="h-7" onClick={() => read.mutate()} disabled={read.isPending}>{read.isPending ? <Spinner /> : <DownloadCloud />} Read now</Button></span>)}
          {step(2, !!location, `Choose the ${store} location to keep in step`, (
            <Select value={location} onValueChange={setLocation} disabled={!o.channel.locations.length}>
              <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder={o.channel.locations.length ? 'Choose a location' : 'Read the catalog first'} /></SelectTrigger>
              <SelectContent>{o.channel.locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}{l.active ? '' : ' (inactive)'}</SelectItem>)}</SelectContent>
            </Select>
          ))}
          {step(3, false, 'Preview, then start', (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-foreground"><Switch checked={auto} onCheckedChange={setAuto} /> Import new {store} products automatically afterwards</label>
              <Button size="sm" onClick={() => preview.mutate()} disabled={!allowed || !location || !o.channel.catalog_imported_at || preview.isPending}>
                {preview.isPending ? <Spinner /> : <PackagePlus />} Preview first sync
              </Button>
              {!allowed && <p>Needs the settings, products and stock-adjust permissions (an owner can do it).</p>}
            </div>
          ))}
        </ol>
      </CardContent>
      <Dialog open={!!plan} onOpenChange={(v) => !v && setPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>First sync with {store}</DialogTitle>
            <DialogDescription>Preview: nothing has changed yet. Every stock change is recorded in the stock history; nothing is deleted.</DialogDescription>
          </DialogHeader>
          {plan && (
            <div className="min-w-0 space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([['New products', `${plan.products}`, `${plan.create} variant${plan.create === 1 ? '' : 's'}`], ['Linked by SKU', `${plan.link + plan.already_linked}`, 'already here'],
                  ['Stock taken once', `${plan.stock_changes.length}`, `from ${store}`], ['Not counted', `${plan.untracked}`, `stock off in ${store}`]] as const).map(([l, v, h]) => (
                  <div key={l} className="rounded-lg border p-2.5"><p className="text-[11px] text-muted-foreground">{l}</p><p className="text-lg font-semibold tabular-nums">{v}</p><p className="text-[11px] text-muted-foreground">{h}</p></div>
                ))}
              </div>
              {plan.stock_changes.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold">Stock here will match {store}</p>
                  <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border text-sm">
                    {plan.stock_changes.map((c) => (
                      <li key={c.variant_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span className="min-w-0"><span className="block truncate">{c.title}</span><span className="font-mono text-[11px] text-muted-foreground">{c.sku}</span></span>
                        <span className="shrink-0 tabular-nums">{c.ours} → <strong>{Math.max(c.store, 0)}</strong>{c.store < 0 && <span className="block text-[11px] text-muted-foreground">{store} had {c.store}</span>}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.items.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold">Coming here</p>
                  <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
                    {plan.items.map((p) => (
                      <li key={p.external_variant_id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span className="min-w-0"><span className="block truncate">{p.title}</span><span className="font-mono text-[11px] text-muted-foreground">{p.sku}</span></span>
                        <span className="shrink-0 text-right text-xs tabular-nums">
                          {p.action === 'LINK' ? <Pill tone="muted">Link existing</Pill> : <>
                            {p.price != null && <span className="block">{formatMoney(p.price)}{p.cost != null && <span className="text-muted-foreground"> · cost {formatMoney(p.cost)}</span>}</span>}
                            <span className="block text-muted-foreground">stock {p.stock ?? 0}</span></>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="flex items-start gap-2 text-xs text-muted-foreground"><CircleCheck className="mt-0.5 size-3.5 shrink-0" />
                Then stock sync turns on and {store} follows your stock. Orders shipped here are fulfilled on {store}{store === 'Shopify' ? ' and marked delivered when delivered' : ''}.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>Cancel</Button>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>{apply.isPending && <Spinner />} Start first sync</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function SettingsCard({ o, channelId, onSaved, store }: { o: SyncOverview; channelId: string; onSaved: () => void; store: string }) {
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
  type Key = 'fulfill_on_ship' | 'notify_customer' | 'fulfill_without_tracking' | 'inventory_sync' | 'auto_import_products' | 'mark_delivered'
    | 'cancel_on_shopify' | 'mark_paid_on_delivery' | 'status_tags' | 'courier_events' | 'update_products'
  const row = (label: string, hint: string, key: Key) => (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
      <Switch checked={s[key]} disabled={!edit} onCheckedChange={(v) => setS((x) => ({ ...x, [key]: v }))} />
    </label>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
        <CardDescription>Web Orders, approval and Ready to ship never touch {store}. Only Shipped does.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Fulfilment</p>
          {o.channel.platform === 'SHOPIFY'
            ? row('Fulfil on Shopify when shipped', 'Creates the fulfilment with courier, tracking number and tracking link', 'fulfill_on_ship')
            : row('Complete the WooCommerce order when shipped', 'Sets it to Completed and adds a note with courier, tracking number and tracking link (off by default)', 'fulfill_on_ship')}
          {o.channel.platform === 'SHOPIFY'
            ? row("Send Shopify's shipping e-mail", 'Shopify e-mails the customer the tracking link (when the order has an e-mail)', 'notify_customer')
            : row('E-mail the tracking note to the customer', 'Added as a customer note, which WooCommerce e-mails', 'notify_customer')}
          {row('Allow fulfilment without tracking', 'Off: an order without a tracking number waits until one is added', 'fulfill_without_tracking')}
          {o.channel.platform === 'SHOPIFY' && row('Mark delivered on Shopify', 'When the courier delivers it here, the order shows Delivered on Shopify too', 'mark_delivered')}
          {o.channel.platform === 'SHOPIFY' && <>
            <p className="pt-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Order status on Shopify</p>
            {row('Cancel on Shopify when cancelled here', 'From Web Orders or Approved Orders. Stock is never put back twice.', 'cancel_on_shopify')}
            {row('Mark paid when delivered', 'Cash-on-delivery orders show Paid on Shopify once the courier delivers', 'mark_paid_on_delivery')}
            {row('Show our status as a tag', 'Adds "Status: Confirmed / Shipped / Delivered / Returned …" to the Shopify order', 'status_tags')}
            {row('Send courier updates', 'Failed delivery and returned parcels show on the Shopify fulfilment', 'courier_events')}
          </>}
        </div>
        <div className="grid content-start gap-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Stock</p>
          {row(`Keep ${store} stock in step`, `Your available stock (on hand − reserved) is set on ${store} after every change`, 'inventory_sync')}
          {row(`Import new ${store} products automatically`, `A product added in ${store} comes here with its SKU, prices, cost, images and stock (after the first sync)`, 'auto_import_products')}
          {row(`Update products from ${store}`, `Price, cost, name, description, barcode, weight and images follow ${store}`, 'update_products')}
          <Field label={`${store} location`}>
            <Select value={s.location_id ?? ''} onValueChange={(v) => { if (v) setS((x) => ({ ...x, location_id: v })) }} disabled={!edit || !o.channel.locations.length}>
              <SelectTrigger className="w-full"><SelectValue placeholder={o.channel.locations.length ? 'Choose a location' : 'Read the catalog to load locations'} /></SelectTrigger>
              <SelectContent>{o.channel.locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}{l.active ? '' : ' (inactive)'}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={`When stock is changed by hand in ${store}`}>
            <Select value={s.external_changes} onValueChange={(v) => setS((x) => ({ ...x, external_changes: v as 'FLAG' | 'SAAS_WINS' | 'TWO_WAY' }))} disabled={!edit}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="TWO_WAY">Two-way — apply it to my stock here too (recommended)</SelectItem>
                <SelectItem value="FLAG">Flag it for me to review</SelectItem>
                <SelectItem value="SAAS_WINS">This app wins — set {store} back to my stock</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {edit && (
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Check />} Save</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setS(o.channel.settings)}>Cancel</Button>}
            {s.inventory_sync && !o.channel.settings.inventory_sync && (
              <p className="self-center text-xs text-muted-foreground">Turning it on takes today's {store} numbers as the starting point — nothing is overwritten until you review the differences.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StockTab({ o, channelId, onDone, store }: { o: SyncOverview; channelId: string; onDone: () => void; store: string }) {
  const STATUS = status(store)
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
      toast.success(plan!.action === 'PUSH' ? `${r.plan.length} item(s) will be set on ${store}` : `${r.plan.length} item(s) corrected here (recorded as stock corrections)`)
      setPlan(null); setSel(new Set()); onDone(); void runSyncJobs().then(onDone).catch(() => undefined)
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.variant_id))
  if (!o.items.length) return <EmptyState title="No variants linked yet" description={`Click “Read ${store} catalog”: items are linked to yours by SKU, the rest are listed under Not linked, and you can import them under Import products.`} />
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="flex items-center gap-2 text-sm"><Switch checked={only} onCheckedChange={setOnly} /> Only differences</label>
        {sel.size > 0 && can('inventory.adjust') && (
          <div className="ml-auto flex flex-wrap gap-2 animate-in fade-in-0">
            <Button size="sm" variant="outline" onClick={() => preview.mutate('PUSH')} disabled={preview.isPending}><ArrowUpFromLine /> Set {store} to mine ({sel.size})</Button>
            <Button size="sm" variant="outline" onClick={() => preview.mutate('ADOPT')} disabled={preview.isPending}><ArrowDownToLine /> Use {store}'s number ({sel.size})</Button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="w-8 px-3 py-2"><Checkbox checked={allOn} onCheckedChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.variant_id)))} aria-label="Select all" /></th>
            <th className="px-3 py-2">Product</th><th className="px-3 py-2">SKU</th>
            <th className="px-3 py-2 text-right">On hand</th><th className="px-3 py-2 text-right">Reserved</th><th className="px-3 py-2 text-right">Available here</th>
            <th className="px-3 py-2 text-right">{store}</th><th className="px-3 py-2">Status</th>
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
            <DialogTitle>{plan?.action === 'PUSH' ? `Set ${store} to your stock` : `Use ${store}'s numbers here`}</DialogTitle>
            <DialogDescription>Preview — nothing has changed yet. {plan?.action === 'ADOPT' ? 'Each change is recorded as a stock correction in the movement history.' : `${store} is updated by the sync job right after.`}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
            {plan?.result.plan.map((p) => (
              <li key={p.variant_id} className="flex justify-between gap-3 px-3 py-2">
                <span className="font-mono text-xs">{p.sku}</span>
                <span className="tabular-nums">{plan.action === 'PUSH' ? store : 'Here'}: {p.from ?? '—'} → <strong>{p.to}</strong></span>
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

function UnmappedTab({ o, channelId, onDone, store }: { o: SyncOverview; channelId: string; onDone: () => void; store: string }) {
  const REASON = reason(store)
  const { can } = useAuth()
  const link = useMutation({
    mutationFn: ({ ext, variant }: { ext: string; variant: string | null }) => linkVariant(channelId, ext, variant),
    onSuccess: () => { toast.success('Linked'); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!o.unmapped.length) return <EmptyState title={`Every ${store} item is linked`} description={`New products in ${store} appear here after the next catalog read.`} />
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">
        {o.unmapped.map((u) => (
          <li key={u.external_variant_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{u.title}</p>
              <p className="text-xs text-muted-foreground">{u.sku && <><span className="font-mono">{u.sku}</span> · </>}{REASON[u.reason]}{u.available !== null ? ` · ${u.available} in ${store}` : ''}</p>
            </div>
            {can('inventory.adjust') && <VariantPicker onPick={(variant) => link.mutate({ ext: u.external_variant_id, variant })} />}
          </li>
        ))}
      </ul>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">Tip: give each product the same SKU here and in {store} — they link by themselves on the next catalog read. Products you don't have here yet can be created under Import products. <Unlink className="inline size-3" /> Linking never changes either side's stock.</p>
    </Card>
  )
}

function FulfilmentsTab({ o, store }: { o: SyncOverview; store: string }) {
  if (!o.fulfillments.length) return <EmptyState title="No fulfilments yet" description={`When a ${store} order is marked Shipped here, it shows up here.`} />
  return (
    <Card className="gap-0 py-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2">Order</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Courier · tracking</th><th className="px-3 py-2">Customer e-mail</th>
            {store === 'Shopify' && <th className="px-3 py-2">Delivered on Shopify</th>}<th className="px-3 py-2">When</th>
          </tr></thead>
          <tbody>
            {o.fulfillments.map((f) => (
              <tr key={`${f.order_id}-${f.created_at}`} className="border-b last:border-0">
                <td className="px-3 py-2"><Link to={`/admin/orders/${f.order_id}`} className="font-medium hover:underline">{f.order_number}</Link>{f.source === 'SHOPIFY' && <span className="block text-[11px] text-muted-foreground">made in {store}</span>}</td>
                <td className="px-3 py-2"><Pill tone={f.status === 'FULFILLED' ? 'ok' : f.status === 'FAILED' || f.status === 'NEEDS_TRACKING' ? 'warn' : 'muted'}>{F_STATUS[f.status] ?? f.status}</Pill>
                  {f.last_error && <span className="block max-w-64 truncate text-[11px] text-muted-foreground" title={f.last_error}>{f.last_error}</span>}</td>
                <td className="px-3 py-2 text-xs">{f.courier ?? '—'} {f.tracking_url ? <a href={f.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono underline">{f.tracking_number}<ExternalLink className="size-3" /></a> : <span className="font-mono">{f.tracking_number}</span>}</td>
                <td className="px-3 py-2 text-xs">{f.notification_status === 'REQUESTED' ? `Requested from ${store}` : f.notification_status === 'NO_EMAIL' ? 'No e-mail on order' : f.notification_status === 'DISABLED' ? 'Turned off' : '—'}</td>
                {store === 'Shopify' && (
                  <td className="px-3 py-2 text-xs">
                    {f.delivered_status ? <Pill tone={f.delivered_status === 'MARKED' ? 'ok' : f.delivered_status === 'FAILED' ? 'warn' : 'muted'}>{D_STATUS[f.delivered_status]}</Pill> : '—'}
                    {f.delivered_error && <span className="block max-w-56 truncate text-[11px] text-muted-foreground" title={f.delivered_error}>{f.delivered_error}</span>}
                  </td>
                )}
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(f.fulfilled_at ?? f.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** What was sent, in plain words: one line per order or product. */
function activityText(j: SyncOverview['recent_jobs'][number]): string {
  const r = (j.result ?? {}) as Record<string, unknown>
  if (j.kind === 'INVENTORY') {
    if (r.set !== undefined) return `Stock set to ${r.set}${r.from !== undefined && r.from !== null ? ` (was ${r.from})` : ''}`
    if (r.taken_from_store !== undefined) return `Changed in the store → ${r.taken_from_store} (applied here)`
    if (r.in_step !== undefined) return `Already in step (${r.in_step})`
    if (r.flagged !== undefined) return 'Changed in the store — flagged for review'
    return j.status === 'DONE' ? 'Checked' : 'Stock update'
  }
  const parts: string[] = []
  if (r.cancel_job || r.cancel === 'already cancelled') parts.push('cancelled')
  if (r.fulfillment_id || r.adopted) parts.push('fulfilled')
  if (r.delivered_event) parts.push('delivered')
  if (r.event) parts.push(String(r.event).toLowerCase().replace(/_/g, ' '))
  if (r.paid) parts.push('marked paid')
  if (r.tag) parts.push(String(r.tag))
  if (r.waiting) parts.push('waiting for a tracking number')
  return parts.length ? parts.join(' · ') : j.status === 'DONE' ? 'Up to date' : 'Order update'
}

function JobsTab({ o, onDone }: { o: SyncOverview; onDone: () => void }) {
  const { can } = useAuth()
  const retry = useMutation({
    mutationFn: async (id: string) => { await retrySyncJob(id); await runSyncJobs() },
    onSuccess: () => { toast.success('Sent again'); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!o.recent_jobs.length) return <EmptyState title="Nothing sent yet" description="Order and stock updates appear here as they go out." />
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y text-sm">
        {o.recent_jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-3 px-3 py-2.5">
            {j.status === 'DONE' ? <CircleCheck className="size-4 shrink-0 text-emerald-500" />
              : j.status === 'FAILED' ? <AlertTriangle className="size-4 shrink-0 text-red-500" />
                : <RefreshCw className={cn('size-4 shrink-0 text-sky-500', j.status === 'RUNNING' && 'animate-spin')} />}
            <span className="min-w-0 flex-1">
              {j.kind === 'FULFILL'
                ? <Link to={`/admin/orders/${j.ref_id}`} className="font-medium hover:underline">{j.label ?? 'Order'}</Link>
                : <span className="font-medium">{j.label ?? 'Product'}</span>}
              <span className="block truncate text-xs text-muted-foreground" title={j.last_error ?? undefined}>
                {j.sku && <span className="font-mono">{j.sku} · </span>}{j.status === 'FAILED' || (j.last_error && j.status !== 'DONE') ? j.last_error : activityText(j)}
              </span>
            </span>
            <span className="hidden gap-1 sm:flex">
              <Pill tone={j.status === 'DONE' ? 'ok' : j.status === 'FAILED' ? 'warn' : 'muted'}>{j.status === 'DONE' ? 'success' : j.status === 'FAILED' ? 'failed' : j.status.toLowerCase()}</Pill>
              <Pill tone="muted">{j.kind === 'FULFILL' ? 'order' : 'stock'}</Pill>
            </span>
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{timeAgo(j.updated_at)}</span>
            {j.status === 'FAILED' && can('settings.manage') && <Button size="sm" variant="outline" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}><RotateCw /> Retry</Button>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The store's products not in this catalog yet: preview, then create them here (optionally with the store's stock as opening stock). */
function ProductsTab({ o, channelId, onDone, store }: { o: SyncOverview; channelId: string; onDone: () => void; store: string }) {
  const { can } = useAuth()
  const [q, setQ] = useState('')
  const [onlyNew, setOnlyNew] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [withStock, setWithStock] = useState(true)
  const [plan, setPlan] = useState<AdoptPlan | null>(null)
  const products = useQuery({ queryKey: ['store-products', channelId, q], queryFn: () => storeProducts(channelId, q), enabled: !!o.channel.catalog_imported_at })
  const rows = (products.data ?? []).filter((p) => !onlyNew || p.linked < p.variants)
  const preview = useMutation({
    mutationFn: () => adoptStoreProducts(channelId, [...sel], withStock && can('inventory.adjust'), false),
    onSuccess: setPlan,
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const apply = useMutation({
    mutationFn: () => adoptStoreProducts(channelId, [...sel], withStock && can('inventory.adjust'), true),
    onSuccess: (r) => {
      toast.success(`${r.created} variant${r.created === 1 ? '' : 's'} created${r.linked ? `, ${r.linked} linked to existing SKUs` : ''}`)
      setPlan(null); setSel(new Set()); void products.refetch(); onDone()
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!o.channel.catalog_imported_at) return <EmptyState title={`Read the ${store} catalog first`} description="Then pick the products to bring into your catalog here." />
  if (!can('products.manage')) return <EmptyState title="You can't create products" description="Ask an owner or inventory manager to import them." />
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.product_id))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or SKU" className="h-8 pl-8" />
        </div>
        <label className="flex items-center gap-2 text-sm"><Switch checked={onlyNew} onCheckedChange={setOnlyNew} /> Only not imported</label>
        {sel.size > 0 && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto animate-in fade-in-0">
            {can('inventory.adjust') && <label className="flex items-center gap-2 text-sm"><Checkbox checked={withStock} onCheckedChange={(v) => setWithStock(v === true)} /> Use {store}'s stock as opening stock</label>}
            <Button size="sm" onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? <Spinner /> : <PackagePlus />} Import {sel.size}</Button>
          </div>
        )}
      </div>
      {products.isLoading ? <LoadingState /> : products.error ? <ErrorState error={products.error} onRetry={() => products.refetch()} /> : (
        <ul className="divide-y">
          {rows.length > 0 && (
            <li className="flex items-center gap-3 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              <Checkbox checked={allOn} onCheckedChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.product_id)))} aria-label="Select all" /> {rows.length} product{rows.length === 1 ? '' : 's'}
            </li>
          )}
          {rows.map((p) => (
            <li key={p.product_id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/30">
                <Checkbox checked={sel.has(p.product_id)} onCheckedChange={() => toggle(p.product_id)} aria-label={`Select ${p.title}`} />
                {p.image_url
                  ? <img src={p.image_url} alt="" className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" />
                  : <span className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted"><ImageOff className="size-4 text-muted-foreground" /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.variants} variant{p.variants === 1 ? '' : 's'}{p.skus?.length ? ` · ${p.skus.join(', ')}` : ''}{p.status && p.status !== 'ACTIVE' ? ` · ${p.status.toLowerCase()}` : ''}
                  </span>
                </span>
                <span className="hidden text-right text-xs sm:block">
                  {p.price !== null && <span className="block tabular-nums">{formatMoney(p.price)}{p.cost != null && <span className="text-muted-foreground"> · cost {formatMoney(p.cost)}</span>}</span>}
                  <span className="block text-muted-foreground tabular-nums">{p.stock ?? '—'} in stock</span>
                </span>
                {p.linked > 0 && <Pill tone={p.linked === p.variants ? 'ok' : 'muted'}>{p.linked === p.variants ? 'Imported' : `${p.linked}/${p.variants} linked`}</Pill>}
              </label>
            </li>
          ))}
          {!rows.length && <li className="px-3 py-8 text-center text-sm text-muted-foreground">{onlyNew ? `Every ${store} product is already here.` : 'No products found.'}</li>}
        </ul>
      )}
      <Dialog open={!!plan} onOpenChange={(v) => !v && setPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import into your catalog</DialogTitle>
            <DialogDescription>Preview — nothing has been created yet. Variants whose SKU already exists here are linked, not duplicated.{withStock && can('inventory.adjust') ? ' Opening stock is recorded in the stock movement history.' : ' New variants start with 0 in stock.'}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
            {plan?.plan.map((p) => (
              <li key={p.external_variant_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0"><span className="block truncate">{p.title}</span><span className="font-mono text-[11px] text-muted-foreground">{p.sku}</span></span>
                <span className="shrink-0 text-right text-xs">
                  <Pill tone={p.action === 'CREATE' ? 'ok' : 'muted'}>{p.action === 'CREATE' ? 'New' : p.action === 'LINK' ? 'Link existing' : 'Already here'}</Pill>
                  {p.stock != null && <span className="block pt-0.5 text-muted-foreground tabular-nums">opening stock {p.stock}</span>}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>Cancel</Button>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending || !plan?.plan.some((p) => p.action !== 'ALREADY_LINKED')}>
              {apply.isPending && <Spinner />} Import {plan?.plan.filter((p) => p.action !== 'ALREADY_LINKED').length ?? 0}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

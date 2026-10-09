import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Copy, ExternalLink, Palette, Plug, RefreshCw, Stethoscope, Unplug, Webhook, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type ChannelCheck, type ChannelImport, type ChannelPlatform, disconnectChannel, fixWebhooks, listChannelImports, listChannels,
  retryImport, type SalesChannel, saveChannelSettings, type SetupResult, shopifyConnect, shopifyRedirectUri, shopifyToken, syncChannel,
  testChannel, wooConnect, wooKeys,
} from '@/services/channels'

const PLATFORM: Record<ChannelPlatform, { name: string; mark: string }> = {
  SHOPIFY: { name: 'Shopify', mark: 'S' },
  WOOCOMMERCE: { name: 'WooCommerce', mark: 'W' },
}

const STATUS: Record<SalesChannel['status'], { label: string; className: string }> = {
  CONNECTED: { label: 'Connected', className: 'bg-foreground text-background' },
  ERROR: { label: 'Needs attention', className: 'ring-1 ring-inset ring-foreground/50' },
  PENDING: { label: 'Waiting for approval', className: 'bg-muted text-muted-foreground' },
  DISCONNECTED: { label: 'Disconnected', className: 'bg-muted text-muted-foreground' },
}

export default function SalesChannelsPage() {
  const { can } = useAuth()
  const manage = can('settings.manage')
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const channels = useQuery({ queryKey: ['sales-channels'], queryFn: listChannels, refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'PENDING') ? 5000 : false) })
  const [dialog, setDialog] = useState<ChannelPlatform | null>(null)

  // Back from Shopify / WooCommerce approval.
  useEffect(() => {
    const connected = params.get('connected')
    const error = params.get('error')
    if (!connected && !error && !params.get('channel')) return
    if (connected) toast.success(`${connected === 'shopify' ? 'Shopify' : 'WooCommerce'} connected — orders will arrive automatically`)
    if (error) toast.error(error)
    void queryClient.invalidateQueries({ queryKey: ['sales-channels'] })
    setParams((p) => { p.delete('connected'); p.delete('error'); p.delete('success'); p.delete('user_id'); p.delete('woo'); return p }, { replace: true })
  }, [params, setParams, queryClient])

  const live = (channels.data ?? []).filter((c) => c.status !== 'DISCONNECTED')
  const old = (channels.data ?? []).filter((c) => c.status === 'DISCONNECTED')

  return (
    <div className="space-y-5">
      <PageHeader title="Sales channels" description="Where your orders come from. Orders from a connected store land in Web Orders like any other order." />

      <div className="grid gap-3 md:grid-cols-3">
        <SourceCard mark={<Palette className="size-4" />} title="Your store" subtitle={window.location.host}
          status={<Pill className="bg-foreground text-background">Online</Pill>}
          actions={<>
            {manage && <Button size="sm" asChild><Link to="/admin/store/theme">Edit theme</Link></Button>}
            <Button size="sm" variant="outline" asChild><a href="/" target="_blank" rel="noreferrer"><ExternalLink /> View</a></Button>
          </>}>
          Built in. Checkout, courier booking, fraud checks and messages work out of the box.
        </SourceCard>
        {(['SHOPIFY', 'WOOCOMMERCE'] as const).map((p) => {
          const mine = live.filter((c) => c.platform === p)
          return (
            <SourceCard key={p} mark={PLATFORM[p].mark} title={PLATFORM[p].name}
              subtitle={mine.length ? `${mine.length} store${mine.length === 1 ? '' : 's'} connected` : 'Not connected'}
              status={mine.length ? <Pill className={STATUS[mine.some((c) => c.status !== 'CONNECTED') ? 'ERROR' : 'CONNECTED'].className}>{mine.some((c) => c.status !== 'CONNECTED') ? 'Check' : 'Connected'}</Pill> : null}
              actions={manage && <Button size="sm" variant={mine.length ? 'outline' : 'default'} onClick={() => setDialog(p)}><Plug /> {mine.length ? 'Add store' : 'Connect'}</Button>}>
              {p === 'SHOPIFY' ? 'Orders from your Shopify store arrive here within seconds, with the ad they came from.' : 'Connect a WordPress store with WooCommerce. One click on your own site approves it.'}
            </SourceCard>
          )
        })}
      </div>

      {channels.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div>
        : channels.error ? <ErrorState error={channels.error} onRetry={() => channels.refetch()} />
          : live.map((c) => <ChannelCard key={c.id} c={c} manage={manage} />)}

      <ImportsCard channels={channels.data ?? []} />

      {old.length > 0 && (
        <p className="text-xs text-muted-foreground">Disconnected: {old.map((c) => c.name).join(', ')} — their imported orders stay. Connect again any time.</p>
      )}

      {dialog === 'SHOPIFY' && <ShopifyDialog onClose={() => setDialog(null)} />}
      {dialog === 'WOOCOMMERCE' && <WooDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', className)}>{children}</span>
}

function SourceCard({ mark, title, subtitle, status, actions, children }: { mark: ReactNode; title: string; subtitle: string; status: ReactNode; actions: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border text-sm font-semibold">{mark}</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
          {status}
        </div>
        <p className="text-sm text-muted-foreground">{children}</p>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </CardContent>
    </Card>
  )
}

function Checklist({ checks }: { checks: ChannelCheck[] }) {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {checks.map((c) => (
        <li key={c.key} className="flex gap-2 rounded-lg border px-3 py-2 text-sm">
          <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full',
            c.status === 'ok' ? 'bg-foreground text-background' : c.status === 'warn' ? 'bg-muted-foreground/30 text-foreground' : 'bg-red-600 text-white')}>
            {c.status === 'ok' ? <Check className="size-3" /> : c.status === 'warn' ? <span className="text-[10px] font-bold">!</span> : <X className="size-3" />}
          </span>
          <span className="min-w-0"><span className="font-medium">{c.label}</span><span className="block text-xs text-muted-foreground">{c.detail}</span></span>
        </li>
      ))}
    </ul>
  )
}

function ChannelCard({ c, manage }: { c: SalesChannel; manage: boolean }) {
  const queryClient = useQueryClient()
  const [, setParams] = useSearchParams()
  const [confirm, setConfirm] = useState(false)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sales-channels'] })
    void queryClient.invalidateQueries({ queryKey: ['channel-imports'] })
  }
  const onSetup = (r: SetupResult) => { refresh(); toast[r.ok ? 'success' : 'error'](r.ok ? 'Everything checks out' : 'The test found a problem — see the list') }
  const test = useMutation({ mutationFn: () => testChannel(c.id), onSuccess: onSetup })
  const hooks = useMutation({ mutationFn: () => fixWebhooks(c.id), onSuccess: onSetup })
  const sync = useMutation({
    mutationFn: () => syncChannel(c.id, 7),
    onSuccess: (r) => {
      refresh()
      const x = r.channels[0]
      toast.success(`Checked ${x.found} order${x.found === 1 ? '' : 's'} from the last 7 days: ${x.imported} new${x.failed ? `, ${x.failed} need fixing` : ''}`)
    },
  })
  const toggle = useMutation({ mutationFn: (v: boolean) => saveChannelSettings(c.id, { import_orders: v }), onSuccess: refresh })
  const checks = c.last_test?.checks ?? []
  const hookFailed = checks.some((x) => x.key === 'webhooks' && x.status === 'fail')
  const busy = test.isPending || hooks.isPending || sync.isPending

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground text-sm font-semibold text-background">{PLATFORM[c.platform].mark}</span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-semibold">{c.name} <Pill className={STATUS[c.status].className}>{STATUS[c.status].label}</Pill></p>
            <p className="truncate text-xs text-muted-foreground">{PLATFORM[c.platform].name} · {c.shop_domain}{c.currency ? ` · ${c.currency}` : ''}</p>
          </div>
          {manage && (
            <label className="flex items-center gap-2 text-sm">Import orders
              <Switch checked={c.settings.import_orders !== false} onCheckedChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} />
            </label>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Imported" value={c.orders_imported} />
          <Stat label="Today" value={c.today} />
          <Stat label="Need fixing" value={c.failed} onClick={c.failed ? () => setParams((p) => { p.set('imports', 'FAILED'); return p }) : undefined} />
          <Stat label="Last order" value={c.last_order_at ? timeAgo(c.last_order_at) : '—'} />
          <Stat label="Last check" value={c.last_tested_at ? timeAgo(c.last_tested_at) : '—'} />
        </dl>

        {c.status === 'PENDING' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Waiting for you to approve on {PLATFORM[c.platform].name}…</p>}
        {checks.length > 0 && <Checklist checks={checks} />}
        {c.last_error && c.status === 'ERROR' && !checks.length && <p className="flex items-center gap-2 text-sm"><AlertTriangle className="size-4" /> {c.last_error}</p>}

        {manage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={busy}>{test.isPending ? <Spinner /> : <Stethoscope />} Test connection</Button>
            <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={busy || c.status === 'PENDING'}>{sync.isPending ? <Spinner /> : <RefreshCw />} Fetch last 7 days</Button>
            {hookFailed && <Button size="sm" onClick={() => hooks.mutate()} disabled={busy}>{hooks.isPending ? <Spinner /> : <Webhook />} Fix webhooks</Button>}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirm(true)}><Unplug /> Disconnect</Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} destructive confirmLabel="Disconnect" title={`Disconnect ${c.name}?`}
        description="New orders stop arriving and the access is deleted. Orders already imported stay."
        onConfirm={async () => { await disconnectChannel(c.id); refresh(); toast.success('Disconnected') }} />
    </Card>
  )
}

function Stat({ label, value, onClick }: { label: string; value: ReactNode; onClick?: () => void }) {
  const inner = <><dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></>
  return onClick
    ? <button type="button" onClick={onClick} className="rounded-lg border px-3 py-2 text-left underline-offset-2 hover:underline">{inner}</button>
    : <div className="rounded-lg border px-3 py-2">{inner}</div>
}

// --- connecting ------------------------------------------------------------------------

function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div className="flex rounded-lg border p-0.5 text-sm" role="tablist">
      {options.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={cn('flex-1 rounded-md px-3 py-1.5', value === k ? 'bg-foreground text-background' : 'text-muted-foreground')}>{label}</button>
      ))}
    </div>
  )
}

const returnTo = () => `${window.location.origin}/admin/channels`

function CopyLine({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-muted/40 px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(value); toast.success('Copied') }}><Copy /></Button>
    </div>
  )
}

function ShopifyDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'app' | 'token'>('app')
  const [f, setF] = useState({ shop: '', client_id: '', client_secret: '', access_token: '', api_secret: '' })
  const [result, setResult] = useState<SetupResult | null>(null)
  const run = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (mode === 'app') {
        const r = await shopifyConnect({ shop: f.shop, client_id: f.client_id, client_secret: f.client_secret || undefined, return_to: returnTo() })
        window.location.href = r.url
        return null
      }
      return shopifyToken({ shop: f.shop, access_token: f.access_token, api_secret: f.api_secret })
    },
    onSuccess: (r) => { if (r) { setResult(r); void queryClient.invalidateQueries({ queryKey: ['sales-channels'] }) } },
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  if (result) return <ResultDialog result={result} onClose={onClose} />
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide title="Connect Shopify" busy={run.isPending}
      submitLabel={mode === 'app' ? 'Continue to Shopify' : 'Connect and test'} onSubmit={() => run.mutate()}
      disabled={!f.shop || (mode === 'app' ? !f.client_id : !f.access_token || !f.api_secret)}>
      <Tabs value={mode} onChange={setMode} options={[['app', 'With your app (recommended)'], ['token', 'Admin API token']]} />
      <Field label="Store address" htmlFor="sh-shop"><Input id="sh-shop" value={f.shop} onChange={set('shop')} placeholder="mystore.myshopify.com" autoComplete="off" /></Field>
      {mode === 'app' ? <>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>In Shopify's Dev Dashboard (or Settings → Apps → Develop apps) create an app for your store.</li>
          <li>Give it the scopes <b className="text-foreground">read_orders, read_customers, read_products</b> and ask for protected customer data: <b className="text-foreground">name, phone, address</b>.</li>
          <li>Add this allowed redirect URL:</li>
        </ol>
        <CopyLine value={shopifyRedirectUri()} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID" htmlFor="sh-id"><Input id="sh-id" value={f.client_id} onChange={set('client_id')} autoComplete="off" /></Field>
          <Field label="Client secret" htmlFor="sh-secret" hint="Kept encrypted on the server"><Input id="sh-secret" type="password" value={f.client_secret} onChange={set('client_secret')} autoComplete="off" /></Field>
        </div>
      </> : <>
        <p className="text-sm text-muted-foreground">For a custom app made in your Shopify admin: install it, then copy its Admin API access token and API secret key.</p>
        <Field label="Admin API access token" htmlFor="sh-token"><Input id="sh-token" type="password" value={f.access_token} onChange={set('access_token')} placeholder="shpat_…" autoComplete="off" /></Field>
        <Field label="API secret key" htmlFor="sh-api" hint="Used to check that orders really come from Shopify"><Input id="sh-api" type="password" value={f.api_secret} onChange={set('api_secret')} autoComplete="off" /></Field>
      </>}
      {run.error && <p className="rounded-lg border border-red-600/40 p-3 text-sm" role="alert">{(run.error as Error).message}</p>}
    </FormDialog>
  )
}

function WooDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'click' | 'keys'>('click')
  const [f, setF] = useState({ url: '', consumer_key: '', consumer_secret: '' })
  const [result, setResult] = useState<SetupResult | null>(null)
  const run = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (mode === 'click') {
        const r = await wooConnect({ url: f.url, return_to: returnTo() })
        window.location.href = r.url
        return null
      }
      return wooKeys({ url: f.url, consumer_key: f.consumer_key, consumer_secret: f.consumer_secret })
    },
    onSuccess: (r) => { if (r) { setResult(r); void queryClient.invalidateQueries({ queryKey: ['sales-channels'] }) } },
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  if (result) return <ResultDialog result={result} onClose={onClose} />
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide title="Connect WooCommerce" busy={run.isPending}
      submitLabel={mode === 'click' ? 'Continue to my site' : 'Connect and test'} onSubmit={() => run.mutate()}
      disabled={!f.url || (mode === 'keys' && (!f.consumer_key || !f.consumer_secret))}>
      <Tabs value={mode} onChange={setMode} options={[['click', 'One click (recommended)'], ['keys', 'API keys']]} />
      <Field label="Store address" htmlFor="wc-url" hint="Must start with https://"><Input id="wc-url" value={f.url} onChange={set('url')} placeholder="https://mystore.com" autoComplete="off" /></Field>
      {mode === 'click'
        ? <p className="text-sm text-muted-foreground">You'll sign in to your WordPress and click <b className="text-foreground">Approve</b>. WooCommerce then sends us Read/Write keys — nothing to copy.</p>
        : <>
          <p className="text-sm text-muted-foreground">WooCommerce → Settings → Advanced → REST API → Add key, with <b className="text-foreground">Read/Write</b> permission.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Consumer key" htmlFor="wc-ck"><Input id="wc-ck" value={f.consumer_key} onChange={set('consumer_key')} placeholder="ck_…" autoComplete="off" /></Field>
            <Field label="Consumer secret" htmlFor="wc-cs"><Input id="wc-cs" type="password" value={f.consumer_secret} onChange={set('consumer_secret')} placeholder="cs_…" autoComplete="off" /></Field>
          </div>
        </>}
      {run.error && <p className="rounded-lg border border-red-600/40 p-3 text-sm" role="alert">{(run.error as Error).message}</p>}
    </FormDialog>
  )
}

function ResultDialog({ result, onClose }: { result: SetupResult; onClose: () => void }) {
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide title={result.ok ? `${result.channel.name} is connected` : 'Connected, but something needs fixing'}
      description={result.ok ? 'New orders will arrive within seconds. Orders from the last 7 days are being fetched now.' : 'Fix the items marked ✕, then click Test connection on the channel.'}
      submitLabel="Done" onSubmit={onClose}>
      <Checklist checks={result.checks} />
    </FormDialog>
  )
}

// --- imports ---------------------------------------------------------------------------

const IMPORT_TABS: Array<[string, string]> = [['', 'All'], ['FAILED', 'Need fixing'], ['IMPORTED', 'Imported'], ['SKIPPED', 'Skipped']]

function ImportsCard({ channels }: { channels: SalesChannel[] }) {
  const [params, setParams] = useSearchParams()
  const status = params.get('imports') ?? ''
  const [page, setPage] = useState(0)
  const [fixing, setFixing] = useState<ChannelImport | null>(null)
  const imports = useQuery({ queryKey: ['channel-imports', status, page], queryFn: () => listChannelImports({ status: status || undefined, limit: 20, offset: page * 20 }) })
  if (!channels.length) return null
  const items = imports.data?.items ?? []
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Orders received</h2>
          <div className="flex rounded-lg border p-0.5 text-xs" role="tablist">
            {IMPORT_TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => { setPage(0); setParams((p) => { if (k) p.set('imports', k); else p.delete('imports'); return p }) }}
                className={cn('rounded-md px-2.5 py-1', status === k ? 'bg-foreground text-background' : 'text-muted-foreground')}>{label}</button>
            ))}
          </div>
        </div>
        {imports.isLoading ? <div className="grid place-items-center py-6"><Spinner /></div>
          : items.length === 0 ? <EmptyState title={status === 'FAILED' ? 'Nothing to fix' : 'No orders yet'} description={status === 'FAILED' ? 'Every order came through.' : 'Orders appear here as your stores send them.'} />
            : (
              <ul className="divide-y rounded-lg border">
                {items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                    <span className="w-24 shrink-0">
                      <span className="block font-medium">{i.external_number ?? i.external_id}</span>
                      <span className="text-xs text-muted-foreground">{PLATFORM[i.platform].name}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{i.customer.name ?? '—'} · {i.customer.phone ?? 'no phone'}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {i.status === 'FAILED' ? i.error : i.status === 'SKIPPED' ? i.error : [i.shipping.city, `${i.items} item${i.items === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                        {i.warnings.length > 0 && ` · ${i.warnings[0]}`}
                      </span>
                    </span>
                    <span className="w-24 text-right tabular-nums">{i.total ? formatMoney(Number(i.total)) : '—'}</span>
                    <span className="w-28 text-right text-xs text-muted-foreground">{timeAgo(i.updated_at)}</span>
                    <span className="flex w-32 justify-end">
                      {i.status === 'IMPORTED' && i.order_id
                        ? <Link to={`/admin/orders/${i.order_id}`} className="text-sm font-medium underline underline-offset-2">{i.order_number}</Link>
                        : i.status === 'FAILED'
                          ? <Button size="sm" variant="outline" className="h-7" onClick={() => setFixing(i)}>Fix &amp; import</Button>
                          : <span className="text-xs text-muted-foreground">Skipped</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        {(imports.data?.total ?? 0) > 20 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-muted-foreground">{page + 1} / {Math.ceil((imports.data?.total ?? 0) / 20)}</span>
            <Button size="sm" variant="ghost" disabled={(page + 1) * 20 >= (imports.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </CardContent>
      {fixing && <FixDialog item={fixing} onClose={() => setFixing(null)} />}
    </Card>
  )
}

function FixDialog({ item, onClose }: { item: ChannelImport; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { data: config } = useStoreConfig()
  const [f, setF] = useState({ phone: item.customer.phone ?? '', name: item.customer.name ?? '', address: item.shipping.address ?? '', district: item.shipping.district ?? '' })
  const [error, setError] = useState<string | null>(null)
  const run = useMutation({
    meta: { silent: true },
    mutationFn: () => retryImport(item.id, f),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['channel-imports'] })
      void queryClient.invalidateQueries({ queryKey: ['sales-channels'] })
      if (r.status === 'IMPORTED' || r.status === 'DUPLICATE') { toast.success(`Imported as ${r.order_number}`); onClose() } else setError(r.error ?? 'Still could not import it')
    },
    onError: (e) => setError((e as Error).message),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Fix ${item.external_number ?? item.external_id}`}
      description={<span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error ?? item.error}</span>}
      submitLabel="Import again" busy={run.isPending} onSubmit={() => { setError(null); run.mutate() }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone" htmlFor="fx-phone"><Input id="fx-phone" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Name" htmlFor="fx-name"><Input id="fx-name" value={f.name} onChange={set('name')} /></Field>
      </div>
      <Field label="Address" htmlFor="fx-address"><Input id="fx-address" value={f.address} onChange={set('address')} /></Field>
      <Field label="District" hint={item.shipping.city || item.shipping.state ? `They wrote: ${[item.shipping.city, item.shipping.state].filter(Boolean).join(', ')}` : undefined}>
        <Select value={f.district} onValueChange={(v) => setF({ ...f, district: v })}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Choose district" /></SelectTrigger>
          <SelectContent className="max-h-72">{(config?.delivery.districts ?? []).map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormDialog>
  )
}

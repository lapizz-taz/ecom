import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2, Clock, Copy, Download, ExternalLink, Link2, MessageCircle, MoreHorizontal, Phone, RefreshCw, ShoppingBag, ShoppingCart, Store, TriangleAlert, UserRound,
} from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useUrlState } from '@/hooks/use-url-state'
import { calendarTime, formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  abandonedCounts, abandonedCsv, type AbandonedSyncResult, bulkShopifyAbandoned, cartRecoveryLink, fetchShopifyAbandoned, type ShopifyAbandoned, shopifyAbandoned, type ShopifyView, type StoreCart, storeCarts,
  type StoreCartView, updateShopifyAbandoned, updateStoreCart,
} from '@/services/abandoned'
import { imageUrl } from '@/services/catalog'

const PAGE_SIZE = 25

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Link copied'), () => toast.error('Could not copy — select and copy by hand'))
const itemsText = (items: Array<{ name?: string; title?: string; quantity: number }>) =>
  items.slice(0, 3).map((i) => `${i.name ?? i.title} ×${i.quantity}`).join(', ') + (items.length > 3 ? ` +${items.length - 3} more` : '')
function waLink(phone: string | null, message: string) {
  const n = phone ? waNumber(phone) : null
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : null
}

export default function AbandonedCartsPage() {
  const [state, update] = useUrlState({ src: 'store' })
  const counts = useQuery({ queryKey: ['abandoned-counts'], queryFn: abandonedCounts, refetchInterval: 60_000 })
  return (
    <div className="space-y-4">
      <PageHeader title="Abandoned Carts"
        description="Customers who put products in their cart but didn't order. Call them, send a link that brings their cart back, or create the order for them." />
      <Tabs value={state.src} onValueChange={(v) => update({ src: v })}>
        <TabsList>
          <TabsTrigger value="store"><Store /> Our store{counts.data?.store ? <Badge variant="warning" className="ml-1">{counts.data.store}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="shopify"><ShoppingBag /> Shopify{counts.data?.shopify ? <Badge variant="warning" className="ml-1">{counts.data.shopify}</Badge> : null}</TabsTrigger>
        </TabsList>
      </Tabs>
      {state.src === 'shopify' ? <ShopifySection /> : <StoreSection />}
    </div>
  )
}

// ---------------------------------------------------------------------------------- our store

function StoreSection() {
  const { can } = useAuth()
  const { data: config } = useStoreConfig()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ view: 'abandoned', q: '' })
  const [page, setPage] = useState(1)
  const [contact, setContact] = useState<StoreCart | null>(null)
  const view = state.view as StoreCartView
  const q = useQuery({ queryKey: ['store-carts', view, state.q, page], queryFn: () => storeCarts(view, state.q, page - 1, PAGE_SIZE), refetchInterval: 60_000 })
  const save = useMutation({
    mutationFn: (v: { id: string; status: 'CONTACTED' | 'DISMISSED' | 'OPEN'; note?: string }) => updateStoreCart(v.id, v.status, v.note),
    onSuccess: (_, v) => {
      toast.success(v.status === 'CONTACTED' ? 'Call saved' : v.status === 'DISMISSED' ? 'Cart dismissed' : 'Cart reopened')
      setContact(null)
      void queryClient.invalidateQueries({ queryKey: ['store-carts'] })
      void queryClient.invalidateQueries({ queryKey: ['abandoned-counts'] })
    },
  })
  const s = q.data?.stats
  const storeUrl = config?.store.website_url
  const message = (c: StoreCart) =>
    `Hi${c.customer_name ? ` ${c.customer_name.split(' ')[0]}` : ''}, you left ${itemsText(c.items)} in your cart at ${config?.store.name ?? 'our store'}. Finish your order here: ${cartRecoveryLink(c.id, storeUrl)}`

  const columns: Column<StoreCart>[] = [
    {
      key: 'cart', header: 'Cart', primary: true,
      cell: (c) => <CartItems items={c.items.map((i) => ({ name: i.name, variant: i.variant, quantity: i.quantity, image: i.image }))} />,
    },
    { key: 'value', header: 'Value', align: 'right', cell: (c) => <div><Money value={c.subtotal} className="font-medium" /><p className="text-xs text-muted-foreground">{c.item_count} item{c.item_count === 1 ? '' : 's'}</p></div> },
    {
      key: 'customer', header: 'Customer',
      cell: (c) => c.phone ? (
        <div className="max-w-44"><p className="truncate font-medium">{c.customer_name || 'No name'}</p><p className="text-xs text-muted-foreground">{c.phone}</p></div>
      ) : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><UserRound className="size-3.5" /> Anonymous visitor</span>,
    },
    {
      key: 'stage', header: 'Got to', hideOnMobile: true,
      cell: (c) => (
        <div className="space-y-1 text-xs">
          {c.status === 'CONVERTED' ? <Badge variant={c.recovered ? 'success' : 'neutral'}>{c.recovered ? 'Recovered' : 'Ordered'}</Badge>
            : c.status === 'DISMISSED' ? <Badge variant="neutral">Dismissed</Badge>
              : c.reached_checkout ? <Badge variant="info">Checkout</Badge> : <Badge variant="neutral">Cart</Badge>}
          <p className="text-muted-foreground">{c.source ?? 'Unknown'}</p>
        </div>
      ),
    },
    {
      key: 'when', header: 'Last activity',
      cell: (c) => (
        <div className="text-xs">
          <p title={formatDateTime(c.last_activity_at)}>{timeAgo(c.last_activity_at)}</p>
          {c.contacted && <p className="text-muted-foreground">Called {c.contact_count}×{c.notes ? ` · ${c.notes.split('\n').pop()?.replace(/^.*? — /, '')}` : ''}</p>}
          {c.order_id && <Link to={`/admin/orders/${c.order_id}`} className="text-brand hover:underline">Open order</Link>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (c) => {
        if (c.status === 'CONVERTED') return null
        const wa = waLink(c.phone, message(c))
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {c.phone && <Button size="icon-sm" variant="ghost" asChild><a href={`tel:${c.phone}`} aria-label="Call"><Phone /></a></Button>}
            {wa && <Button size="icon-sm" variant="ghost" asChild><a href={wa} target="_blank" rel="noreferrer" aria-label="Send the cart link on WhatsApp"><MessageCircle /></a></Button>}
            {c.phone && can('orders.create') && <Button size="sm" className="h-7" asChild><Link to={`/admin/orders/new?cart=${c.id}`} title="Create the order for them"><ShoppingCart /> Order</Link></Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => copy(cartRecoveryLink(c.id, storeUrl))}><Link2 /> Copy cart link</DropdownMenuItem>
                {can('orders.update') && <DropdownMenuItem onClick={() => setContact(c)}><Phone /> Log a call</DropdownMenuItem>}
                {can('orders.update') && <DropdownMenuSeparator />}
                {can('orders.update') && (c.status === 'DISMISSED'
                  ? <DropdownMenuItem onClick={() => save.mutate({ id: c.id, status: 'OPEN' })}>Reopen</DropdownMenuItem>
                  : <DropdownMenuItem onClick={() => save.mutate({ id: c.id, status: 'DISMISSED' })}>Dismiss</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]
  const conversion = s && s.carts_30d ? Math.round((s.converted_30d / s.carts_30d) * 100) : null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Abandoned now" value={formatNumber(s?.abandoned ?? 0)} hint={s ? `${s.abandoned_with_phone} with a phone number` : undefined} tone={s?.abandoned ? 'warning' : 'default'} />
        <StatCard label="Value left in carts" value={<Money value={s?.abandoned_value ?? 0} />} />
        <StatCard label="Recovered (30 days)" value={formatNumber(s?.recovered ?? 0)} hint={<Money value={s?.recovered_value ?? 0} />} tone="positive" />
        <StatCard label="Carts that ordered (30 days)" value={conversion === null ? '—' : `${conversion}%`} hint={s ? `${s.converted_30d} of ${s.carts_30d} carts` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={view} onValueChange={(v) => { setPage(1); update({ view: v }) }}>
              <TabsList>
                <TabsTrigger value="abandoned">Abandoned</TabsTrigger>
                <TabsTrigger value="active">Shopping now</TabsTrigger>
                <TabsTrigger value="recovered">Recovered</TabsTrigger>
                <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
            <SearchInput value={state.q} onChange={(v) => { setPage(1); update({ q: v }) }} placeholder="Phone, name or product" className="w-full sm:w-64" />
          </div>
          <DataTable columns={columns} rows={q.data?.items} rowKey={(c) => c.id} loading={q.isFetching} error={q.error} onRetry={() => q.refetch()}
            empty={<EmptyState icon={<ShoppingCart />} title={view === 'abandoned' ? 'No abandoned carts' : 'Nothing here'}
              description={view === 'abandoned' ? `A cart with no activity for ${q.data?.abandoned_after_minutes ?? 60} minutes shows up here. Change the time in Settings → Orders & operations.` : undefined} />}
            footer={<Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onPage={setPage} />} />
          <p className="text-xs text-muted-foreground">
            Anonymous carts have no phone yet — the customer left before typing it. When they reach checkout and type a number, the cart moves up with their name and phone
            (they also appear in <Link to="/admin/orders/web?tab=incomplete" className="underline">Incomplete</Link>).
          </p>
        </div>

        <Card className="h-fit">
          <CardHeader><CardTitle className="text-base">Most left behind</CardTitle><CardDescription>Products in abandoned carts, last 30 days</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {!q.data?.top_products.length && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
            {q.data?.top_products.map((p) => (
              <div key={p.product_id} className="flex items-center gap-3">
                <img src={imageUrl(p.image, 80)} alt="" className="size-10 shrink-0 rounded-md bg-muted object-cover" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.carts} cart{p.carts === 1 ? '' : 's'} · {p.quantity} pcs</p></div>
                <Money value={p.value} className="text-sm" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <ContactDialog open={!!contact} title={contact?.customer_name || contact?.phone || 'Cart'} busy={save.isPending}
        onClose={() => setContact(null)} onSave={(status, note) => contact && save.mutate({ id: contact.id, status, note })} />
    </div>
  )
}

function CartItems({ items }: { items: Array<{ name: string; variant: string | null; quantity: number; image: string | null }> }) {
  return (
    <div className="flex max-w-72 items-center gap-2">
      <div className="flex -space-x-2">
        {items.slice(0, 3).map((i, n) => (
          i.image ? <img key={n} src={imageUrl(i.image, 80)} alt="" className="size-9 rounded-md border-2 border-card bg-muted object-cover" />
            : <span key={n} className="flex size-9 items-center justify-center rounded-md border-2 border-card bg-muted"><ShoppingBag className="size-4 text-muted-foreground" /></span>
        ))}
      </div>
      <p className="line-clamp-2 min-w-0 text-xs">{items.map((i) => `${i.name}${i.variant ? ` · ${i.variant}` : ''} ×${i.quantity}`).join(', ') || '—'}</p>
    </div>
  )
}

function ContactDialog({ open, title, busy, onClose, onSave }: {
  open: boolean; title: string; busy: boolean; onClose: () => void; onSave: (status: 'CONTACTED' | 'DISMISSED', note: string) => void
}) {
  const [note, setNote] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setNote(''); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Log the call. If they want to order, use Create order — their cart comes with it.</DialogDescription>
        </DialogHeader>
        <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did they say?" aria-label="Call note" />
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={busy} onClick={() => { onSave('DISMISSED', note); setNote('') }}>Not interested</Button>
          <Button disabled={busy} onClick={() => { onSave('CONTACTED', note); setNote('') }}>{busy && <Spinner />} Save call</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------- Shopify

const SHOPIFY_PAGE = 50
const VIEWS: Array<{ value: ShopifyView; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'open', label: 'Not recovered' }, { value: 'recovered', label: 'Recovered' }, { value: 'dismissed', label: 'Dismissed' },
]

/** Like Shopify's Abandoned checkouts list: checkout, created, customer, region, recovery status, total. */
function ShopifySection() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ sview: 'all', sq: '' })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contact, setContact] = useState<ShopifyAbandoned | null>(null)
  const [importing, setImporting] = useState<{ done: number; store: string } | null>(null)
  const stop = useRef(false)
  const view = state.sview as ShopifyView
  const q = useQuery({ queryKey: ['shopify-abandoned', view, state.sq, page], queryFn: () => shopifyAbandoned(view, state.sq, page - 1, SHOPIFY_PAGE) })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['shopify-abandoned'] })
    void queryClient.invalidateQueries({ queryKey: ['abandoned-counts'] })
  }
  const save = useMutation({
    mutationFn: (v: { id: string; status: 'CONTACTED' | 'DISMISSED' | 'OPEN'; note?: string }) => updateShopifyAbandoned(v.id, v.status, v.note),
    onSuccess: (_, v) => { toast.success(v.status === 'CONTACTED' ? 'Call saved' : v.status === 'DISMISSED' ? 'Dismissed' : 'Reopened'); setContact(null); refresh() },
  })
  const bulk = useMutation({
    mutationFn: (status: 'CONTACTED' | 'DISMISSED' | 'OPEN') => bulkShopifyAbandoned([...selected], status),
    onSuccess: (n, status) => { toast.success(`${n} checkout${n === 1 ? '' : 's'} ${status === 'DISMISSED' ? 'dismissed' : status === 'CONTACTED' ? 'marked as contacted' : 'reopened'}`); setSelected(new Set()); refresh() },
  })
  const channels = [...(q.data?.channels ?? [])].sort((a, b) => Number(!!b.error) - Number(!!a.error) || Number(!!b.synced_at) - Number(!!a.synced_at))
  const s = q.data?.stats

  /** Fetch in batches until Shopify has nothing more (days null = the whole history). */
  async function runImport(days: number | null) {
    stop.current = false
    let total = 0
    const failures: string[] = []
    for (const c of channels.filter((x) => x.status !== 'DISCONNECTED')) {
      let cursor: string | null = null
      do {
        setImporting({ done: total, store: c.name || c.shop_domain })
        try {
          const r: AbandonedSyncResult = await fetchShopifyAbandoned(days, c.id, cursor)
          const res = r.channels[0]
          if (!res?.ok) { failures.push(`${c.name}: ${res?.error ?? 'failed'}`); break }
          total += res.fetched
          cursor = res.cursor
          refresh()
        } catch (error) {
          failures.push(`${c.name}: ${(error as Error).message}`)
          break
        }
      } while (cursor && !stop.current)
    }
    setImporting(null)
    refresh()
    if (failures.length) toast.error(failures[0])
    else toast.success(stop.current ? `Stopped — ${formatNumber(total)} checkouts saved so far` : `${formatNumber(total)} abandoned checkouts up to date`)
  }

  if (q.data && !channels.length) {
    return (
      <EmptyState icon={<ShoppingBag />} title="No Shopify store connected"
        description="Connect your Shopify store to see the checkouts customers started there but didn't finish."
        action={can('settings.view') ? <Button asChild><Link to="/admin/channels">Connect Shopify</Link></Button> : undefined} />
    )
  }

  const message = (a: ShopifyAbandoned) =>
    `Hi${a.customer_name ? ` ${a.customer_name.split(' ')[0]}` : ''}, you left ${itemsText(a.items)} in your cart. Finish your order here: ${a.recovery_url ?? ''}`
  const rows = q.data?.items ?? []
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const downloadCsv = (list: ShopifyAbandoned[]) => {
    const blob = new Blob(['﻿' + abandonedCsv(list)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `abandoned-checkouts-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const columns: Column<ShopifyAbandoned>[] = [
    {
      key: 'checkout', header: 'Checkout', primary: true,
      cell: (a) => (
        <div className="max-w-64">
          {a.legacy_id
            ? <a href={`https://${a.shop_domain}/admin/checkouts/${a.legacy_id}`} target="_blank" rel="noreferrer" className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{a.name ?? `#${a.legacy_id}`}</a>
            : <span className="font-medium">{a.name ?? '—'}</span>}
          <p className="truncate text-xs text-muted-foreground" title={a.items.map((i) => `${i.title} ×${i.quantity}`).join(', ')}>{itemsText(a.items) || '—'}</p>
        </div>
      ),
    },
    { key: 'created', header: 'Created', cell: (a) => <span className="text-sm whitespace-nowrap" title={formatDateTime(a.shop_created_at)}>{calendarTime(a.shop_created_at)}</span> },
    {
      key: 'customer', header: 'Customer name',
      cell: (a) => (
        <div className="max-w-48">
          <p className="truncate">{a.customer_name || a.email || <span className="text-muted-foreground">—</span>}</p>
          {(a.phone || (a.customer_name && a.email)) && <p className="truncate text-xs text-muted-foreground">{a.phone ?? a.email}</p>}
        </div>
      ),
    },
    { key: 'region', header: 'Region', hideOnMobile: true, cell: (a) => <div className="text-sm"><p>{a.country ?? '—'}</p>{(a.city || a.province) && <p className="text-xs text-muted-foreground">{a.city ?? a.province}</p>}</div> },
    {
      key: 'status', header: 'Recovery status',
      cell: (a) => (
        <div className="flex flex-col items-start gap-1">
          {a.status === 'RECOVERED' ? <Badge variant="success">Recovered</Badge> : <Badge className="border-transparent bg-orange-100 text-orange-800">Not recovered</Badge>}
          {a.status === 'OPEN' && a.follow_up !== 'NONE' && (
            <span className="text-[11px] text-muted-foreground" title={a.notes ?? undefined}>{a.follow_up === 'DISMISSED' ? 'Dismissed' : `Called ${a.contact_count}×`}</span>
          )}
        </div>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', cell: (a) => <Money value={a.total} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (a) => {
        const wa = a.recovery_url ? waLink(a.phone, message(a)) : null
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {a.phone && <Button size="icon-sm" variant="ghost" asChild><a href={`tel:${a.phone}`} aria-label="Call"><Phone /></a></Button>}
            {wa && a.status === 'OPEN' && <Button size="icon-sm" variant="ghost" asChild><a href={wa} target="_blank" rel="noreferrer" aria-label="Send the checkout link on WhatsApp"><MessageCircle /></a></Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {a.recovery_url && <DropdownMenuItem onClick={() => copy(a.recovery_url!)}><Copy /> Copy checkout link</DropdownMenuItem>}
                {a.legacy_id && <DropdownMenuItem asChild><a href={`https://${a.shop_domain}/admin/checkouts/${a.legacy_id}`} target="_blank" rel="noreferrer"><ExternalLink /> Open in Shopify</a></DropdownMenuItem>}
                {can('orders.update') && a.status === 'OPEN' && <>
                  <DropdownMenuItem onClick={() => setContact(a)}><Phone /> Log a call</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {a.follow_up === 'DISMISSED'
                    ? <DropdownMenuItem onClick={() => save.mutate({ id: a.id, status: 'OPEN' })}>Reopen</DropdownMenuItem>
                    : <DropdownMenuItem onClick={() => save.mutate({ id: a.id, status: 'DISMISSED' })}>Dismiss</DropdownMenuItem>}
                </>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Not recovered" value={formatNumber(s?.open ?? 0)} hint={s ? `${formatNumber(s.with_contact)} with phone or email` : undefined} tone={s?.open ? 'warning' : 'default'} />
        <StatCard label="Value not ordered" value={<Money value={s?.open_value ?? 0} />} />
        <StatCard label="Recovered (30 days)" value={formatNumber(s?.recovered_30d ?? 0)} hint={<Money value={s?.recovered_value_30d ?? 0} />} tone="positive" />
        <StatCard label="Abandoned (30 days)" value={formatNumber(s?.all_30d ?? 0)} />
      </div>

      <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          {channels.slice(0, 3).map((c) => <SyncLine key={c.id} name={c.name || c.shop_domain} error={c.error} at={c.synced_at} />)}
          {channels.length > 3 && <p className="text-xs text-muted-foreground">and {channels.length - 3} more store{channels.length > 4 ? 's' : ''}{channels.slice(3).some((c) => c.error) ? ' — some with errors' : ''}</p>}
          <p className="text-xs text-muted-foreground">
            {importing ? <>Importing from {importing.store}… <span className="font-medium text-foreground">{formatNumber(importing.done)}</span> saved so far — you can keep working.</>
              : 'New ones are fetched every hour. Import full history once to bring in all older abandoned checkouts.'}
          </p>
        </div>
        {importing ? (
          <Button variant="outline" size="sm" onClick={() => { stop.current = true }}><Spinner /> Stop</Button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void runImport(30)}><RefreshCw /> Fetch latest</Button>
            <Button variant="outline" size="sm" onClick={() => void runImport(null)}><Download /> Import full history</Button>
          </div>
        )}
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Select value={view} onValueChange={(v) => { setPage(1); setSelected(new Set()); update({ sview: v }) }}>
            <SelectTrigger className="h-9 w-40" aria-label="Recovery status"><SelectValue /></SelectTrigger>
            <SelectContent>{VIEWS.map((v) => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}</SelectContent>
          </Select>
          <SearchInput value={state.sq} onChange={(v) => { setPage(1); update({ sq: v }) }} placeholder="Search checkout, customer, phone, email or product" className="min-w-0 flex-1" />
          <span className="text-sm text-muted-foreground tabular-nums">{formatNumber(q.data?.total ?? 0)} checkouts</span>
        </div>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            {can('orders.update') && <>
              <Button size="sm" variant="outline" className="h-7" disabled={bulk.isPending} onClick={() => bulk.mutate('CONTACTED')}>Mark contacted</Button>
              <Button size="sm" variant="outline" className="h-7" disabled={bulk.isPending} onClick={() => bulk.mutate('DISMISSED')}>Dismiss</Button>
            </>}
            <Button size="sm" variant="outline" className="h-7" onClick={() => downloadCsv(selectedRows)}><Download /> Export CSV</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        <DataTable columns={columns} rows={rows} rowKey={(a) => a.id} loading={q.isFetching} error={q.error} onRetry={() => q.refetch()}
          selected={selected} onSelectedChange={setSelected} className="rounded-none border-0"
          empty={<EmptyState icon={<ShoppingBag />} title={view === 'all' || view === 'open' ? 'No abandoned checkouts yet' : 'Nothing here'}
            description={view === 'all' || view === 'open' ? 'Shopify counts a checkout as abandoned when the customer gave their contact details but didn\'t pay. Press Import full history to bring them in.' : undefined} />}
          footer={<Pagination page={page} pageSize={SHOPIFY_PAGE} total={q.data?.total ?? 0} onPage={(p) => { setPage(p); setSelected(new Set()) }} />} />
      </Card>

      <ContactDialog open={!!contact} title={contact?.customer_name || contact?.phone || 'Checkout'} busy={save.isPending}
        onClose={() => setContact(null)} onSave={(status, note) => contact && save.mutate({ id: contact.id, status, note })} />
    </div>
  )
}

function SyncLine({ name, error, at }: { name: string; error: string | null; at: string | null }): ReactNode {
  return (
    <p className={cn('flex items-center gap-1.5 text-sm', error && 'text-red-600')}>
      {error ? <TriangleAlert className="size-4 shrink-0" /> : at ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : <Clock className="size-4 shrink-0 text-muted-foreground" />}
      <span className="font-medium">{name}</span>
      <span className="truncate text-muted-foreground">{error ? `— ${error}` : at ? `— updated ${timeAgo(at)}` : '— not fetched yet'}</span>
    </p>
  )
}

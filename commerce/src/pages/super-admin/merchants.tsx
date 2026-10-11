import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MERCHANT_STATUS } from '@/features/platform/nav'
import { usePlatform } from '@/features/platform/platform-context'
import { StatusChangeDialog } from '@/features/platform/status-change-dialog'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatNumber, timeAgo } from '@/lib/format'
import { listMerchants, type MerchantListItem } from '@/services/platform'

const PAGE_SIZE = 25

export default function MerchantsPage() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ q: '', status: '', store: '', demo: '', sort: 'created_at', dir: 'desc', page: '1' })
  const page = Number(state.page) || 1
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<'ACTIVE' | 'SUSPENDED' | 'CLOSED' | null>(null)
  const list = useQuery({
    queryKey: ['platform-merchants', state],
    placeholderData: keepPreviousData,
    queryFn: () => listMerchants({ q: state.q, status: state.status, store: state.store, demo: state.demo }, state.sort, state.dir, page, PAGE_SIZE),
  })
  const counts = list.data?.counts ?? {}

  const columns: Column<MerchantListItem>[] = [
    {
      key: 'name', header: 'Merchant', primary: true,
      cell: (m) => (
        <div className="min-w-0">
          <Link to={`/super-admin/merchants/${m.id}`} className="font-medium hover:underline">{m.name}</Link>
          {m.is_demo && <Badge variant="violet" className="ml-2 text-[10px]">Demo</Badge>}
          <p className="truncate text-xs text-muted-foreground">#{m.number} · {m.owner_email ?? 'no owner e-mail'}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (m) => <StatusBadge value={m.status} map={MERCHANT_STATUS} /> },
    {
      key: 'onboarding', header: 'Onboarding', hideOnMobile: true,
      cell: (m) => <span className="text-xs tabular-nums text-muted-foreground">{m.onboarding.done}/{m.onboarding.total} steps</span>,
    },
    {
      key: 'stores', header: 'Stores',
      cell: (m) => m.stores ? <span className="text-xs">{m.store_platforms.map((p) => p.toLowerCase()).join(', ')}</span> : <span className="text-xs text-muted-foreground">own store / none</span>,
    },
    { key: 'orders', header: 'Orders 30 d', align: 'right', cell: (m) => <span className="tabular-nums">{formatNumber(m.orders_30d)}</span> },
    { key: 'last', header: 'Last order', hideOnMobile: true, cell: (m) => <span className="text-xs text-muted-foreground">{m.last_order_at ? timeAgo(m.last_order_at) : '—'}</span> },
    { key: 'manager', header: 'Account manager', hideOnMobile: true, cell: (m) => <span className="text-xs">{m.account_manager?.name ?? '—'}</span> },
    { key: 'created', header: 'Joined', hideOnMobile: true, cell: (m) => <span className="text-xs text-muted-foreground">{formatDate(m.created_at)}</span> },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Merchants" description="Every business on the platform. Status changes show who is affected before they happen."
        actions={can('merchants', 'create') && <Button asChild size="sm"><Link to="/super-admin/merchants/new"><Plus /> New merchant</Link></Button>} />
      <div className="flex flex-wrap gap-2">
        {(['', 'ACTIVE', 'ONBOARDING', 'SUSPENDED', 'CLOSED'] as const).map((s) => (
          <Button key={s || 'all'} size="sm" variant={state.status === s ? 'default' : 'outline'} onClick={() => update({ status: s, page: '1' })}>
            {s ? MERCHANT_STATUS[s].label : 'All'}
            {s && <span className="ml-1 tabular-nums opacity-70">{formatNumber(counts[s] ?? 0)}</span>}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q, page: '1' })} placeholder="Name, number, owner e-mail or phone" />
        <Select value={state.store || 'any'} onValueChange={(v) => update({ store: v === 'any' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any store</SelectItem>
            <SelectItem value="SHOPIFY">Shopify</SelectItem>
            <SelectItem value="WOOCOMMERCE">WooCommerce</SelectItem>
            <SelectItem value="none">No connected store</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state.demo || 'any'} onValueChange={(v) => update({ demo: v === 'any' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Real and demo</SelectItem>
            <SelectItem value="false">Real only</SelectItem>
            <SelectItem value="true">Demo only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={`${state.sort}:${state.dir}`} onValueChange={(v) => { const [sort, dir] = v.split(':'); update({ sort, dir, page: '1' }) }}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="created_at:desc">Newest first</SelectItem>
            <SelectItem value="created_at:asc">Oldest first</SelectItem>
            <SelectItem value="name:asc">Name A–Z</SelectItem>
            <SelectItem value="orders:desc">Most orders (30 d)</SelectItem>
            <SelectItem value="last_order:asc">Longest without an order</SelectItem>
            <SelectItem value="number:asc">Merchant number</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selected.size > 0 && can('merchants', 'manage') && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span>{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => setBulk('ACTIVE')}>Activate</Button>
          <Button size="sm" variant="outline" onClick={() => setBulk('SUSPENDED')}>Suspend</Button>
          <Button size="sm" variant="outline" onClick={() => setBulk('CLOSED')}>Close…</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={list.data?.items}
        rowKey={(m) => m.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        rowHref={(m) => `/super-admin/merchants/${m.id}`}
        selected={can('merchants', 'manage') ? selected : undefined}
        onSelectedChange={can('merchants', 'manage') ? setSelected : undefined}
        footer={list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => update({ page: String(p) })} />}
      />
      {bulk && (
        <StatusChangeDialog ids={[...selected]} status={bulk} open onOpenChange={(o) => !o && setBulk(null)}
          onDone={() => { setSelected(new Set()); void queryClient.invalidateQueries({ queryKey: ['platform-merchants'] }) }} />
      )}
    </div>
  )
}

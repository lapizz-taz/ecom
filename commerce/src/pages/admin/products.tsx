import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Columns3, ExternalLink, Filter, Minus, Package, Pencil, Plus, Trash2, Wallet, Boxes, Coins } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatMoney, formatNumber, slugify, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type AdminProductFilters, type AdminProductRow, deleteCategory, imageUrl, listAdminProducts, listCategories, productStats, quickUpdateProduct, saveCategory,
} from '@/services/catalog'
import { adjustStock, listStock } from '@/services/inventory'
import type { Tables } from '@/types/database'

const PAGE_SIZE = 25

export default function ProductsPage() {
  const [state, update] = useUrlState({ tab: 'products' })
  const stats = useQuery({ queryKey: ['product-stats'], queryFn: productStats })
  const s = stats.data
  return (
    <div className="space-y-4">
      <PageHeader title="Products" description="Everything you sell, its stock and what it earns."
        actions={<Can permission="products.manage"><Button size="sm" asChild><Link to="/admin/products/new"><Plus /> Add product</Link></Button></Can>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Products" icon={<Package />} value={s ? formatNumber(s.products) : '—'} hint={s ? `${formatNumber(s.active)} active · ${formatNumber(s.variants)} variants` : undefined} />
        <StatCard label="Stock" icon={<Boxes />} value={s ? formatNumber(s.stock) : '—'} hint={s?.low_stock ? `${s.low_stock} running low` : 'Units on hand'} />
        <StatCard label="Sell value" icon={<Coins />} value={s ? formatMoney(s.sell_value) : '—'} hint="Stock × selling price" />
        <StatCard label="Cost value" icon={<Wallet />} value={s ? formatMoney(s.cost_value) : '—'} hint="Stock × cost price" />
      </div>
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab }, { resetPage: false })}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="inactive">Inactive products{s?.inactive ? <span className="ml-1 text-muted-foreground">{s.inactive}</span> : null}</TabsTrigger>
          <TabsTrigger value="variations">Variations</TabsTrigger>
          <TabsTrigger value="categories">Categories & brands</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="animate-in fade-in-0 duration-300"><ProductList statuses={['ACTIVE']} /></TabsContent>
        <TabsContent value="inactive" className="animate-in fade-in-0 duration-300"><ProductList statuses={['DRAFT', 'ARCHIVED']} /></TabsContent>
        <TabsContent value="variations" className="animate-in fade-in-0 duration-300"><VariationList /></TabsContent>
        <TabsContent value="categories" className="animate-in fade-in-0 duration-300"><CategoryManager /></TabsContent>
      </Tabs>
    </div>
  )
}

const COLUMNS = [
  { key: 'code', label: 'Code' },
  { key: 'manage', label: 'Manage stock' },
  { key: 'cost', label: 'Cost price' },
  { key: 'stock', label: 'Stock qty' },
  { key: 'price', label: 'Selling price' },
  { key: 'active', label: 'Active' },
] as const
type ColKey = (typeof COLUMNS)[number]['key']
const SORTS: Array<{ value: NonNullable<AdminProductFilters['sort']>; label: string }> = [
  { value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'name', label: 'Name A–Z' },
  { value: 'price_desc', label: 'Price: high to low' }, { value: 'price_asc', label: 'Price: low to high' }, { value: 'cost_desc', label: 'Cost: high to low' },
]

function useHiddenColumns() {
  const [hidden, setHidden] = useState<Set<ColKey>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('products.hidden-columns') ?? '[]') as ColKey[]) } catch { return new Set() }
  })
  const toggle = (k: ColKey) => setHidden((h) => {
    const next = new Set(h)
    if (next.has(k)) next.delete(k); else next.add(k)
    try { localStorage.setItem('products.hidden-columns', JSON.stringify([...next])) } catch { /* private mode */ }
    return next
  })
  return [hidden, toggle] as const
}

function ProductList({ statuses }: { statuses: Array<Tables<'products'>['status']> }) {
  const { can } = useAuth()
  const manage = can('products.manage')
  const adjust = can('inventory.adjust')
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ q: '', category: '', sort: 'newest', page: '1' })
  const page = Number(state.page) || 1
  const [hidden, toggleColumn] = useHiddenColumns()
  const show = (k: ColKey) => !hidden.has(k)
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const key = ['products', 'admin', statuses.join(','), state]
  const products = useQuery({
    queryKey: key,
    placeholderData: keepPreviousData,
    queryFn: () => listAdminProducts({ q: state.q, statuses, categoryId: state.category || undefined, sort: state.sort as never, page, pageSize: PAGE_SIZE }),
  })
  const catName = new Map((categories.data ?? []).map((c) => [c.id, c.name]))

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] })
    void queryClient.invalidateQueries({ queryKey: ['product-stats'] })
  }
  const patchRow = (id: string, patch: Partial<AdminProductRow>) =>
    queryClient.setQueryData<{ items: AdminProductRow[]; total: number }>(key, (d) => d && { ...d, items: d.items.map((r) => (r.id === id ? { ...r, ...patch } : r)) })

  const quick = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Parameters<typeof quickUpdateProduct>[1]; label: string }) => quickUpdateProduct(id, changes),
    onMutate: ({ id, changes }) => patchRow(id, {
      ...(changes.cost_price !== undefined && { cost_price: changes.cost_price }),
      ...(changes.price !== undefined && { price: changes.price }),
      ...(changes.track_inventory !== undefined && { track_inventory: changes.track_inventory }),
      ...(changes.active !== undefined && { status: changes.active ? 'ACTIVE' : 'ARCHIVED' }),
    }),
    onSuccess: (_r, v) => { toast.success(v.label); refresh() },
    onError: (err) => { toast.error(toUserMessage(err)); refresh() },
  })

  const filtersOn = Boolean(state.category)
  const rows = products.data?.items

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search name or code" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className={cn(filtersOn && 'border-foreground')}><Filter /> Filter{filtersOn && ' · 1'}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuLabel>Category</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={state.category || 'all'} onValueChange={(v) => update({ category: v === 'all' ? '' : v })}>
              <DropdownMenuRadioItem value="all">All categories</DropdownMenuRadioItem>
              {(categories.data ?? []).map((c) => <DropdownMenuRadioItem key={c.id} value={c.id}>{c.name}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><ArrowDownUp /> Sort</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={state.sort} onValueChange={(sort) => update({ sort })}>
              {SORTS.map((o) => <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Columns3 /> Columns</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {COLUMNS.map((c) => <DropdownMenuCheckboxItem key={c.key} checked={show(c.key)} onCheckedChange={() => toggleColumn(c.key)} onSelect={(ev) => ev.preventDefault()}>{c.label}</DropdownMenuCheckboxItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {products.isFetching && !products.isLoading && <Spinner className="size-4 text-muted-foreground" />}
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {products.isLoading ? <div className="p-4"><TableSkeleton rows={6} /></div>
          : products.error ? <ErrorState error={products.error} onRetry={() => products.refetch()} />
            : !rows?.length ? <EmptyState title={statuses.includes('ACTIVE') ? 'No products yet' : 'No inactive products'}
              action={statuses.includes('ACTIVE') && manage ? <Button asChild size="sm"><Link to="/admin/products/new">Add your first product</Link></Button> : undefined} />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                        {show('code') && <th className="px-3 py-2.5">Code</th>}
                        <th className="px-3 py-2.5">Product</th>
                        {show('manage') && <th className="px-3 py-2.5 text-center">Manage stock</th>}
                        {show('cost') && <th className="px-3 py-2.5 text-right">Cost price</th>}
                        {show('stock') && <th className="px-3 py-2.5 text-center">Stock qty</th>}
                        {show('price') && <th className="px-3 py-2.5 text-right">Selling price</th>}
                        {show('active') && <th className="px-3 py-2.5 text-center">Active</th>}
                        <th className="px-3 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => {
                        const img = [...p.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position)[0]
                        const active = p.product_variants.filter((v) => v.is_active)
                        const cats = [p.categories?.name, ...(p.extra_category_ids ?? []).map((id) => catName.get(id))].filter(Boolean) as string[]
                        const excerpt = (p.short_description || p.description || '').replace(/\s+/g, ' ').trim()
                        return (
                          <tr key={p.id} className="border-b transition-colors last:border-0 hover:bg-muted/30">
                            {show('code') && <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{p.sku ?? active[0]?.sku ?? '—'}</td>}
                            <td className="max-w-[320px] px-3 py-2.5">
                              <Link to={`/admin/products/${p.id}`} className="flex items-center gap-3">
                                {img ? <img src={imageUrl(img.url, 80)} alt="" className="size-10 shrink-0 rounded-md bg-muted object-cover" />
                                  : <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Package className="size-4" /></span>}
                                <span className="min-w-0">
                                  <span className="block truncate font-medium hover:underline">{p.name}</span>
                                  {cats.length > 0 && (
                                    <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                                      <span className="truncate">{cats[0]}</span>{cats.length > 1 && <span className="rounded bg-muted px-1">+{cats.length - 1}</span>}
                                    </span>
                                  )}
                                  {excerpt && <span className="block truncate text-xs text-muted-foreground">{excerpt}</span>}
                                </span>
                              </Link>
                            </td>
                            {show('manage') && (
                              <td className="px-3 py-2.5 text-center">
                                <Switch checked={p.track_inventory} disabled={!manage} aria-label="Manage stock"
                                  onCheckedChange={(v) => quick.mutate({ id: p.id, changes: { track_inventory: v }, label: v ? 'Stock is counted for this product' : 'Stock is no longer counted' })} />
                              </td>
                            )}
                            {show('cost') && (
                              <td className="px-3 py-2.5 text-right">
                                <InlineMoney value={toNumber(p.cost_price)} disabled={!manage} label="Cost price"
                                  onSave={(v) => quick.mutate({ id: p.id, changes: { cost_price: v }, label: 'Cost price updated' })} />
                              </td>
                            )}
                            {show('stock') && (
                              <td className="px-3 py-2.5">
                                <StockCell product={p} canAdjust={adjust} onDone={refresh} />
                              </td>
                            )}
                            {show('price') && (
                              <td className="px-3 py-2.5 text-right">
                                <InlineMoney value={toNumber(p.price)} disabled={!manage} label="Selling price" strong
                                  onSave={(v) => quick.mutate({ id: p.id, changes: { price: v }, label: 'Selling price updated' })} />
                                {p.compare_at_price && toNumber(p.compare_at_price) > toNumber(p.price) && (
                                  <span className="block text-[11px] text-muted-foreground line-through">{formatMoney(p.compare_at_price)}</span>
                                )}
                              </td>
                            )}
                            {show('active') && (
                              <td className="px-3 py-2.5 text-center">
                                <Switch checked={p.status === 'ACTIVE'} disabled={!manage} aria-label="Active"
                                  onCheckedChange={(v) => quick.mutate({ id: p.id, changes: { active: v }, label: v ? `${p.name} is live` : `${p.name} is hidden from the store` })} />
                                {p.status === 'DRAFT' && <span className="block text-[10px] text-muted-foreground">draft</span>}
                              </td>
                            )}
                            <td className="px-3 py-2.5">
                              <div className="flex justify-end gap-0.5">
                                <Button size="icon-sm" variant="ghost" asChild><Link to={`/admin/products/${p.id}`} aria-label={`Edit ${p.name}`}><Pencil /></Link></Button>
                                {p.status === 'ACTIVE' && <Button size="icon-sm" variant="ghost" asChild><a href={`/product/${p.slug}`} target="_blank" rel="noreferrer" aria-label="View on store"><ExternalLink /></a></Button>}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        {!!rows?.length && (
          <div className="border-t px-3 py-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={products.data?.total ?? 0} onPage={(n) => update({ page: String(n) }, { resetPage: false })} />
          </div>
        )}
      </Card>
    </div>
  )
}

/** Underlined amount; click to edit, Enter or leaving the box saves, Esc cancels. */
function InlineMoney({ value, onSave, disabled, label, strong }: { value: number; onSave: (v: number) => void; disabled?: boolean; label: string; strong?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) ref.current?.select() }, [editing])
  const commit = () => {
    setEditing(false)
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n) || n < 0) return
    if (Math.round(n * 100) !== Math.round(value * 100)) onSave(Math.round(n * 100) / 100)
  }
  if (disabled) return <span className={cn('tabular-nums', strong && 'font-medium')}>{formatMoney(value)}</span>
  return editing ? (
    <input ref={ref} type="number" min="0" step="0.01" value={draft} aria-label={label}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
      className="h-7 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums outline-none ring-ring/50 focus:ring-2 animate-in fade-in-0 zoom-in-95 duration-150" />
  ) : (
    <button type="button" onClick={() => { setDraft(String(value)); setEditing(true) }} title={`Edit ${label.toLowerCase()}`}
      className={cn('tabular-nums underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground', strong && 'font-medium')}>
      {formatMoney(value)}
    </button>
  )
}

/** − / + for single-variant products (each tap is a recorded stock adjustment). */
function StockCell({ product, canAdjust, onDone }: { product: AdminProductRow; canAdjust: boolean; onDone: () => void }) {
  const active = product.product_variants.filter((v) => v.is_active)
  const onHand = active.reduce((s, v) => s + (v.inventory?.on_hand ?? 0), 0)
  const available = active.reduce((s, v) => s + (v.inventory?.available ?? 0), 0)
  const [shown, setShown] = useState(onHand)
  useEffect(() => setShown(onHand), [onHand])
  const low = available <= (product.low_stock_threshold ?? 5)
  const step = useMutation({
    mutationFn: (dir: 1 | -1) => adjustStock({ variantId: active[0].id, type: 'ADJUSTMENT', quantity: 1, mode: dir > 0 ? 'ADD' : 'REMOVE', note: 'Quick adjust from product list' }),
    onMutate: (dir) => setShown((n) => Math.max(0, n + dir)),
    onSuccess: onDone,
    onError: (err) => { toast.error(toUserMessage(err)); setShown(onHand) },
  })
  if (!product.track_inventory) return <p className="text-center text-xs text-muted-foreground">Not counted</p>
  if (active.length !== 1) {
    return (
      <div className="text-center">
        <p className={cn('font-medium tabular-nums', low && 'underline decoration-foreground/40')}>{formatNumber(onHand)}</p>
        <Link to={`/admin/products/${product.id}`} className="text-[11px] text-muted-foreground hover:underline">{active.length} variants</Link>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center gap-1">
      {canAdjust && <Button size="icon-sm" variant="outline" className="size-6" disabled={shown <= 0 || step.isPending} onClick={() => step.mutate(-1)} aria-label="One less"><Minus className="size-3" /></Button>}
      <span key={shown} className={cn('min-w-9 text-center font-medium tabular-nums animate-in fade-in-0 zoom-in-90 duration-200', shown <= 0 && 'text-muted-foreground', low && shown > 0 && 'underline decoration-foreground/40')}>{formatNumber(shown)}</span>
      {canAdjust && <Button size="icon-sm" variant="outline" className="size-6" disabled={step.isPending} onClick={() => step.mutate(1)} aria-label="One more"><Plus className="size-3" /></Button>}
    </div>
  )
}

function VariationList() {
  const [state, update] = useUrlState({ vq: '', vpage: '1' })
  const page = Number(state.vpage) || 1
  const rows = useQuery({
    queryKey: ['inventory', 'variations', state],
    placeholderData: keepPreviousData,
    queryFn: () => listStock({ q: state.vq, page, pageSize: PAGE_SIZE, all: true }),
  })
  return (
    <div className="space-y-3">
      <SearchInput value={state.vq} onChange={(vq) => update({ vq, vpage: '1' }, { resetPage: false })} placeholder="Search product or SKU" />
      <Card className="gap-0 overflow-hidden py-0">
        {rows.isLoading ? <div className="p-4"><TableSkeleton rows={6} /></div>
          : rows.error ? <ErrorState error={rows.error} onRetry={() => rows.refetch()} />
            : !rows.data?.items.length ? <EmptyState title="No variations" />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead><tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                      <th className="px-3 py-2.5">SKU</th><th className="px-3 py-2.5">Product</th><th className="px-3 py-2.5">Variation</th>
                      <th className="px-3 py-2.5 text-right">Cost</th><th className="px-3 py-2.5 text-right">Price</th>
                      <th className="px-3 py-2.5 text-right">On hand</th><th className="px-3 py-2.5 text-right">Available</th>
                    </tr></thead>
                    <tbody>
                      {rows.data.items.map((v) => (
                        <tr key={v.variant_id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{v.sku}</td>
                          <td className="px-3 py-2.5"><Link to={`/admin/products/${v.product_id}`} className="font-medium hover:underline">{v.product_name}</Link></td>
                          <td className="px-3 py-2.5">{v.variant_title}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatMoney(v.unit_cost)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(v.unit_price)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(v.on_hand)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatNumber(v.available)}{v.stock_status && v.stock_status !== 'IN_STOCK' && <Badge variant="neutral" className="ml-1.5">{String(v.stock_status).replace('_', ' ').toLowerCase()}</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        {!!rows.data?.items.length && (
          <div className="border-t px-3 py-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={rows.data.total} onPage={(n) => update({ vpage: String(n) }, { resetPage: false })} />
          </div>
        )}
      </Card>
    </div>
  )
}

function CategoryManager() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const [editing, setEditing] = useState<Partial<Tables<'categories'>> | null>(null)
  const save = useMutation({
    mutationFn: () => saveCategory({
      id: editing?.id, name: editing?.name ?? '', slug: editing?.slug || slugify(editing?.name ?? ''), description: editing?.description ?? null,
      parent_id: editing?.parent_id ?? null, image_url: editing?.image_url ?? null, sort_order: editing?.sort_order ?? 0, is_active: editing?.is_active ?? true,
    }),
    onSuccess: () => { toast.success('Category saved'); setEditing(null); void queryClient.invalidateQueries({ queryKey: ['categories'] }) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteCategory(id),
    onSuccess: () => { toast.success('Category deleted'); void queryClient.invalidateQueries({ queryKey: ['categories'] }) },
  })
  return (
    <Card>
      <CardContent className="space-y-3">
        {can('products.manage') && <Button size="sm" onClick={() => setEditing({ is_active: true, sort_order: 0 })}><Plus /> Add category</Button>}
        <ul className="divide-y">
          {(categories.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <p className="font-medium">{c.name} {!c.is_active && <Badge variant="neutral">hidden</Badge>}</p>
                <p className="text-xs text-muted-foreground">/collection/{c.slug}{c.parent_id ? ` · in ${categories.data?.find((p) => p.id === c.parent_id)?.name}` : ''}</p>
              </div>
              {can('products.manage') && (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => confirm(`Delete ${c.name}? Products keep existing without a category.`) && remove.mutate(c.id)} aria-label={`Delete ${c.name}`}><Trash2 /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? 'Edit category' : 'New category'}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <Field label="Name" htmlFor="c-name"><Input id="c-name" value={editing?.name ?? ''} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} /></Field>
            <Field label="URL handle" htmlFor="c-slug" hint="Leave empty to generate from the name"><Input id="c-slug" value={editing?.slug ?? ''} onChange={(e) => setEditing((c) => ({ ...c, slug: slugify(e.target.value) }))} /></Field>
            <Field label="Parent category">
              <Select value={editing?.parent_id ?? 'none'} onValueChange={(v) => setEditing((c) => ({ ...c, parent_id: v === 'none' ? null : v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(categories.data ?? []).filter((c) => c.id !== editing?.id).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Description" htmlFor="c-desc"><Textarea id="c-desc" rows={2} value={editing?.description ?? ''} onChange={(e) => setEditing((c) => ({ ...c, description: e.target.value }))} /></Field>
            <Field label="Image URL" htmlFor="c-img"><Input id="c-img" value={editing?.image_url ?? ''} onChange={(e) => setEditing((c) => ({ ...c, image_url: e.target.value || null }))} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sort order" htmlFor="c-sort"><Input id="c-sort" type="number" value={editing?.sort_order ?? 0} onChange={(e) => setEditing((c) => ({ ...c, sort_order: Number(e.target.value) }))} /></Field>
              <label className="flex items-center gap-2 pt-6 text-sm"><Switch checked={editing?.is_active ?? true} onCheckedChange={(v) => setEditing((c) => ({ ...c, is_active: v }))} /> Visible</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!editing?.name || save.isPending}>{save.isPending && <Spinner />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

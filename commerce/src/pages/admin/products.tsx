import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Columns3, ExternalLink, Eye, EyeOff, Filter, Minus, Package, PackagePlus, Pencil, Plus, SlidersHorizontal, Trash2, Wallet, Boxes, Coins, X } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
  type AdminProductFilters, type AdminProductRow, bulkUpdateProducts, deleteCategory, imageUrl, listAdminProducts, listCategories, productStats, quickUpdateProduct, saveCategory,
} from '@/services/catalog'
import { adjustStock, bulkAdjustStock, listStock } from '@/services/inventory'
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
  // Ticked products (this page). Cleared when the page, search or filter changes.
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<'stock' | 'edit' | null>(null)
  const selKey = JSON.stringify([statuses, state])
  useEffect(() => setSel(new Set()), [selKey])
  const canBulk = manage || adjust
  const picked = (rows ?? []).filter((r) => sel.has(r.id))
  const allOn = !!rows?.length && rows.every((r) => sel.has(r.id))
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const bulkStatus = useMutation({
    mutationFn: (active: boolean) => bulkUpdateProducts([...sel], { active }),
    onSuccess: (r, active) => { toast.success(`${r.updated} product${r.updated === 1 ? '' : 's'} ${active ? 'active' : 'inactive'}`); setSel(new Set()); refresh() },
    onError: (err) => toast.error(toUserMessage(err)),
  })

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

      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <span className="font-medium">{sel.size} selected</span>
          {adjust && <Button size="sm" onClick={() => setBulk('stock')}><PackagePlus /> Add stock</Button>}
          {manage && <>
            <Button size="sm" variant="outline" onClick={() => setBulk('edit')}><SlidersHorizontal /> Edit price, cost, category</Button>
            <Button size="sm" variant="outline" disabled={bulkStatus.isPending} onClick={() => bulkStatus.mutate(true)}><Eye /> Active</Button>
            <Button size="sm" variant="outline" disabled={bulkStatus.isPending} onClick={() => bulkStatus.mutate(false)}><EyeOff /> Inactive</Button>
          </>}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}><X /> Clear</Button>
        </div>
      )}

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
                        {canBulk && <th className="w-10 px-3 py-2.5"><Checkbox checked={allOn} onCheckedChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all on this page" /></th>}
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
                          <tr key={p.id} className={cn('border-b transition-colors last:border-0 hover:bg-muted/30', sel.has(p.id) && 'bg-muted/40')}>
                            {canBulk && <td className="px-3 py-2.5"><Checkbox checked={sel.has(p.id)} onCheckedChange={() => toggle(p.id)} aria-label={`Select ${p.name}`} /></td>}
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
      {bulk === 'stock' && <BulkStockDialog products={picked} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel(new Set()); refresh() }} />}
      {bulk === 'edit' && <BulkEditDialog products={picked} categories={categories.data ?? []} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel(new Set()); refresh() }} />}
    </div>
  )
}

type StockMode = 'ADD' | 'REMOVE' | 'SET'
const MODE_LABEL: Record<StockMode, string> = { ADD: 'Add', REMOVE: 'Remove', SET: 'Set to' }

/** Stock for many products at once: one box per variant, or one number for all. Saved together (all or nothing). */
function BulkStockDialog({ products, onClose, onDone }: { products: AdminProductRow[]; onClose: () => void; onDone: () => void }) {
  const lines = products.filter((p) => p.track_inventory).flatMap((p) => p.product_variants.filter((v) => v.is_active).map((v) => ({
    id: v.id, name: p.name, variant: v.title && v.title !== 'Default' ? v.title : null, sku: v.sku, onHand: v.inventory?.on_hand ?? 0,
  })))
  const skipped = products.filter((p) => !p.track_inventory).length
  const [mode, setMode] = useState<StockMode>('ADD')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [note, setNote] = useState('Stock received')
  const fillAll = (v: string) => setQty(Object.fromEntries(lines.map((l) => [l.id, v])))
  const items = lines.flatMap((l) => {
    const raw = (qty[l.id] ?? '').trim()
    const n = Number(raw)
    return raw === '' || !Number.isInteger(n) || n < 0 || (n === 0 && mode !== 'SET') ? [] : [{ variantId: l.id, quantity: n, mode }]
  })
  const after = (l: (typeof lines)[number]) => {
    const raw = (qty[l.id] ?? '').trim()
    if (raw === '' || !Number.isFinite(Number(raw))) return null
    const n = Math.max(0, Math.trunc(Number(raw)))
    return mode === 'ADD' ? l.onHand + n : mode === 'REMOVE' ? Math.max(0, l.onHand - n) : n
  }
  const save = useMutation({
    mutationFn: () => bulkAdjustStock(items, note.trim()),
    onSuccess: (r) => { toast.success(`Stock updated for ${r.changed} variant${r.changed === 1 ? '' : 's'}`); onDone() },
    onError: (err) => toast.error(toUserMessage(err)),
  })
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Stock for {products.length} product{products.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>Every change is recorded in the stock history and sent to your store. If one line fails, nothing is saved.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5">
            {(Object.keys(MODE_LABEL) as StockMode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={cn('rounded-md px-3 py-1 text-sm transition-colors', mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{MODE_LABEL[m]}</button>
            ))}
          </div>
          <Input type="number" min="0" inputMode="numeric" placeholder="Same for all" className="h-8 w-32" onChange={(e) => fillAll(e.target.value)} aria-label="Same number for every variant" />
        </div>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border text-sm">
          {lines.map((l) => {
            const a = after(l)
            return (
              <li key={l.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.name}{l.variant && <span className="font-normal text-muted-foreground"> · {l.variant}</span>}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{l.sku ?? '—'}</span>
                </span>
                <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">{l.onHand}{a !== null && <> → <b className="text-foreground">{a}</b></>}</span>
                <Input type="number" min="0" inputMode="numeric" value={qty[l.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                  className="h-8 w-20 text-right" aria-label={`${MODE_LABEL[mode]} for ${l.name}${l.variant ? ` ${l.variant}` : ''}`} />
              </li>
            )
          })}
          {!lines.length && <li className="px-3 py-6 text-center text-muted-foreground">None of these products count stock.</li>}
        </ul>
        {skipped > 0 && <p className="text-xs text-muted-foreground">{skipped} product{skipped === 1 ? ' does' : 's do'} not count stock and {skipped === 1 ? 'is' : 'are'} left out.</p>}
        <Field label="Note" hint="Shown in the stock history">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!items.length || note.trim().length < 2 || save.isPending}>
            {save.isPending && <Spinner />} Save {items.length || ''} change{items.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Price, cost, category and stock counting for many products at once. Empty fields are left as they are. */
function BulkEditDialog({ products, categories, onClose, onDone }: {
  products: AdminProductRow[]; categories: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void
}) {
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [category, setCategory] = useState('keep')
  const [track, setTrack] = useState('keep')
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
  const bad = [price, cost].some((v) => v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0))
  const changes = {
    ...(num(price) !== undefined && { price: num(price) }),
    ...(num(cost) !== undefined && { cost_price: num(cost) }),
    ...(category !== 'keep' && { category_id: category === 'none' ? null : category }),
    ...(track !== 'keep' && { track_inventory: track === 'on' }),
  }
  const save = useMutation({
    mutationFn: () => bulkUpdateProducts(products.map((p) => p.id), changes),
    onSuccess: (r) => { toast.success(`${r.updated} product${r.updated === 1 ? '' : 's'} updated`); onDone() },
    onError: (err) => toast.error(toUserMessage(err)),
  })
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {products.length} product{products.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>Only the fields you fill in change. Products with several variants keep each variant's own price.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Selling price"><Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Keep" /></Field>
          <Field label="Cost price"><Input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Keep" /></Field>
          <Field label="Category">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">Keep</SelectItem>
                <SelectItem value="none">No category</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Count stock">
            <Select value={track} onValueChange={setTrack}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">Keep</SelectItem>
                <SelectItem value="on">Yes, count stock</SelectItem>
                <SelectItem value="off">No</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={bad || !Object.keys(changes).length || save.isPending}>{save.isPending && <Spinner />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

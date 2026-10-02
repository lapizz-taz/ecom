import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber, slugify } from '@/lib/format'
import {
  type AdminProductRow, deleteCategory, imageUrl, listAdminProducts, listCategories, saveCategory,
} from '@/services/catalog'
import type { Tables } from '@/types/database'

const PAGE_SIZE = 25
const STATUS_VARIANT = { ACTIVE: 'success', DRAFT: 'neutral', ARCHIVED: 'secondary' } as const

export default function ProductsPage() {
  const [tab, setTab] = useState('products')
  return (
    <div className="space-y-4">
      <PageHeader title="Products" actions={<Can permission="products.manage"><Button size="sm" asChild><Link to="/admin/products/new"><Plus /> Add product</Link></Button></Can>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="products">Products</TabsTrigger><TabsTrigger value="categories">Categories</TabsTrigger></TabsList>
        <TabsContent value="products"><ProductList /></TabsContent>
        <TabsContent value="categories"><CategoryManager /></TabsContent>
      </Tabs>
    </div>
  )
}

function ProductList() {
  const [state, update] = useUrlState({ q: '', status: '', category: '', page: '1' })
  const page = Number(state.page) || 1
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const products = useQuery({
    queryKey: ['products', 'admin', state],
    placeholderData: keepPreviousData,
    queryFn: () => listAdminProducts({ q: state.q, status: state.status as never, categoryId: state.category || undefined, page, pageSize: PAGE_SIZE }),
  })

  const columns: Column<AdminProductRow>[] = [
    {
      key: 'product', header: 'Product', primary: true,
      cell: (p) => {
        const img = [...p.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position)[0]
        return (
          <div className="flex items-center gap-3">
            {img ? <img src={imageUrl(img.url, 80)} alt="" className="size-10 rounded-md bg-muted object-cover" /> : <div className="size-10 rounded-md bg-muted" />}
            <div className="min-w-0"><p className="truncate font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.sku ?? p.product_variants[0]?.sku}</p></div>
          </div>
        )
      },
    },
    { key: 'status', header: 'Status', cell: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{p.status.toLowerCase()}</Badge> },
    { key: 'category', header: 'Category', hideOnMobile: true, cell: (p) => p.categories?.name ?? <span className="text-muted-foreground">—</span> },
    {
      key: 'stock', header: 'Stock',
      cell: (p) => {
        if (!p.track_inventory) return <span className="text-muted-foreground">Made to order</span>
        const active = p.product_variants.filter((v) => v.is_active)
        const available = active.reduce((s, v) => s + (v.inventory?.available ?? 0), 0)
        return <span className={available <= 0 ? 'text-red-600' : ''}>{formatNumber(available)} available{active.length > 1 ? ` · ${active.length} variants` : ''}</span>
      },
    },
    { key: 'price', header: 'Price', align: 'right', cell: (p) => <Money value={p.price} /> },
    { key: 'cost', header: 'Cost', align: 'right', hideOnMobile: true, cell: (p) => <Money value={p.cost_price} muted /> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search name or SKU" />
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem><SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem><SelectItem value="ARCHIVED">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state.category || 'all'} onValueChange={(v) => update({ category: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={products.data?.items} rowKey={(p) => p.id} loading={products.isFetching} error={products.error}
        onRetry={() => products.refetch()} rowHref={(p) => `/admin/products/${p.id}`}
        empty={<EmptyState title="No products yet" action={<Can permission="products.manage"><Button asChild size="sm"><Link to="/admin/products/new">Add your first product</Link></Button></Can>} />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={products.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
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

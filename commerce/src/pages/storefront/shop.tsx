import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useParams } from 'react-router'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ProductGrid } from '@/features/storefront/product-card'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber } from '@/lib/format'
import { getCategories, listProducts } from '@/services/storefront'

const PAGE_SIZE = 24
const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'featured', label: 'Featured' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'name', label: 'Name' },
]

export default function ShopPage() {
  const { slug } = useParams()
  const [state, update] = useUrlState({ q: '', sort: 'newest', min: '', max: '', stock: '', tag: '', page: '1' })
  const page = Number(state.page) || 1
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const category = categories.data?.find((c) => c.slug === slug)

  const products = useQuery({
    queryKey: ['products', slug, state],
    placeholderData: keepPreviousData,
    queryFn: () => listProducts({
      category: slug,
      search: state.q || undefined,
      sort: state.sort,
      minPrice: state.min ? Number(state.min) : undefined,
      maxPrice: state.max ? Number(state.max) : undefined,
      inStock: state.stock === '1',
      tag: state.tag || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  })

  const title = slug ? category?.name ?? 'Collection' : state.q ? `Results for “${state.q}”` : 'Shop all'
  const total = products.data?.total ?? 0
  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {category?.description && <p className="mt-1 text-muted-foreground">{category.description}</p>}
        {state.tag && <p className="mt-1 text-sm text-muted-foreground">Tagged “{state.tag}” · <button className="underline" onClick={() => update({ tag: '' })}>clear</button></p>}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3 border-b pb-4">
        <SlidersHorizontal className="mb-2 size-4 text-muted-foreground" />
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">Sort</Label>
          <Select value={state.sort} onValueChange={(v) => update({ sort: v })}>
            <SelectTrigger className="w-44" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">Price</Label>
          <div className="flex items-center gap-1">
            <Input className="h-8 w-20" inputMode="numeric" placeholder="Min" defaultValue={state.min} onBlur={(e) => update({ min: e.target.value })} aria-label="Minimum price" />
            <span className="text-muted-foreground">–</span>
            <Input className="h-8 w-20" inputMode="numeric" placeholder="Max" defaultValue={state.max} onBlur={(e) => update({ max: e.target.value })} aria-label="Maximum price" />
          </div>
        </div>
        <label className="mb-1.5 flex items-center gap-2 text-sm">
          <Switch checked={state.stock === '1'} onCheckedChange={(v) => update({ stock: v ? '1' : '' })} /> In stock only
        </label>
        <span className="mb-1.5 ml-auto text-sm text-muted-foreground">{formatNumber(total)} products</span>
      </div>

      {products.error ? (
        <ErrorState error={products.error} onRetry={() => products.refetch()} />
      ) : !products.isLoading && total === 0 ? (
        <EmptyState title="No products found" description="Try a different search or remove some filters." />
      ) : (
        <ProductGrid products={products.data?.items} loading={products.isLoading} />
      )}

      {pages > 1 && (
        <div className="mt-10 flex items-center justify-center gap-2">
          <Button variant="outline" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, { resetPage: false })}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
          <Button variant="outline" disabled={page >= pages} onClick={() => update({ page: String(page + 1) }, { resetPage: false })}>Next</Button>
        </div>
      )}
    </div>
  )
}

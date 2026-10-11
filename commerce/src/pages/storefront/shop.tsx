import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, LayoutGrid, SlidersHorizontal, Square } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { ProductGrid } from '@/features/storefront/product-card'
import { SectionFrame } from '@/features/storefront/sections'
import { useStoreTheme } from '@/features/storefront/theme-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { getCategories, listProducts } from '@/services/storefront'

const PAGE_SIZE = 24
const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'featured', label: 'Featured' },
  { value: 'price_asc', label: 'Price, low to high' },
  { value: 'price_desc', label: 'Price, high to low' },
  { value: 'name', label: 'Alphabetically, A–Z' },
]

/** A collection (category), search results or all products: banner, filter bar and grid. */
export default function ShopPage() {
  const { slug } = useParams()
  const theme = useStoreTheme()
  const [state, update] = useUrlState({ q: '', sort: 'newest', min: '', max: '', stock: '', tag: '', page: '1', view: '' })
  const page = Number(state.page) || 1
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const category = categories.data?.find((c) => c.slug === slug)

  const products = useQuery({
    queryKey: ['products', slug, state.q, state.sort, state.min, state.max, state.stock, state.tag, page],
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

  const title = slug ? category?.name ?? 'Collection' : state.q ? `Results for “${state.q}”` : 'All products'
  const total = products.data?.total ?? 0
  const pages = Math.ceil(total / PAGE_SIZE)
  const image = category?.image_url
  const banner = theme.collection.banner && !state.q && !!image
  const columns = state.view === 'large' ? 2 : theme.collection.columns

  return (
    <div>
      <SectionFrame id="collection-banner" label="Collection banner">
        {banner ? (
          <section className="relative isolate flex min-h-[38vh] items-end overflow-hidden bg-zinc-900 text-white sm:min-h-[52vh]">
            {image && <img src={imageUrl(image, 1920)} alt="" className="absolute inset-0 -z-10 size-full object-cover opacity-80" />}
            <div className="mx-auto w-full max-w-[1600px] px-4 pb-8 sm:px-8 sm:pb-12">
              <h1 className="text-4xl font-medium tracking-tight sm:text-6xl">{title}</h1>
              {category?.description && <p className="mt-2 max-w-lg text-sm text-white/85">{category.description}</p>}
            </div>
          </section>
        ) : (
          <div className="mx-auto max-w-[1600px] px-4 pt-10 pb-2 sm:px-8">
            <h1 className="text-2xl font-medium sm:text-3xl">{title}</h1>
          </div>
        )}
      </SectionFrame>

      <div className="sticky top-16 z-30 border-b border-foreground/10 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-5 px-4 py-3 text-[11px] tracking-[0.08em] uppercase sm:px-8">
          <SlidersHorizontal className="size-3.5 sm:hidden" />
          <FilterMenu label="Availability" active={state.stock === '1'}>
            <label className="flex items-center justify-between gap-6 text-sm normal-case">In stock only
              <Switch checked={state.stock === '1'} onCheckedChange={(v) => update({ stock: v ? '1' : '' })} />
            </label>
          </FilterMenu>
          <FilterMenu label="Price" active={!!(state.min || state.max)}>
            <PriceFilter min={state.min} max={state.max} onApply={(min, max) => update({ min, max })} />
          </FilterMenu>
          {state.tag && <button type="button" className="underline" onClick={() => update({ tag: '' })}>Tag: {state.tag} ×</button>}
          <span className="ml-auto hidden text-muted-foreground sm:inline">{formatNumber(total)} items</span>
          <FilterMenu label={`Sort${state.sort !== 'newest' ? ': ' + (SORTS.find((s) => s.value === state.sort)?.label ?? '') : ''}`} align="end">
            <div className="grid gap-1 text-sm normal-case">
              {SORTS.map((s) => (
                <button key={s.value} type="button" onClick={() => update({ sort: s.value })}
                  className={cn('rounded px-2 py-1.5 text-left hover:bg-muted', state.sort === s.value && 'font-medium underline underline-offset-4')}>{s.label}</button>
              ))}
            </div>
          </FilterMenu>
          <div className="flex items-center gap-1" role="group" aria-label="Grid size">
            <button type="button" aria-pressed={state.view === 'large'} aria-label="Large tiles" onClick={() => update({ view: 'large' }, { resetPage: false })}
              className={cn('grid size-7 place-items-center rounded', state.view === 'large' ? 'bg-muted' : 'opacity-50')}><Square className="size-3.5" /></button>
            <button type="button" aria-pressed={state.view !== 'large'} aria-label="Small tiles" onClick={() => update({ view: '' }, { resetPage: false })}
              className={cn('grid size-7 place-items-center rounded', state.view !== 'large' ? 'bg-muted' : 'opacity-50')}><LayoutGrid className="size-3.5" /></button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] pt-px sm:px-8 sm:pt-4">
        {products.error ? (
          <ErrorState error={products.error} onRetry={() => products.refetch()} />
        ) : !products.isLoading && total === 0 ? (
          <EmptyState title="No products found" description="Try a different search or remove some filters." />
        ) : (
          <ProductGrid products={products.data?.items} loading={products.isLoading} columns={columns} count={8} />
        )}
      </div>

      {pages > 1 && (
        <div className="mt-10 flex items-center justify-center gap-6 text-xs tracking-[0.08em] uppercase">
          <button type="button" className="disabled:opacity-30" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, { resetPage: false })}>← Previous</button>
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          <button type="button" className="disabled:opacity-30" disabled={page >= pages} onClick={() => update({ page: String(page + 1) }, { resetPage: false })}>Next →</button>
        </div>
      )}
    </div>
  )
}

function FilterMenu({ label, active, align = 'start', children }: { label: string; active?: boolean; align?: 'start' | 'end'; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger className={cn('flex items-center gap-1 uppercase hover:opacity-70', active && 'underline underline-offset-4')}>
        {label} <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 rounded-none p-3">{children}</PopoverContent>
    </Popover>
  )
}

function PriceFilter({ min, max, onApply }: { min: string; max: string; onApply: (min: string, max: string) => void }) {
  const [lo, setLo] = useState(min)
  const [hi, setHi] = useState(max)
  return (
    <form className="grid gap-3 text-sm normal-case" onSubmit={(e) => { e.preventDefault(); onApply(lo, hi) }}>
      <div className="flex items-center gap-2">
        <input className="h-9 w-full border px-2 outline-none focus:border-foreground" inputMode="numeric" placeholder="From" value={lo} onChange={(e) => setLo(e.target.value.replace(/\D/g, ''))} aria-label="Minimum price" />
        <span className="text-muted-foreground">–</span>
        <input className="h-9 w-full border px-2 outline-none focus:border-foreground" inputMode="numeric" placeholder="To" value={hi} onChange={(e) => setHi(e.target.value.replace(/\D/g, ''))} aria-label="Maximum price" />
      </div>
      <div className="flex justify-between">
        <button type="button" className="text-xs underline" onClick={() => { setLo(''); setHi(''); onApply('', '') }}>Reset</button>
        <button type="submit" className="bg-foreground px-4 py-1.5 text-xs tracking-wide text-background uppercase">Apply</button>
      </div>
    </form>
  )
}

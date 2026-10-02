import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useDebounce } from '@/hooks/use-debounce'
import { formatMoney } from '@/lib/format'
import { searchVariants, type VariantSearchRow } from '@/services/catalog'

/** Search products by name or SKU and pick a variant. */
export function VariantPicker({ onPick, placeholder = 'Add product by name or SKU…', showCost }: {
  onPick: (variant: VariantSearchRow) => void
  placeholder?: string
  showCost?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const term = useDebounce(q, 250)
  const results = useQuery({ queryKey: ['variant-search', term], enabled: open, queryFn: () => searchVariants(term) })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} placeholder={placeholder} className="pl-8" aria-label="Search products" />
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        {results.isLoading ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Spinner /> Searching…</div>
        ) : !results.data?.length ? (
          <p className="p-3 text-sm text-muted-foreground">No products found.</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {results.data.map((v) => (
              <li key={v.variant_id}>
                <button type="button" className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => { onPick(v); setQ(''); setOpen(false) }}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{v.product_name}{v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''}</span>
                    <span className="text-xs text-muted-foreground">
                      {v.sku}{v.product_status !== 'ACTIVE' ? ` · ${v.product_status?.toLowerCase()}` : ''}
                      {showCost ? ` · cost ${formatMoney(v.unit_cost)}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    <span className="block font-medium">{formatMoney(v.unit_price)}</span>
                    <span className={v.track_inventory && (v.available ?? 0) <= 0 ? 'text-destructive' : 'text-muted-foreground'}>
                      {v.track_inventory ? `${v.available ?? 0} in stock` : 'made to order'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

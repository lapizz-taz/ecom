import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import type { ProductCard as ProductCardData } from '@/types/domain'
import { useStoreTheme } from './theme-context'

export function PriceTag({ price, compareAt, maxPrice, className }: { price: number; compareAt?: number | null; maxPrice?: number; className?: string }) {
  const onSale = compareAt != null && Number(compareAt) > Number(price)
  return (
    <div className={className}>
      <span className="font-medium">
        {formatMoney(price)}{maxPrice && Number(maxPrice) > Number(price) ? ` – ${formatMoney(maxPrice)}` : ''}
      </span>
      {onSale && <span className="ml-2 text-muted-foreground line-through opacity-80">{formatMoney(compareAt)}</span>}
    </div>
  )
}

/** Editorial product card: full-bleed image, small name and price under it. */
function ProductCard({ product }: { product: ProductCardData }) {
  const t = useStoreTheme().product_card
  const onSale = product.compare_at_price != null && Number(product.compare_at_price) > Number(product.price)
  return (
    <Link to={`/product/${product.slug}`} className="group block">
      <div className={cn('relative overflow-hidden rounded-[var(--radius)]', t.aspect === 'square' ? 'aspect-square' : 'aspect-[4/5]')} style={{ background: t.image_bg }}>
        {product.image && (
          <img src={imageUrl(product.image.url, 700)} alt={product.image.alt} loading="lazy" decoding="async"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
            className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]" />
        )}
        <div className="absolute top-2 left-2 flex gap-1">
          {onSale && t.sale_badge && <span className="bg-foreground px-2 py-1 text-[calc(10px*var(--fs-body,1))] font-medium tracking-wider text-background uppercase">Sale</span>}
          {!product.in_stock && <span className="bg-background/90 px-2 py-1 text-[calc(10px*var(--fs-body,1))] font-medium tracking-wider uppercase">Sold out</span>}
        </div>
      </div>
      <div className={cn('mt-2 space-y-0.5 px-2 pb-3 text-[calc(11px*var(--fs-body,1))] leading-snug sm:text-xs', t.uppercase && 'tracking-wide uppercase')}>
        <p className="line-clamp-2">{product.name}</p>
        <PriceTag price={product.price} compareAt={product.compare_at_price} className="tabular-nums" />
      </div>
    </Link>
  )
}

const COLS: Record<number, string> = {
  2: 'grid-cols-2', 3: 'grid-cols-2 md:grid-cols-3', 4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4', 5: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
}

export function ProductGrid({ products, loading, count = 8, columns = 4 }: { products?: ProductCardData[]; loading?: boolean; count?: number; columns?: number }) {
  const gap = useStoreTheme().product_card.gap
  const grid = cn('grid', COLS[columns] ?? COLS[4], gap === 'none' ? 'gap-0' : gap === 'large' ? 'gap-x-5 gap-y-6' : 'gap-x-px gap-y-2')
  if (loading && !products) {
    return (
      <div className={grid}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i}><Skeleton className="aspect-[4/5] rounded-none" /><Skeleton className="mx-2 mt-2 h-3 w-3/4" /><Skeleton className="mx-2 mt-1 mb-3 h-3 w-1/3" /></div>
        ))}
      </div>
    )
  }
  return (
    <div className={grid}>
      {products?.map((p) => <ProductCard key={p.id} product={p} />)}
    </div>
  )
}

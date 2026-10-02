import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/format'
import { imageUrl } from '@/services/catalog'
import type { ProductCard as ProductCardData } from '@/types/domain'

export function PriceTag({ price, compareAt, maxPrice, className }: { price: number; compareAt?: number | null; maxPrice?: number; className?: string }) {
  const onSale = compareAt != null && Number(compareAt) > Number(price)
  return (
    <div className={className}>
      <span className={onSale ? 'font-medium text-red-600' : 'font-medium'}>
        {formatMoney(price)}{maxPrice && Number(maxPrice) > Number(price) ? ` – ${formatMoney(maxPrice)}` : ''}
      </span>
      {onSale && <span className="ml-2 text-sm text-muted-foreground line-through">{formatMoney(compareAt)}</span>}
    </div>
  )
}

export function ProductCard({ product }: { product: ProductCardData }) {
  const onSale = product.compare_at_price != null && Number(product.compare_at_price) > Number(product.price)
  return (
    <Link to={`/product/${product.slug}`} className="group block">
      <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-muted">
        {product.image && (
          <img src={imageUrl(product.image.url, 600)} alt={product.image.alt} loading="lazy" decoding="async"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        )}
        <div className="absolute top-2 left-2 flex gap-1">
          {onSale && <Badge variant="destructive">Sale</Badge>}
          {!product.in_stock && <Badge variant="secondary">Sold out</Badge>}
        </div>
      </div>
      <div className="mt-3 space-y-0.5">
        <p className="line-clamp-1 text-sm">{product.name}</p>
        <PriceTag price={product.price} compareAt={product.compare_at_price} className="text-sm" />
      </div>
    </Link>
  )
}

export function ProductGrid({ products, loading, count = 8 }: { products?: ProductCardData[]; loading?: boolean; count?: number }) {
  if (loading && !products) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i}><Skeleton className="aspect-[4/5] rounded-lg" /><Skeleton className="mt-3 h-4 w-3/4" /><Skeleton className="mt-1 h-4 w-1/3" /></div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
      {products?.map((p) => <ProductCard key={p.id} product={p} />)}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { ShoppingBag, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { QuantityStepper } from '@/features/cart/cart-drawer'
import { useCart } from '@/features/cart/cart-store'
import { PriceTag, ProductGrid } from '@/features/storefront/product-card'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { getProduct, trackEvent } from '@/services/storefront'
import type { ProductDetail, ProductVariantPublic } from '@/types/domain'

function optionValues(product: ProductDetail, name: string): string[] {
  return [...new Set(product.variants.map((v) => v.option_values?.[name]).filter((v): v is string => Boolean(v)))]
}

function findVariant(product: ProductDetail, selected: Record<string, string>): ProductVariantPublic | undefined {
  if (!product.option_names.length) return product.variants[0]
  return product.variants.find((v) => product.option_names.every((n) => v.option_values?.[n] === selected[n]))
}

export default function ProductPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const add = useCart((s) => s.add)
  const setOpen = useCart((s) => s.setOpen)
  const { data: product, isLoading, error, refetch } = useQuery({ queryKey: ['product', slug], queryFn: () => getProduct(slug) })
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [quantity, setQuantity] = useState(1)
  const [imageIndex, setImageIndex] = useState(0)

  useEffect(() => {
    if (!product) return
    document.title = product.seo_title || product.name
    trackEvent('VIEW_PRODUCT', product.id)
    const first = product.variants.find((v) => v.in_stock) ?? product.variants[0]
    setSelected(first?.option_values ?? {})
    setImageIndex(0)
    setQuantity(1)
  }, [product])

  const variant = useMemo(() => (product ? findVariant(product, selected) : undefined), [product, selected])

  // Jump to the image attached to the chosen variant.
  useEffect(() => {
    if (!product || !variant) return
    const idx = product.images.findIndex((img) => img.variant_id === variant.id)
    if (idx >= 0) setImageIndex(idx)
  }, [product, variant])

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />
  if (isLoading) {
    return (
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-2">
        <Skeleton className="aspect-[4/5] rounded-lg" />
        <div className="space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-6 w-1/4" /><Skeleton className="h-24" /></div>
      </div>
    )
  }
  if (!product) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-xl font-semibold">Product not found</h1>
        <Button asChild className="mt-4"><Link to="/shop">Back to shop</Link></Button>
      </div>
    )
  }

  const maxQty = Math.max(1, Math.min(product.max_quantity, variant?.available ?? product.max_quantity))
  const canBuy = Boolean(variant?.in_stock)
  const image = product.images[imageIndex] ?? product.images[0]

  const addToCart = (goToCheckout: boolean) => {
    if (!variant) return
    add({
      variantId: variant.id,
      productId: product.id,
      slug: product.slug,
      name: product.name,
      variantTitle: product.option_names.length ? variant.title : null,
      price: Number(variant.price),
      image: image?.url ?? product.image?.url ?? null,
      maxQuantity: maxQty,
    }, quantity)
    trackEvent('ADD_TO_CART', product.id)
    if (goToCheckout) {
      setOpen(false)
      navigate('/checkout')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-5 text-sm text-muted-foreground">
        <Link to="/shop" className="hover:text-foreground">Shop</Link>
        {product.category && <> / <Link to={`/collection/${product.category.slug}`} className="hover:text-foreground">{product.category.name}</Link></>}
      </nav>
      <div className="grid gap-8 md:grid-cols-2 lg:gap-12">
        <div className="space-y-3">
          <div className="aspect-[4/5] overflow-hidden rounded-lg bg-muted">
            {image && <img src={imageUrl(image.url, 1000)} alt={image.alt} className="size-full object-cover" />}
          </div>
          {product.images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {product.images.map((img, i) => (
                <button key={img.id} type="button" onClick={() => setImageIndex(i)} aria-label={`Show image ${i + 1}`}
                  className={cn('size-16 shrink-0 overflow-hidden rounded-md border-2', i === imageIndex ? 'border-foreground' : 'border-transparent')}>
                  <img src={imageUrl(img.url, 160)} alt="" className="size-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="space-y-2">
            {product.brand && <p className="text-sm text-muted-foreground">{product.brand}</p>}
            <h1 className="text-2xl font-semibold sm:text-3xl">{product.name}</h1>
            <div className="flex items-center gap-2">
              <PriceTag price={variant?.price ?? product.price} compareAt={variant?.compare_at_price ?? product.compare_at_price} className="text-lg" />
              {(variant?.compare_at_price ?? 0) > (variant?.price ?? 0) && <Badge variant="destructive">Sale</Badge>}
            </div>
          </div>

          {product.option_names.map((name) => (
            <div key={name} className="space-y-2">
              <p className="text-sm font-medium">{name}: <span className="font-normal text-muted-foreground">{selected[name]}</span></p>
              <div className="flex flex-wrap gap-2">
                {optionValues(product, name).map((value) => {
                  const candidate = findVariant(product, { ...selected, [name]: value })
                  const available = Boolean(candidate?.in_stock)
                  return (
                    <button key={value} type="button" onClick={() => setSelected((s) => ({ ...s, [name]: value }))}
                      className={cn('min-w-12 rounded-md border px-3 py-1.5 text-sm transition-colors',
                        selected[name] === value ? 'border-foreground bg-foreground text-background' : 'hover:border-foreground',
                        !available && 'text-muted-foreground line-through decoration-1')}
                      aria-pressed={selected[name] === value}>
                      {value}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          <div className="text-sm">
            {!variant ? <span className="text-muted-foreground">This combination is not available.</span>
              : !variant.in_stock ? <span className="font-medium text-red-600">Out of stock</span>
              : variant.available !== null && variant.available <= 5 ? <span className="font-medium text-amber-600">Only {variant.available} left</span>
              : <span className="text-emerald-700">In stock</span>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <QuantityStepper value={quantity} max={maxQty} onChange={(v) => setQuantity(Math.max(1, Math.min(v, maxQty)))} size="default" />
            <Button size="lg" className="flex-1" disabled={!canBuy} onClick={() => addToCart(false)}><ShoppingBag /> Add to cart</Button>
          </div>
          <Button size="lg" variant="outline" className="w-full" disabled={!canBuy} onClick={() => addToCart(true)}><Zap /> Buy now</Button>

          {product.description && (
            <div className="space-y-2 border-t pt-5">
              <h2 className="font-medium">Description</h2>
              <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{product.description}</p>
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-5 text-sm">
            <dt className="text-muted-foreground">SKU</dt><dd>{variant?.sku ?? product.sku ?? '—'}</dd>
            {product.tags.length > 0 && (
              <>
                <dt className="text-muted-foreground">Tags</dt>
                <dd className="flex flex-wrap gap-1">
                  {product.tags.map((t) => <Link key={t} to={`/shop?tag=${encodeURIComponent(t)}`}><Badge variant="secondary">{t}</Badge></Link>)}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {product.related.length > 0 && (
        <section className="mt-16">
          <h2 className="mb-5 text-xl font-semibold">You may also like</h2>
          <ProductGrid products={product.related} />
        </section>
      )}
    </div>
  )
}

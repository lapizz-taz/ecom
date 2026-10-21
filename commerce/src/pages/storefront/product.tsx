import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCart } from '@/features/cart/cart-store'
import { PriceTag, ProductGrid } from '@/features/storefront/product-card'
import {
  BuyButtons, DeliveryTimeline, EdgeGallery, Highlights, OptionPicker, ProductAccordions, PromoNote, StockDot,
} from '@/features/storefront/product-layouts'
import { addCard, BlockWrapper, ProductBlocks, StickyAddToCart, type BlockContext } from '@/features/storefront/product-block-views'
import { activeBlock } from '@/features/storefront/product-blocks'
import { SectionFrame, ThemeSections } from '@/features/storefront/sections'
import { adEvent } from '@/features/storefront/ad-pixels'
import { useStoreTheme } from '@/features/storefront/theme-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { getProduct, trackEvent } from '@/services/storefront'
import type { ProductCard, ProductDetail, ProductVariantPublic } from '@/types/domain'

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
  const theme = useStoreTheme()
  const { data: config } = useStoreConfig()
  const currency = config?.store.currency || 'BDT'
  const pp = theme.product_page
  const { data: product, isLoading, error, refetch } = useQuery({ queryKey: ['product', slug], queryFn: () => getProduct(slug) })
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [quantity, setQuantity] = useState(1)
  const [imageIndex, setImageIndex] = useState(0)
  const [addons, setAddons] = useState<ProductCard[]>([])
  const buttonsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!product) return
    trackEvent('VIEW_PRODUCT', product.id)
    const shown = product.variants.find((v) => v.in_stock) ?? product.variants[0]
    const price = Number(shown?.price ?? 0)
    adEvent('ViewContent', { value: price, currency, contents: [{ id: product.id, name: product.name, quantity: 1, price }] })
    const first = product.variants.find((v) => v.in_stock) ?? product.variants[0]
    setSelected(first?.option_values ?? {})
    setImageIndex(0)
    setQuantity(1)
    setAddons([])
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
      compareAt: variant.compare_at_price ? Number(variant.compare_at_price) : null,
      image: image?.url ?? product.image?.url ?? null,
      maxQuantity: maxQty,
    }, quantity, !goToCheckout)
    // Ticked add-ons go in with it.
    for (const card of addons) void addCard(card, add, false)
    trackEvent('ADD_TO_CART', product.id)
    const price = Number(variant.price)
    adEvent('AddToCart', { value: price * quantity, currency, contents: [{ id: product.id, name: product.name, quantity, price }] })
    if (goToCheckout) {
      setOpen(false)
      navigate('/checkout')
    }
  }

  const sku = variant?.sku ?? product.sku
  const blocks = pp.blocks
  const look = activeBlock(blocks, 'atc_style')?.settings ?? null
  const setQty = (v: number) => setQuantity(Math.max(1, Math.min(v, maxQty)))
  const ctx: BlockContext = { product, variant, quantity, max: maxQty, setQuantity: setQty, addons, setAddons }
  const buttons = (
    <>
      <ProductBlocks blocks={blocks} place="above" ctx={ctx} />
      <div ref={buttonsRef}>
        <BuyButtons pp={pp} quantity={quantity} max={maxQty} onQuantity={setQty} look={look}
          disabled={!canBuy} onAdd={() => addToCart(false)} onBuy={() => addToCart(true)} />
      </div>
      <ProductBlocks blocks={blocks} place="below" ctx={ctx} />
    </>
  )
  const sticky = (
    <StickyAddToCart blocks={blocks} watch={buttonsRef} product={product} price={Number(variant?.price ?? product.price)} disabled={!canBuy}
      onAdd={() => addToCart(false)} label={typeof look?.label === 'string' && look.label.trim() ? look.label : 'Add to cart'} />
  )
  const related = pp.show_related && product.related.length > 0 && (
    <SectionFrame id="product-related" label="Related products">
      <section className="mx-auto max-w-6xl px-4 py-12">
        {pp.related_title && <h2 className="mb-5 text-xl font-semibold">{pp.related_title}</h2>}
        <ProductGrid products={product.related} />
      </section>
    </SectionFrame>
  )

  if (pp.layout !== 'classic') {
    const bold = pp.layout === 'bold'
    const first = product.option_names[0]
    const firstCount = first ? optionValues(product, first).length : 0
    const countText = firstCount > 1 ? `${firstCount} ${first.toLowerCase()}${first.toLowerCase().endsWith('s') ? '' : 's'}` : ''
    const desc = product.short_description?.trim()
      || (product.description && product.description.length > 170 ? `${product.description.slice(0, 170).trimEnd()}…` : product.description?.trim())
    const onSale = (variant?.compare_at_price ?? 0) > (variant?.price ?? 0)
    const price = <PriceTag price={variant?.price ?? product.price} compareAt={variant?.compare_at_price ?? product.compare_at_price} className={bold ? 'text-lg' : 'shrink-0'} />
    return (
      <div>
        <SectionFrame id="product-info" label="Product information">
          <div className="grid md:grid-cols-2">
            <EdgeGallery product={product} index={imageIndex} onIndex={setImageIndex} aspect={pp.image_aspect} background={theme.product_card.image_bg} />
            <BlockWrapper blocks={blocks} className="mx-auto my-0 w-full max-w-[460px] space-y-5 px-4 py-6 md:my-6 md:py-10">
              {bold ? (
                <div className="space-y-3">
                  {pp.show_brand && product.brand && <p className="text-xs text-muted-foreground">{product.brand}</p>}
                  <h1 className="text-xl italic sm:text-2xl">{product.name}</h1>
                  {(pp.show_stock || !variant?.in_stock) && <StockDot inStock={Boolean(variant?.in_stock)} available={variant?.available ?? null} missing={!variant} />}
                  <div className="flex items-center gap-2">{price}{pp.show_sale_badge && onSale && <Badge variant="destructive">Sale</Badge>}</div>
                  {desc && <p className="text-xs leading-relaxed italic text-muted-foreground">{desc}</p>}
                </div>
              ) : (
                <div className="space-y-3">
                  {(pp.show_stock || !variant?.in_stock) && <StockDot inStock={Boolean(variant?.in_stock)} available={variant?.available ?? null} missing={!variant} />}
                  <div className="flex items-center justify-between gap-3 border-y px-2 py-2.5 text-[11px]">
                    <h1 className="min-w-0 font-medium uppercase">
                      {product.name}{countText && <span className="font-normal normal-case text-muted-foreground"> · {countText}</span>}
                    </h1>
                    <div className="flex shrink-0 items-center gap-2">{pp.show_sale_badge && onSale && <Badge variant="destructive">Sale</Badge>}{price}</div>
                  </div>
                  {desc && <p className="text-xs leading-relaxed italic text-muted-foreground">{desc}</p>}
                </div>
              )}

              {product.option_names.map((name) => (
                <OptionPicker key={name} product={product} name={name} values={optionValues(product, name)} selected={selected[name]}
                  onSelect={(value) => setSelected((s) => ({ ...s, [name]: value }))}
                  isAvailable={(value) => Boolean(findVariant(product, { ...selected, [name]: value })?.in_stock)} />
              ))}

              {buttons}
              {pp.show_delivery && <DeliveryTimeline minDays={pp.delivery_min_days} maxDays={pp.delivery_max_days} />}
              <Highlights items={pp.highlights} />
              <PromoNote text={pp.promo_text} />
              <ProductAccordions rows={pp.accordions} product={product} variant={bold ? 'chevron' : 'plus'} />
            </BlockWrapper>
          </div>
        </SectionFrame>
        {related}
        <ThemeSections sections={theme.product_sections} />
        {sticky}
      </div>
    )
  }

  return (
    <div>
      <SectionFrame id="product-info" label="Product information">
        <div className="mx-auto max-w-6xl px-4 py-8">
          <nav className="mb-5 text-sm text-muted-foreground">
            <Link to="/shop" className="hover:text-foreground">Shop</Link>
            {product.category && <> / <Link to={`/collection/${product.category.slug}`} className="hover:text-foreground">{product.category.name}</Link></>}
          </nav>
          <div className="grid gap-8 md:grid-cols-2 lg:gap-12">
            <div className="space-y-3">
              <div className={cn('overflow-hidden rounded-lg bg-muted', pp.image_aspect === 'square' ? 'aspect-square' : 'aspect-[4/5]')}>
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

            <BlockWrapper blocks={blocks} className="space-y-6">
              <div className="space-y-2">
                {pp.show_brand && product.brand && <p className="text-sm text-muted-foreground">{product.brand}</p>}
                <h1 className="text-2xl font-semibold sm:text-3xl">{product.name}</h1>
                <div className="flex items-center gap-2">
                  <PriceTag price={variant?.price ?? product.price} compareAt={variant?.compare_at_price ?? product.compare_at_price} className="text-lg" />
                  {pp.show_sale_badge && (variant?.compare_at_price ?? 0) > (variant?.price ?? 0) && <Badge variant="destructive">Sale</Badge>}
                </div>
                {product.short_description && <p className="text-sm leading-relaxed text-muted-foreground">{product.short_description}</p>}
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

              {/* Out of stock and impossible combinations always show; the rest follows the theme. */}
              {(pp.show_stock || !variant || !variant.in_stock) && (
                <div className="text-sm">
                  {!variant ? <span className="text-muted-foreground">This combination is not available.</span>
                    : !variant.in_stock ? <span className="font-medium text-red-600">Out of stock</span>
                    : variant.available !== null && variant.available <= 5 ? <span className="font-medium text-amber-600">Only {variant.available} left</span>
                    : <span className="text-emerald-700">In stock</span>}
                </div>
              )}

              {buttons}

              {pp.show_description && product.description && (
                <div className="space-y-2 border-t pt-5">
                  {pp.description_title && <h2 className="font-medium">{pp.description_title}</h2>}
                  <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{product.description}</p>
                </div>
              )}
              {pp.show_details && (product.shipping_note || product.warranty) && (
                <div className="grid gap-3 border-t pt-5 text-sm">
                  {product.shipping_note && <div><p className="font-medium">Shipping</p><p className="whitespace-pre-line text-muted-foreground">{product.shipping_note}</p></div>}
                  {product.warranty && <div><p className="font-medium">Warranty</p><p className="whitespace-pre-line text-muted-foreground">{product.warranty}</p></div>}
                </div>
              )}
              {((pp.show_sku && sku) || (pp.show_tags && product.tags.length > 0)) && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-5 text-sm">
                  {pp.show_sku && sku && <><dt className="text-muted-foreground">SKU</dt><dd>{sku}</dd></>}
                  {pp.show_tags && product.tags.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Tags</dt>
                      <dd className="flex flex-wrap gap-1">
                        {product.tags.map((t) => <Link key={t} to={`/shop?tag=${encodeURIComponent(t)}`}><Badge variant="secondary">{t}</Badge></Link>)}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </BlockWrapper>
          </div>
        </div>
      </SectionFrame>

      {related}
      <ThemeSections sections={theme.product_sections} />
      {sticky}
    </div>
  )
}

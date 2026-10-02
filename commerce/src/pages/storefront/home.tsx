import { useQuery } from '@tanstack/react-query'
import { ArrowRight, RotateCcw, ShieldCheck, Truck } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { ProductGrid } from '@/features/storefront/product-card'
import { useStoreConfig } from '@/hooks/use-store-config'
import { imageUrl } from '@/services/catalog'
import { getCategories, listProducts } from '@/services/storefront'

export default function HomePage() {
  const { data: config } = useStoreConfig()
  const featured = useQuery({ queryKey: ['products', 'featured'], queryFn: () => listProducts({ featured: true, limit: 8, sort: 'featured' }) })
  const latest = useQuery({ queryKey: ['products', 'newest'], queryFn: () => listProducts({ limit: 8, sort: 'newest' }) })
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const sf = config?.storefront
  const featuredSlugs = sf?.featured_category_slugs ?? []
  const shownCategories = (categories.data ?? [])
    .filter((c) => (featuredSlugs.length ? featuredSlugs.includes(c.slug) : c.product_count > 0))
    .slice(0, 3)

  return (
    <div>
      <section className="relative overflow-hidden bg-muted">
        {sf?.hero_image_url && <img src={sf.hero_image_url} alt="" className="absolute inset-0 size-full object-cover opacity-40" />}
        <div className="relative mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-20 sm:py-28">
          <h1 className="max-w-xl text-4xl font-semibold sm:text-5xl">{sf?.hero_title ?? 'Everyday essentials'}</h1>
          {sf?.hero_subtitle && <p className="max-w-lg text-muted-foreground sm:text-lg">{sf.hero_subtitle}</p>}
          <Button size="lg" asChild>
            <Link to={sf?.hero_cta_link || '/shop'}>{sf?.hero_cta_label || 'Shop now'} <ArrowRight /></Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-4 py-8 text-sm sm:grid-cols-3">
        {[
          { icon: <Truck className="size-5" />, title: 'Nationwide delivery', text: 'Cash on delivery available' },
          { icon: <RotateCcw className="size-5" />, title: 'Easy returns', text: 'Contact us if anything is not right' },
          { icon: <ShieldCheck className="size-5" />, title: 'Secure checkout', text: 'Your details stay private' },
        ].map((f) => (
          <div key={f.title} className="flex items-center gap-3 rounded-lg border p-4">
            {f.icon}
            <div><p className="font-medium">{f.title}</p><p className="text-muted-foreground">{f.text}</p></div>
          </div>
        ))}
      </section>

      {shownCategories.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 py-8">
          <h2 className="mb-5 text-xl font-semibold">Shop by category</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {shownCategories.map((c) => (
              <Link key={c.id} to={`/collection/${c.slug}`} className="group relative flex aspect-[4/3] items-end overflow-hidden rounded-lg bg-muted p-5">
                {c.image_url && <img src={imageUrl(c.image_url, 600)} alt="" className="absolute inset-0 size-full object-cover transition-transform group-hover:scale-105" />}
                <div className="relative rounded-md bg-background/90 px-3 py-2">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.product_count} products</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {(featured.data?.items.length ?? 0) > 0 && (
        <section className="mx-auto max-w-6xl px-4 py-8">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-xl font-semibold">Featured</h2>
            <Link to="/shop" className="text-sm text-muted-foreground hover:text-foreground">View all</Link>
          </div>
          <ProductGrid products={featured.data?.items} loading={featured.isLoading} />
        </section>
      )}

      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-xl font-semibold">New arrivals</h2>
          <Link to="/shop?sort=newest" className="text-sm text-muted-foreground hover:text-foreground">View all</Link>
        </div>
        <ProductGrid products={latest.data?.items} loading={latest.isLoading} />
      </section>
    </div>
  )
}

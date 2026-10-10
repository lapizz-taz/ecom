import { ExternalLink, Menu, MessageCircle, Search, ShoppingBag, Store, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { CartDrawer } from '@/features/cart/cart-drawer'
import { isThemePreview, resolveTheme, themeStyle, useStorefront, useThemeFont } from '@/features/storefront/theme'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { cartCount, useCart } from '@/features/cart/cart-store'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { captureNavigation } from '@/lib/attribution'
import { getCategories, trackEvent } from '@/services/storefront'
import { useCartSync } from '@/features/cart/use-cart-sync'

function useCategories() {
  return useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
}

export default function StorefrontLayout() {
  const { data: config } = useStoreConfig()
  const sf = useStorefront(config?.storefront)
  const theme = resolveTheme(sf)
  useThemeFont(theme.font)
  const wa = theme.whatsapp ? waNumber(theme.whatsapp) : null
  const { data: categories } = useCategories()
  const items = useCart((s) => s.items)
  const setOpen = useCart((s) => s.setOpen)
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [q, setQ] = useState('')

  useCartSync()

  useEffect(() => {
    captureNavigation(location)
    trackEvent('PAGE_VIEW')
  }, [location.pathname, location.search])

  useEffect(() => {
    if (config?.store.name) document.title = config.store.name
  }, [config?.store.name])

  const storeName = config?.store.name ?? 'Store'
  // Closed when the business sells only through Shopify / WooCommerce (or switched
  // the store off). Order tracking stays open for past customers.
  const closed = !!sf?.mode && sf.mode !== 'OWN' && !isThemePreview()
  if (closed && !location.pathname.startsWith('/track-order') && !location.pathname.startsWith('/policies')) {
    return <StoreClosed name={storeName} logo={config?.store.logo_url} url={sf?.redirect_url ?? null} phone={config?.store.phone} style={themeStyle(theme)} />
  }
  const nav = (categories ?? []).filter((c) => !c.parent_id && c.product_count > 0).slice(0, 5)
  const count = cartCount(items)

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setSearchOpen(false)
    navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  return (
    <div className="flex min-h-dvh flex-col" style={themeStyle(theme)}>
      <ScrollRestoration />
      {sf?.announcement && (
        <div className="bg-primary px-4 py-2 text-center text-xs text-primary-foreground">{sf.announcement}</div>
      )}
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="relative mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu /></Button>
          <Link to="/" className={cn('text-lg font-semibold tracking-tight', theme.logo_position === 'center' && 'md:absolute md:left-1/2 md:-translate-x-1/2')}>
            {config?.store.logo_url ? <img src={config.store.logo_url} alt={storeName} className="h-7" /> : storeName}
          </Link>
          <nav className={cn('hidden items-center gap-5 text-sm md:flex', theme.logo_position === 'center' ? 'order-first' : 'ml-6')}>
            <NavLink to="/shop" className={({ isActive }) => cn('text-muted-foreground hover:text-foreground', isActive && 'text-foreground')}>Shop all</NavLink>
            {nav.map((c) => (
              <NavLink key={c.id} to={`/collection/${c.slug}`} className={({ isActive }) => cn('text-muted-foreground hover:text-foreground', isActive && 'text-foreground')}>
                {c.name}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setSearchOpen((v) => !v)} aria-label="Search"><Search /></Button>
            <Button variant="ghost" size="icon" asChild aria-label="Account">
              <Link to={user ? '/account' : '/login'}><User /></Link>
            </Button>
            <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label={`Cart, ${count} items`}>
              <ShoppingBag />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">{count}</span>
              )}
            </Button>
          </div>
        </div>
        {searchOpen && (
          <form onSubmit={submitSearch} className="mx-auto max-w-6xl px-4 pb-3">
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products…" aria-label="Search products" />
          </form>
        )}
      </header>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left">
          <SheetHeader><SheetTitle>{storeName}</SheetTitle></SheetHeader>
          <nav className="grid gap-1 px-4 text-sm">
            {[{ to: '/shop', label: 'Shop all' }, ...nav.map((c) => ({ to: `/collection/${c.slug}`, label: c.name })),
              { to: '/track-order', label: 'Track order' }, { to: '/contact', label: 'Contact' }].map((l) => (
              <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)} className="rounded-md px-2 py-2 hover:bg-accent">{l.label}</Link>
            ))}
          </nav>
        </SheetContent>
      </Sheet>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="mt-16 border-t bg-muted/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-3">
          <div>
            <p className="font-semibold">{storeName}</p>
            {config?.store.tagline && <p className="mt-1 text-muted-foreground">{config.store.tagline}</p>}
            {config?.store.address && <p className="mt-3 text-muted-foreground">{config.store.address}</p>}
            {config?.store.phone && <p className="text-muted-foreground">{config.store.phone}</p>}
          </div>
          <div className="grid content-start gap-2">
            <p className="font-medium">Help</p>
            <Link to="/track-order" className="text-muted-foreground hover:text-foreground">Track your order</Link>
            <Link to="/contact" className="text-muted-foreground hover:text-foreground">Contact us</Link>
            <Link to="/policies/shipping" className="text-muted-foreground hover:text-foreground">Shipping</Link>
            <Link to="/policies/returns" className="text-muted-foreground hover:text-foreground">Returns</Link>
          </div>
          <div className="grid content-start gap-2">
            <p className="font-medium">Legal</p>
            <Link to="/policies/privacy" className="text-muted-foreground hover:text-foreground">Privacy policy</Link>
            <Link to="/policies/terms" className="text-muted-foreground hover:text-foreground">Terms</Link>
          </div>
        </div>
        {theme.payment_badges && config && (
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-6 text-[11px] text-muted-foreground">
            {[...(config.payments.cod_enabled ? ['Cash on delivery'] : []), ...config.payments.providers.map((p) => p.label)]
              .filter((p, i, all) => all.indexOf(p) === i).map((p) => <span key={p} className="rounded-md border px-2 py-1">{p}</span>)}
          </div>
        )}
        <p className="border-t py-4 text-center text-xs text-muted-foreground">
          {sf?.footer_text || `© ${new Date().getFullYear()} ${storeName}`}
        </p>
      </footer>
      {wa && (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp"
          className="fixed right-4 bottom-4 z-40 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105">
          <MessageCircle className="size-5" />
        </a>
      )}
      <CartDrawer />
    </div>
  )
}

function StoreClosed({ name, logo, url, phone, style }: { name: string; logo?: string | null; url: string | null; phone?: string | null; style: React.CSSProperties }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4" style={style}>
      <div className="w-full max-w-sm space-y-5 text-center animate-in fade-in-0 zoom-in-95 duration-500">
        <span className="mx-auto grid size-12 place-items-center rounded-full border"><Store className="size-5" /></span>
        <div className="space-y-1.5">
          {logo ? <img src={logo} alt={name} className="mx-auto h-8" /> : <p className="text-xl font-semibold tracking-tight">{name}</p>}
          <p className="text-sm text-muted-foreground">
            {url ? 'Our shop has moved. Browse the full collection and order on our online store.' : 'We are not taking orders on this site right now.'}
          </p>
        </div>
        {url && <Button asChild className="w-full"><a href={url} rel="noreferrer">Visit our store <ExternalLink /></a></Button>}
        <div className="flex justify-center gap-4 text-xs text-muted-foreground">
          <Link to="/track-order" className="hover:text-foreground">Track an order</Link>
          {phone && <a href={`tel:${phone}`} className="hover:text-foreground">{phone}</a>}
        </div>
      </div>
    </div>
  )
}

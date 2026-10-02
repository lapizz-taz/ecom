import { Menu, Search, ShoppingBag, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { CartDrawer } from '@/features/cart/cart-drawer'
import { cartCount, useCart } from '@/features/cart/cart-store'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { captureUtm, getCategories, trackEvent } from '@/services/storefront'

function useCategories() {
  return useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
}

export default function StorefrontLayout() {
  const { data: config } = useStoreConfig()
  const { data: categories } = useCategories()
  const items = useCart((s) => s.items)
  const setOpen = useCart((s) => s.setOpen)
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    captureUtm(location.search)
    trackEvent('PAGE_VIEW')
  }, [location.pathname, location.search])

  useEffect(() => {
    if (config?.store.name) document.title = config.store.name
  }, [config?.store.name])

  const storeName = config?.store.name ?? 'Store'
  const nav = (categories ?? []).filter((c) => !c.parent_id && c.product_count > 0).slice(0, 5)
  const count = cartCount(items)

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setSearchOpen(false)
    navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <ScrollRestoration />
      {config?.storefront.announcement && (
        <div className="bg-primary px-4 py-2 text-center text-xs text-primary-foreground">{config.storefront.announcement}</div>
      )}
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu /></Button>
          <Link to="/" className="text-lg font-semibold tracking-tight">
            {config?.store.logo_url ? <img src={config.store.logo_url} alt={storeName} className="h-7" /> : storeName}
          </Link>
          <nav className="ml-6 hidden items-center gap-5 text-sm md:flex">
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
        <p className="border-t py-4 text-center text-xs text-muted-foreground">
          {config?.storefront.footer_text || `© ${new Date().getFullYear()} ${storeName}`}
        </p>
      </footer>
      <CartDrawer />
    </div>
  )
}

import { ExternalLink, Menu, MessageCircle, Search, ShoppingBag, Store, User } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { CartDrawer } from '@/features/cart/cart-drawer'
import { MarqueeStrip, SectionFrame } from '@/features/storefront/sections'
import { isThemePreview, type MenuLink, resolveTheme, type StoreTheme, themeStyle, useStorefront, useThemeFont } from '@/features/storefront/theme'
import { StoreThemeContext } from '@/features/storefront/theme-context'
import type { StoreConfig } from '@/types/domain'
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
  const [scrolled, setScrolled] = useState(false)

  useCartSync()

  useEffect(() => {
    captureNavigation(location)
    trackEvent('PAGE_VIEW')
  }, [location.pathname, location.search])

  useEffect(() => {
    if (config?.store.name) document.title = config.store.name
  }, [config?.store.name])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const storeName = config?.store.name ?? 'Store'
  // Closed when the business sells only through Shopify / WooCommerce (or switched
  // the store off). Order tracking stays open for past customers.
  const closed = !!sf?.mode && sf.mode !== 'OWN' && !isThemePreview()
  if (closed && !location.pathname.startsWith('/track-order') && !location.pathname.startsWith('/policies')) {
    return <StoreClosed name={storeName} logo={config?.store.logo_url} url={sf?.redirect_url ?? null} phone={config?.store.phone} style={themeStyle(theme)} />
  }
  const tops = (categories ?? []).filter((c) => !c.parent_id && c.product_count > 0).slice(0, 6)
  const childrenOf = (id: string) => (categories ?? []).filter((c) => c.parent_id === id && c.product_count > 0)
  const menu: NavItem[] = theme.header.menu.length
    ? theme.header.menu
    : [{ label: 'Shop all', link: '/shop' }, ...tops.map((c) => ({ label: c.name, link: `/collection/${c.slug}`, children: childrenOf(c.id).map((k) => ({ label: k.name, link: `/collection/${k.slug}` })) })),
      { label: 'Track order', link: '/track-order' }]
  const count = cartCount(items)
  const home = location.pathname === '/'
  const firstHero = theme.sections.find((x) => x.enabled)?.type === 'hero'
  const overlay = theme.header.transparent && home && firstHero && !scrolled && !searchOpen
  const centered = theme.logo_position === 'center'
  const linkClass = cn('text-[11px] whitespace-nowrap transition-opacity hover:opacity-60 sm:text-xs', theme.header.uppercase && 'tracking-[0.08em] uppercase')

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setSearchOpen(false)
    navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  const logo = (
    <Link to="/" className="shrink-0 text-lg font-semibold tracking-tight">
      {config?.store.logo_url ? <img src={config.store.logo_url} alt={storeName} className={cn('h-7 w-auto', overlay && 'brightness-0 invert')} /> : storeName}
    </Link>
  )

  return (
    <StoreThemeContext.Provider value={theme}>
    <div className="flex min-h-dvh flex-col" style={themeStyle(theme)}>
      <ScrollRestoration />
      {theme.announcement.enabled && theme.announcement.items.length > 0 && (
        theme.announcement.marquee
          ? <MarqueeStrip items={theme.announcement.items} seconds={35} className="py-2 text-[11px] font-medium tracking-[0.12em] uppercase"
              style={{ background: theme.colors.announcement_bg, color: theme.colors.announcement_text }} />
          : <div className="px-4 py-2 text-center text-[11px] tracking-[0.08em] uppercase" style={{ background: theme.colors.announcement_bg, color: theme.colors.announcement_text }}>{theme.announcement.items[0]}</div>
      )}
      <header className={cn('z-40 transition-colors duration-300', theme.header.sticky && !overlay && 'sticky top-0',
        overlay ? 'absolute inset-x-0 top-auto text-white' : 'border-b border-foreground/10 bg-background/95 backdrop-blur')}>
        <div className={cn('relative mx-auto grid h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-8',
          centered ? 'grid-cols-[1fr_auto_1fr]' : 'grid-cols-[1fr_auto_1fr] lg:grid-cols-[auto_1fr_auto]')}>
          <div className="flex min-w-0 items-center gap-1">
            <div className="flex items-center gap-1 lg:hidden">
              <button type="button" className="grid size-9 place-items-center" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu className="size-5" strokeWidth={1.5} /></button>
              <button type="button" className="grid size-9 place-items-center" onClick={() => setSearchOpen((v) => !v)} aria-label="Search"><Search className="size-[18px]" strokeWidth={1.5} /></button>
            </div>
            {centered ? <MainNav menu={menu} linkClass={linkClass} /> : <div className="hidden lg:block">{logo}</div>}
          </div>
          <div className={cn('justify-self-center', !centered && 'lg:hidden')}>{logo}</div>
          {!centered && <div className="hidden min-w-0 lg:block"><MainNav menu={menu} linkClass={linkClass} /></div>}
          <div className="flex items-center justify-end gap-0.5">
            <button type="button" className="hidden size-9 place-items-center lg:grid" onClick={() => setSearchOpen((v) => !v)} aria-label="Search"><Search className="size-[18px]" strokeWidth={1.5} /></button>
            <Link to={user ? '/account' : '/login'} className="grid size-9 place-items-center" aria-label="Account"><User className="size-[18px]" strokeWidth={1.5} /></Link>
            <button type="button" className="relative grid size-9 place-items-center" onClick={() => setOpen(true)} aria-label={`Cart, ${count} items`}>
              <ShoppingBag className="size-[18px]" strokeWidth={1.5} />
              {count > 0 && (
                <span className="absolute top-0.5 right-0 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">{count}</span>
              )}
            </button>
          </div>
        </div>
        {searchOpen && (
          <form onSubmit={submitSearch} className="border-t border-foreground/10 bg-background text-foreground">
            <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-8">
              <Search className="size-4 opacity-60" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" aria-label="Search products"
                className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              <button type="button" onClick={() => setSearchOpen(false)} className="text-xs tracking-wide uppercase opacity-70 hover:opacity-100">Close</button>
            </div>
          </form>
        )}
      </header>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-sm">
          <SheetHeader><SheetTitle>{storeName}</SheetTitle></SheetHeader>
          <nav className="grid gap-0.5 px-4 text-sm">
            {menu.flatMap((m) => [m, ...(m.children ?? []).map((c) => ({ ...c, child: true }))]).map((l) => (
              <Link key={l.label + l.link} to={l.link} onClick={() => setMenuOpen(false)}
                className={cn('px-2 py-2.5 tracking-wide uppercase hover:opacity-60', 'child' in l ? 'pl-6 text-xs text-muted-foreground' : 'text-xs')}>{l.label}</Link>
            ))}
            <Link to="/contact" onClick={() => setMenuOpen(false)} className="px-2 py-2.5 text-xs tracking-wide uppercase hover:opacity-60">Contact</Link>
          </nav>
        </SheetContent>
      </Sheet>

      <main className="flex-1">
        <Outlet />
      </main>

      <StoreFooter theme={theme} config={config} storeName={storeName} footerText={sf?.footer_text} />
      {wa && (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp"
          className="fixed right-4 bottom-4 z-40 flex h-11 items-center gap-2 rounded-full bg-zinc-200/90 px-4 text-sm font-medium text-zinc-900 shadow-lg backdrop-blur transition-transform hover:scale-105">
          <MessageCircle className="size-4" /> Chat
        </a>
      )}
      <CartDrawer />
    </div>
    </StoreThemeContext.Provider>
  )
}

type NavItem = MenuLink & { children?: MenuLink[] }

/** Desktop menu: what fits is shown, the rest goes under "More". */
function MainNav({ menu, linkClass }: { menu: NavItem[]; linkClass: string }) {
  const ref = useRef<HTMLElement>(null)
  const [fit, setFit] = useState(menu.length)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-nav-item]'))
      const room = el.clientWidth - 70
      let used = 0
      let n = 0
      for (const it of items) { used += it.offsetWidth + 24; if (used > room) break; n++ }
      setFit(n >= menu.length ? menu.length : Math.max(n, 1))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [menu.length])
  const more = menu.slice(fit)
  return (
    <nav ref={ref} className="relative hidden w-full min-w-0 flex-1 items-center gap-6 lg:flex" aria-label="Main">
      {menu.map((m, i) => (
        <div key={m.label + m.link} data-nav-item className={cn('group/menu relative shrink-0', i >= fit && 'invisible absolute')}>
          <NavLink to={m.link} className={({ isActive }) => cn(linkClass, isActive && 'underline underline-offset-4')}>{m.label}</NavLink>
          {!!m.children?.length && <NavDropdown items={m.children} />}
        </div>
      ))}
      {more.length > 0 && (
        <div className="group/menu relative shrink-0">
          <button type="button" className={linkClass}>More</button>
          <NavDropdown items={more.flatMap((m) => [m, ...(m.children ?? [])])} />
        </div>
      )}
    </nav>
  )
}

function NavDropdown({ items }: { items: MenuLink[] }) {
  return (
    <div className="invisible absolute top-full left-0 z-50 min-w-48 pt-5 opacity-0 transition-opacity group-hover/menu:visible group-hover/menu:opacity-100">
      <div className="grid gap-2.5 border border-foreground/10 bg-background p-5 text-foreground shadow-sm">
        {items.map((c) => <Link key={c.label + c.link} to={c.link} className="text-xs text-muted-foreground hover:text-foreground">{c.label}</Link>)}
      </div>
    </div>
  )
}

function StoreFooter({ theme, config, storeName, footerText }: { theme: StoreTheme; config: StoreConfig | undefined; storeName: string; footerText?: string }) {
  const social = Object.entries(config?.store.social ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())
  const links = theme.footer.links.length ? theme.footer.links : [
    { label: 'Track your order', link: '/track-order' }, { label: 'Privacy policy', link: '/policies/privacy' }, { label: 'Refund policy', link: '/policies/returns' },
    { label: 'Shipping policy', link: '/policies/shipping' }, { label: 'Terms of service', link: '/policies/terms' }, { label: 'Contact', link: '/contact' },
  ]
  const contact = theme.footer.contact_text || [config?.store.email, config?.store.phone && `Hotline ${config.store.phone}`, config?.store.address].filter(Boolean).join('\n')
  const payments = config ? [...(config.payments.cod_enabled ? ['Cash on delivery'] : []), ...config.payments.providers.map((p) => p.label)].filter((p, i, all) => all.indexOf(p) === i) : []
  return (
    <SectionFrame id="footer" label="Footer">
      <footer className="mt-16 text-xs" style={{ background: theme.colors.footer_bg, color: theme.colors.footer_text }}>
        <div className="mx-auto grid max-w-[1600px] border-b border-current/15 md:grid-cols-3 [&>*]:border-current/15 md:[&>*+*]:border-l">
          <div className="space-y-1.5 px-4 py-8 sm:px-8">
            <p className="font-semibold">{theme.footer.contact_title}:</p>
            {contact ? <p className="leading-relaxed whitespace-pre-line opacity-80">{contact}</p> : <p className="opacity-60">{storeName}</p>}
          </div>
          <div className="flex items-start gap-4 px-4 py-8 sm:px-8">
            {social.map(([k, v]) => {
              const Icon = k === 'instagram' ? Instagram : k === 'facebook' ? Facebook : MessageCircle
              return <a key={k} href={String(v).startsWith('http') ? String(v) : `https://${k}.com/${String(v).replace(/^@/, '')}`} target="_blank" rel="noreferrer" aria-label={k} className="opacity-80 hover:opacity-100"><Icon className="size-4" /></a>
            })}
          </div>
          <nav className="flex flex-wrap content-start gap-x-5 gap-y-2 px-4 py-8 sm:px-8" aria-label="Footer">
            {links.map((l) => <Link key={l.label + l.link} to={l.link} className="opacity-80 hover:underline hover:opacity-100">{l.label}</Link>)}
          </nav>
        </div>
        {theme.payment_badges && payments.length > 0 && (
          <div className="mx-auto flex max-w-[1600px] flex-wrap justify-center gap-2 px-4 pt-6 opacity-70">
            {payments.map((p) => <span key={p} className="border border-current/30 px-2 py-1 text-[10px] tracking-wide uppercase">{p}</span>)}
          </div>
        )}
        <div className="space-y-2 px-4 py-6 text-center">
          {theme.footer.show_currency && <p className="opacity-80">Bangladesh ({config?.store.currency ?? 'BDT'} {config?.store.currency_symbol ?? '৳'})</p>}
          <p className="opacity-70">{footerText || `© ${new Date().getFullYear()} ${storeName}. All rights reserved.`}</p>
        </div>
      </footer>
    </SectionFrame>
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

function Instagram({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
    </svg>
  )
}

function Facebook({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M13.5 21v-7.5h2.5l.4-3h-2.9V8.6c0-.9.3-1.5 1.5-1.5h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.4H8v3h2.6V21h2.9Z" />
    </svg>
  )
}

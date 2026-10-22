import { Mail, Menu, Moon, Sun, UserPlus, X } from 'lucide-react'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useLocation } from 'react-router'
import { Wordmark } from '@/components/brand/logo'
import { SocialLinks } from '@/components/brand/social'
import { applySeo } from '@/features/storefront/seo-head'
import { captureNavigation } from '@/lib/attribution'
import { siteHead } from './site-head'
import { trackSite } from './site-pixel'
import { SUPPORT_EMAIL } from './site-meta'

// The frame every page of the Fullfilio website shares: header, footer and
// the page background. Section links point at the home page ("/#…") so they
// work from any page.

// --- black (default) or white version, remembered in this browser -------------
type SiteTheme = 'dark' | 'light'
const THEME_KEY = 'fullfilio.site-theme'
const listeners = new Set<() => void>()
function readTheme(): SiteTheme {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
}
let current: SiteTheme = typeof window === 'undefined' ? 'dark' : readTheme()
function setSiteTheme(next: SiteTheme) {
  current = next
  try { localStorage.setItem(THEME_KEY, next) } catch { /* private mode: this visit only */ }
  for (const l of listeners) l()
}
export function useSiteTheme(): SiteTheme {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => current, () => 'dark')
}

function ThemeToggle() {
  const theme = useSiteTheme()
  const light = theme === 'light'
  return (
    <button type="button" onClick={() => setSiteTheme(light ? 'dark' : 'light')} aria-label={light ? 'Switch to the black version' : 'Switch to the white version'}
      title={light ? 'Black version' : 'White version'} aria-pressed={light}
      className="grid size-8 place-items-center rounded-full text-(--s-muted) transition-colors hover:bg-(--s-tint-strong) hover:text-(--s-fg)">
      {light ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </button>
  )
}

/** The page root: website colours for the chosen version. */
/** Remembers how the visitor arrived (ad, tagged link, referral) so a later sign-up can say which campaign brought it. */
export function useTrackVisit() {
  const location = useLocation()
  useEffect(() => { captureNavigation(location) }, [location.pathname, location.search])
}

/** A Meta page view for each page of the website and the sign-up (site-pixel.ts). */
export function useSitePageView() {
  const { pathname } = useLocation()
  useEffect(() => { trackSite('PageView') }, [pathname])
}

export function SiteRoot({ children }: { children: ReactNode }) {
  const theme = useSiteTheme()
  useTrackVisit()
  useSitePageView()
  useEffect(() => {
    // The browser chrome (overscroll, mobile address bar) follows the page.
    const prev = document.body.style.backgroundColor
    document.body.style.backgroundColor = theme === 'light' ? '#ffffff' : '#08090a'
    return () => { document.body.style.backgroundColor = prev }
  }, [theme])
  return (
    <div className="site min-h-dvh bg-(--s-bg) font-sans text-(--s-fg) antialiased selection:bg-[#2142e7]/60 selection:text-white" data-site-theme={theme}>
      {children}
    </div>
  )
}

const NAV: Array<[string, string]> = [
  ['Product', '/#product'], ['Features', '/#orders'], ['Pricing', '/#pricing'], ['Changelog', '/#changelog'], ['Blog', '/blog'], ['Contact', '/contact'],
]

const FOOTER: Array<[string, Array<[string, string]>]> = [
  ['Product', [['Orders', '/#orders'], ['Couriers', '/#couriers'], ['Fraud check', '/#fraud'], ['Store', '/#store'], ['Pricing', '/#pricing']]],
  ['Features', [['Shopify & WooCommerce', '/#integrations'], ['Theme editor', '/#store'], ['Insights', '/#insights'], ['Changelog', '/#changelog']]],
  ['Account', [['Sign up', '/start'], ['Log in', '/admin/login'], ['Forgot password', '/admin/forgot-password']]],
  ['Company', [['Blog', '/blog'], ['Contact us', '/contact'], ['Privacy', '/privacy'], ['Terms', '/terms'], ['Data deletion', '/data-deletion']]],
]

/** A site link: in-page anchors scroll on the home page, everything else routes. */
function SiteLink({ to, className, onClick, children }: { to: string; className?: string; onClick?: () => void; children: ReactNode }) {
  const { pathname } = useLocation()
  if (to.startsWith('/#')) {
    return <a href={pathname === '/' ? to.slice(1) : to} className={className} onClick={onClick}>{children}</a>
  }
  return <Link to={to} className={className} onClick={onClick}>{children}</Link>
}

export function SiteHeader() {
  const [menu, setMenu] = useState(false)
  return (
    <header className="sticky top-0 z-50 border-b border-(--s-line) bg-(--s-bg)/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <Link to="/" aria-label="Fullfilio home" className="text-(--s-fg)"><Wordmark className="h-[18px]" /></Link>
        <nav className="ml-auto hidden items-center gap-6 text-[13px] text-(--s-muted) md:flex" aria-label="Main">
          {NAV.map(([l, h]) => <SiteLink key={l} to={h} className="transition-colors hover:text-(--s-fg)">{l}</SiteLink>)}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-4">
          <ThemeToggle />
          <Link to="/admin/login" className="hidden px-2 text-[13px] text-(--s-muted) transition-colors hover:text-(--s-fg) sm:inline">Log in</Link>
          <Link to="/start" className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-(--s-cta) px-3.5 text-[12px] font-medium text-(--s-cta-fg) transition-colors hover:bg-(--s-cta-hover) btn-3d btn-3d-site"><UserPlus className="size-3" />Sign up</Link>
          <button type="button" className="grid size-8 place-items-center md:hidden" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X className="size-4" /> : <Menu className="size-4" />}</button>
        </div>
      </div>
      {menu && (
        <nav className="grid gap-1 border-t border-(--s-line) px-5 py-3 text-sm md:hidden">
          {NAV.map(([l, h]) => <SiteLink key={l} to={h} onClick={() => setMenu(false)} className="py-2 text-(--s-fg2)">{l}</SiteLink>)}
          <Link to="/admin/login" className="py-2 text-(--s-fg2)">Log in</Link>
        </nav>
      )}
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-(--s-line)">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-[1fr_repeat(4,auto)] sm:gap-16">
        <div className="text-(--s-fg)"><Wordmark className="h-4" /></div>
        {FOOTER.map(([h, links]) => (
          <div key={h}>
            <p className="text-[13px] font-medium">{h}</p>
            <ul className="mt-4 space-y-2.5 text-[13px] text-(--s-muted)">
              {links.map(([l, href]) => <li key={l}><SiteLink to={href} className="hover:text-(--s-fg)">{l}</SiteLink></li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 pb-10">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-(--s-subtle)">
          <span>© {new Date().getFullYear()} Fullfilio. Made in Bangladesh.</span>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex items-center gap-1.5 text-(--s-muted) hover:text-(--s-fg)"><Mail className="size-3.5" />{SUPPORT_EMAIL}</a>
        </p>
        <SocialLinks linkClassName="grid size-8 place-items-center rounded-full text-(--s-muted) hover:bg-(--s-tint-strong) hover:text-(--s-fg)" />
      </div>
    </footer>
  )
}

/**
 * The page's head (title, description, canonical address, sharing tags, structured data) after a
 * click; the first page's comes from the Worker (worker/site.ts). An address the website does
 * not have keeps search engines out.
 */
export function useSiteHead(fallbackTitle: string) {
  const { pathname } = useLocation()
  useEffect(() => {
    applySeo(siteHead(pathname) ?? { status: 404, title: fallbackTitle, robots: 'noindex' })
  }, [pathname, fallbackTitle])
}

/** A website page: header, content, footer; sets the page's head. */
export function SitePage({ title, children }: { title: string; children: ReactNode }) {
  useSiteHead(title)
  return (
    <SiteRoot>
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </SiteRoot>
  )
}

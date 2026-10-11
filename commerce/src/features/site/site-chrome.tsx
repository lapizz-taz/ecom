import { Menu, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Wordmark } from '@/components/brand/logo'

// The frame every page of the Fullfilio website shares: header, footer and
// the dark page background. Section links point at the home page ("/#…") so
// they work from any page.

const NAV: Array<[string, string]> = [
  ['Product', '/#product'], ['Features', '/#orders'], ['Pricing', '/#pricing'], ['Changelog', '/#changelog'], ['Blog', '/blog'], ['Contact', '/contact'],
]

const FOOTER: Array<[string, Array<[string, string]>]> = [
  ['Product', [['Orders', '/#orders'], ['Couriers', '/#couriers'], ['Fraud check', '/#fraud'], ['Store', '/#store'], ['Pricing', '/#pricing']]],
  ['Features', [['Shopify & WooCommerce', '/#integrations'], ['Theme editor', '/#store'], ['Insights', '/#insights'], ['Changelog', '/#changelog']]],
  ['Account', [['Sign up', '/start'], ['Log in', '/admin/login'], ['Forgot password', '/admin/forgot-password']]],
  ['Company', [['Blog', '/blog'], ['Contact us', '/contact']]],
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
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#08090a]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <Link to="/" aria-label="Fullfilio home" className="text-white"><Wordmark className="h-[18px]" /></Link>
        <nav className="ml-auto hidden items-center gap-6 text-[13px] text-[#8a8f98] md:flex" aria-label="Main">
          {NAV.map(([l, h]) => <SiteLink key={l} to={h} className="transition-colors hover:text-white">{l}</SiteLink>)}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-4">
          <Link to="/admin/login" className="hidden px-2 text-[13px] text-[#8a8f98] transition-colors hover:text-white sm:inline">Log in</Link>
          <Link to="/start" className="rounded-full bg-[#f7f8f8] px-3.5 py-1.5 text-[13px] font-medium text-[#08090a] transition-colors hover:bg-white">Sign up</Link>
          <button type="button" className="grid size-8 place-items-center md:hidden" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X className="size-4" /> : <Menu className="size-4" />}</button>
        </div>
      </div>
      {menu && (
        <nav className="grid gap-1 border-t border-white/[0.06] px-5 py-3 text-sm md:hidden">
          {NAV.map(([l, h]) => <SiteLink key={l} to={h} onClick={() => setMenu(false)} className="py-2 text-[#d0d6e0]">{l}</SiteLink>)}
          <Link to="/admin/login" className="py-2 text-[#d0d6e0]">Log in</Link>
        </nav>
      )}
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-[1fr_repeat(4,auto)] sm:gap-16">
        <div className="text-white"><Wordmark className="h-4" /></div>
        {FOOTER.map(([h, links]) => (
          <div key={h}>
            <p className="text-[13px] font-medium">{h}</p>
            <ul className="mt-4 space-y-2.5 text-[13px] text-[#8a8f98]">
              {links.map(([l, href]) => <li key={l}><SiteLink to={href} className="hover:text-white">{l}</SiteLink></li>)}
            </ul>
          </div>
        ))}
      </div>
      <p className="mx-auto max-w-6xl px-5 pb-10 text-[12px] text-[#62666d]">© {new Date().getFullYear()} Fullfilio. Made in Bangladesh.</p>
    </footer>
  )
}

/** A website page: header, content, footer; sets the tab title. */
export function SitePage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = title }, [title])
  return (
    <div className="min-h-dvh bg-[#08090a] font-sans text-[#f7f8f8] antialiased selection:bg-[#2142e7]/60">
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </div>
  )
}

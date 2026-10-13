import { Link } from 'react-router'
import { LogoMark } from '@/components/brand/logo'
import { SiteRoot } from '@/features/site/site-chrome'

/** A page that does not exist on the Fullfilio website. */
export default function MarketingNotFound() {
  return (
    <SiteRoot>
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="max-w-sm">
        <LogoMark className="mx-auto size-10" />
        <p className="mt-6 font-mono text-xs text-(--s-muted)">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page doesn’t exist</h1>
        <p className="mt-2 text-sm text-(--s-muted)">The address may be mistyped, or the page has moved.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/" className="rounded-full bg-(--s-cta) px-4 py-2 text-sm font-medium text-(--s-cta-fg) hover:bg-(--s-cta-hover) btn-3d btn-3d-site">Fullfilio home</Link>
          <Link to="/admin/login" className="rounded-full border border-(--s-line-strong) px-4 py-2 text-sm text-(--s-fg2) hover:bg-(--s-tint) btn-3d btn-3d-site-ghost">Log in</Link>
        </div>
      </div>
    </main>
    </SiteRoot>
  )
}

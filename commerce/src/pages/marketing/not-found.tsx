import { Link } from 'react-router'
import { LogoMark } from '@/components/brand/logo'

/** A page that does not exist on the Fullfilio website. */
export default function MarketingNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#08090a] px-6 text-center text-[#f7f8f8]">
      <div className="max-w-sm">
        <LogoMark className="mx-auto size-10" />
        <p className="mt-6 font-mono text-xs text-[#8a8f98]">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page doesn’t exist</h1>
        <p className="mt-2 text-sm text-[#8a8f98]">The address may be mistyped, or the page has moved.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/" className="rounded-full bg-[#f7f8f8] px-4 py-2 text-sm font-medium text-[#08090a] hover:bg-white">Fullfilio home</Link>
          <Link to="/admin/login" className="rounded-full border border-white/10 px-4 py-2 text-sm text-[#d0d6e0] hover:bg-white/[0.04]">Log in</Link>
        </div>
      </div>
    </main>
  )
}

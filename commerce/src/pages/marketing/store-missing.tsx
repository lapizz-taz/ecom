import { Store } from 'lucide-react'
import { LogoMark } from '@/components/brand/logo'

/** A store address that does not exist, or whose online store is switched off. */
export default function StoreMissing() {
  const home = `${location.protocol}//${location.host}/`
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-full border bg-card text-muted-foreground"><Store className="size-5" /></span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">This store isn’t available</h1>
        <p className="mt-2 text-sm text-muted-foreground">The address may be mistyped, or the business has closed its online store. Check the link the shop gave you.</p>
        <a href={home.includes('/s/') ? '/' : home} className="mt-6 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <LogoMark className="size-5" /> Powered by Fullfilio
        </a>
      </div>
    </main>
  )
}

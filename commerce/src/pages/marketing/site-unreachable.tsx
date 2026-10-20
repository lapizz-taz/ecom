import { RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The first lookup for this address failed: no guess at what the address shows, only a retry. */
export default function SiteUnreachable() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="max-w-sm" role="alert">
        <span className="mx-auto grid size-12 place-items-center rounded-full border bg-card text-muted-foreground"><WifiOff className="size-5" /></span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">This site could not be reached</h1>
        <p className="mt-2 text-sm text-muted-foreground">The connection failed before the page could load. Check your internet connection and try again.</p>
        <Button className="mt-6" onClick={() => location.reload()}><RefreshCw /> Try again</Button>
      </div>
    </main>
  )
}

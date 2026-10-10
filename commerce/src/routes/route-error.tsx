import { AlertTriangle, ArrowLeft, Compass, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isRouteErrorResponse, Link, useLocation, useRouteError } from 'react-router'
import { Button } from '@/components/ui/button'
import { reportError } from '@/lib/monitoring'
import { cn } from '@/lib/utils'

const RELOAD_KEY = 'app-update-reload'
const AUTO_RELOAD_MS = 2500

/** A new deployment replaced the old code: reload once on our own (never in a loop). */
function useAutoReload(enabled: boolean) {
  const [left, setLeft] = useState(AUTO_RELOAD_MS)
  const [auto] = useState(() => {
    if (!enabled) return false
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
      return Date.now() - last > 60_000
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (!auto) return
    const started = Date.now()
    const tick = setInterval(() => {
      const remaining = Math.max(0, AUTO_RELOAD_MS - (Date.now() - started))
      setLeft(remaining)
      if (remaining === 0) {
        clearInterval(tick)
        try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* private mode */ }
        window.location.reload()
      }
    }, 100)
    return () => clearInterval(tick)
  }, [auto])
  return { auto, progress: 1 - left / AUTO_RELOAD_MS }
}

export function RouteError() {
  const error = useRouteError()
  const { pathname } = useLocation()
  const notFound = isRouteErrorResponse(error) && error.status === 404
  // A new deployment can invalidate lazy chunks; a reload fetches the new ones.
  const chunkError = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message)
  const { auto, progress } = useAutoReload(chunkError)
  const home = pathname.startsWith('/admin') ? '/admin' : '/'
  useEffect(() => {
    if (!notFound && !chunkError) reportError(error, { boundary: 'route' })
  }, [error, notFound, chunkError])

  const kind = notFound ? 'missing' : chunkError ? 'update' : 'crash'
  const Icon = kind === 'update' ? Sparkles : kind === 'missing' ? Compass : AlertTriangle
  const title = kind === 'update' ? 'A new version is ready' : kind === 'missing' ? 'Page not found' : 'Something went wrong'
  const body = kind === 'update'
    ? 'We just shipped an update. Reloading gets you the latest version — nothing you saved is lost.'
    : kind === 'missing' ? 'The page you are looking for has moved or no longer exists.'
      : 'This page hit an error and we have been notified. Reloading usually fixes it.'

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-sm animate-in fade-in-0 zoom-in-95 duration-300">
        <div className="relative overflow-hidden rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
          <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto size-48 rounded-full bg-foreground/5 blur-2xl" aria-hidden />
          <div className={cn('relative mx-auto mb-5 grid size-14 place-items-center rounded-2xl border bg-background shadow-sm', kind === 'crash' && 'text-red-600')}>
            <Icon className={cn('size-6', kind === 'update' && auto && 'animate-pulse')} />
          </div>
          <h1 className="relative text-xl font-semibold tracking-tight text-balance">{title}</h1>
          <p className="relative mt-2 text-sm text-pretty text-muted-foreground">{body}</p>

          {kind === 'update' && auto && (
            <div className="relative mt-5" role="status" aria-live="polite">
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground transition-[width] duration-100 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Updating automatically…</p>
            </div>
          )}

          <div className="relative mt-6 grid gap-2">
            {kind !== 'missing' && (
              <Button size="lg" className="w-full" onClick={() => window.location.reload()}>
                <RefreshCw /> {kind === 'update' ? 'Reload now' : 'Reload page'}
              </Button>
            )}
            <Button size="lg" variant={kind === 'missing' ? 'default' : 'ghost'} className="w-full" asChild>
              <Link to={home}>{kind === 'missing' ? <ArrowLeft /> : null} Go to {home === '/admin' ? 'dashboard' : 'home'}</Link>
            </Button>
          </div>
        </div>
        {kind === 'crash' && error instanceof Error && (
          <p className="mt-3 truncate text-center font-mono text-[11px] text-muted-foreground" title={error.message}>{error.message}</p>
        )}
      </div>
    </div>
  )
}

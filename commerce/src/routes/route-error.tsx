import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { Button } from '@/components/ui/button'

export function RouteError() {
  const error = useRouteError()
  const notFound = isRouteErrorResponse(error) && error.status === 404
  // A new deployment can invalidate lazy chunks; a reload fetches the new ones.
  const chunkError = error instanceof Error && /dynamically imported module|Loading chunk/i.test(error.message)
  if (import.meta.env.DEV) console.error(error)
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">{notFound ? 'Page not found' : chunkError ? 'A new version is available' : 'Something went wrong'}</h1>
      <p className="text-sm text-muted-foreground">
        {notFound ? 'The page you are looking for does not exist.' : chunkError ? 'Reload the page to continue.' : 'Please reload the page. If this keeps happening, contact support.'}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
        <Button asChild><Link to="/">Go home</Link></Button>
      </div>
    </div>
  )
}

import { Link, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const admin = useLocation().pathname.startsWith('/admin')
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-24 text-center">
      <p className="text-5xl font-semibold">404</p>
      <h1 className="text-lg font-medium">Page not found</h1>
      <Button asChild><Link to={admin ? '/admin' : '/'}>{admin ? 'Back to dashboard' : 'Back to the store'}</Link></Button>
    </div>
  )
}

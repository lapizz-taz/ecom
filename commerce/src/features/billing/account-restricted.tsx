import { Lock } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { PlanSummary } from '@/features/billing/plan-summary'

/** Shown instead of the admin when the account is blocked (expired, suspended or closed). */
export function AccountRestricted({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-4 p-4 sm:p-8">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-red-50 p-2.5 text-red-600"><Lock className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">This account is restricted</h1>
          <p className="text-sm text-muted-foreground">Signed in as {email}. Your data is kept and nothing has been deleted.</p>
        </div>
        <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
      </div>
      <PlanSummary compact />
    </div>
  )
}

/** A thin bar over every page while the account is read-only. */
export function ReadOnlyBanner() {
  return (
    <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <span>Read-only: you can view and export, but changes are paused. Your store still takes orders.</span>
      <Link to="/admin/settings/billing" className="font-medium underline">See why</Link>
    </div>
  )
}

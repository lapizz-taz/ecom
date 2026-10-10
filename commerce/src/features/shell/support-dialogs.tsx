import { useMutation } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { reportIssue } from '@/services/search'
import { GO_SHORTCUTS } from './nav-config'

const Key = ({ children }: { children: string }) => (
  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">{children}</kbd>
)

const GUIDE = [
  { title: 'Web Orders', body: 'New orders from the website and staff. Call or check the customer, then Approve — or set a status such as No answer or Call back later.' },
  { title: 'Approved Orders', body: 'Fulfilment: print labels, book Pathao / Steadfast / RedX, scan parcels out, then follow delivery, returns and RTS. Courier updates arrive by webhook.' },
  { title: 'Customer Verification', body: 'Orders held by the fraud check: see the courier history and past orders, then approve, ask for an advance or reject.' },
  { title: 'Scan To Update', body: 'Scan a label (USB scanner or camera) to mark parcels ready, shipped or returned. A parcel scanned twice is flagged, never processed twice.' },
  { title: 'Returns', body: 'Scanning a return as Returned puts the items back in stock and writes the stock movement, once.' },
]

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Help Center</DialogTitle>
          <DialogDescription>Keyboard shortcuts and how the main screens fit together.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 text-sm">
          <section>
            <h3 className="mb-2 font-medium">Keyboard shortcuts</h3>
            <ul className="grid gap-1.5">
              <li className="flex items-center justify-between"><span>Quick search</span><span className="flex gap-1"><Key>Ctrl</Key><Key>K</Key></span></li>
              <li className="flex items-center justify-between"><span>Collapse or expand the menu</span><span className="flex gap-1"><Key>Ctrl</Key><Key>B</Key></span></li>
              <li className="flex items-center justify-between"><span>This help</span><Key>?</Key></li>
              {Object.entries(GO_SHORTCUTS).filter(([, s]) => !s.permission || can(s.permission)).map(([key, s]) => (
                <li key={key} className="flex items-center justify-between"><span>Go to {s.label}</span><span className="flex gap-1"><Key>G</Key><Key>{key.toUpperCase()}</Key></span></li>
              ))}
            </ul>
          </section>
          <section className="grid gap-3">
            <h3 className="font-medium">How it works</h3>
            {GUIDE.map((g) => (
              <div key={g.title}>
                <p className="font-medium">{g.title}</p>
                <p className="text-muted-foreground">{g.body}</p>
              </div>
            ))}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Who to ask inside the business: the owners and admins of this store. */
export function ContactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { staff } = useStaffDirectory()
  const admins = staff.filter((s) => s.is_active && ['OWNER', 'ADMIN'].includes(s.role))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Contact Support</DialogTitle>
          <DialogDescription>Owners and admins can change roles, settings and integrations. For a problem with the system itself, use Support → My Bug Reports — you can follow the fix there.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {admins.length === 0 && <li className="text-sm text-muted-foreground">No active owner or admin found.</li>}
          {admins.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.full_name}</span>
                <span className="block text-xs text-muted-foreground">{a.role === 'OWNER' ? 'Owner' : 'Admin'}</span>
              </span>
              <a href={`mailto:${a.email}`} className="flex items-center gap-1.5 text-sm text-brand hover:underline"><Mail className="size-4" />{a.email}</a>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

export function ReportIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const location = useLocation()
  const [text, setText] = useState('')
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () => reportIssue(text.trim(), {
      page: location.pathname + location.search,
      browser: navigator.userAgent,
      screen: `${window.innerWidth}×${window.innerHeight}`,
    }),
    onSuccess: (num) => {
      toast.success(`Bug #${num} reported`, { description: 'Follow it and see replies in Support → My Bug Reports.' })
      setText('')
      onOpenChange(false)
    },
  })
  return (
    <FormDialog open={open} onOpenChange={(o) => { if (!o) send.reset(); onOpenChange(o) }} title="Report an issue"
      description="Say what you were doing and what went wrong. The page you are on and your browser are attached."
      submitLabel="Send report" onSubmit={() => send.mutate()} busy={send.isPending} disabled={text.trim().length < 5}>
      <Field label="What happened?" htmlFor="issue-text" required>
        <Textarea id="issue-text" rows={5} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Booking order ISO-10233 with Pathao shows “Store not found”." />
      </Field>
      {send.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(send.error as Error).message}</p>}
    </FormDialog>
  )
}

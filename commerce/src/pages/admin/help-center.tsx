import { ArrowRight, Bug, ChevronDown, Keyboard, LifeBuoy, Lightbulb, Mail, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { GO_SHORTCUTS } from '@/features/shell/nav-config'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { cn } from '@/lib/utils'

interface Article { topic: string; q: string; a: string; to?: string; permission?: string }

const ARTICLES: Article[] = [
  { topic: 'Orders', q: 'How does an order go from new to delivered?', to: '/admin/orders/web', permission: 'orders.view',
    a: 'New website and staff orders land in Web Orders. Call or check the customer, then Approve. Approved orders move to Approved Orders: print the label, book the courier, scan the parcel out (Shipped). Courier webhooks then mark it Delivered or Returned automatically.' },
  { topic: 'Orders', q: 'What happens when the same customer orders twice?', to: '/admin/orders/approved', permission: 'orders.view',
    a: 'New web orders from a phone that already has an open web order are merged automatically. Approved orders are never merged — they are flagged as possible duplicates instead. Use Actions → Duplicates on Approved Orders to review them.' },
  { topic: 'Orders', q: 'When does an order become Return pending, and when is stock added back?', permission: 'orders.view',
    a: 'Return pending means the courier reported the parcel as returning. Stock is added back only when you scan the parcel in as Returned (or bulk-update it to Returned) — once, never twice. A delivered order is final and cannot be scanned in as a return.' },
  { topic: 'Orders', q: 'How do I set where an order came from?', to: '/admin/settings?tab=sources', permission: 'orders.update',
    a: 'On a phone, chat or walk-in order, pick the source on the order (or when creating it). The list is managed in Settings → Order Sources. Website orders get their source from the visit; if there is no data they show as Unattributed — never guessed.' },
  { topic: 'Couriers', q: 'How do I connect Pathao, Steadfast, RedX or Carrybee?', to: '/admin/couriers', permission: 'couriers.view',
    a: 'Settings → Courier Integration. Enter your merchant account; the keys are stored in the server vault and never sent to browsers. Then book parcels from Approved Orders one by one or in bulk.' },
  { topic: 'Couriers', q: 'Why does a parcel show a different status than the courier panel?', to: '/admin/couriers?tab=webhooks', permission: 'couriers.view',
    a: 'Statuses come from courier webhooks. Open the Webhook Logs to see every event received for the parcel; failed events are retried automatically. Use Actions → Refresh courier status on Approved Orders to pull the latest.' },
  { topic: 'Stock', q: 'How does stock sync with Shopify?', to: '/admin/store/sync', permission: 'inventory.view',
    a: 'Fullfilio is the source of stock. Changes push to Shopify; with two-way sync, a stock change made in Shopify is adopted after a short grace period. A Shopify restock for an order already returned here is ignored so it is not counted twice.' },
  { topic: 'Stock', q: 'How are reorder suggestions calculated?', to: '/admin/inventory?view=alerts', permission: 'inventory.view',
    a: 'Daily sales speed blends the last 7, 30 and 90 days. Suggested order = speed × (supplier lead time + days of cover) − available − already on order. Change lead time and cover in the Low stock alerts settings.' },
  { topic: 'Payments', q: 'Is an online payment trusted from the browser?', to: '/admin/settings?tab=payments', permission: 'settings.view',
    a: 'No. bKash and PayStation payments are confirmed by the server with the gateway before the order is marked paid.' },
  { topic: 'Team', q: 'How do staff check in for attendance?', to: '/admin/hr/attendance',
    a: 'Open HRM → Attendance and press Check in (and Check out when leaving). Times use the server clock in the store time zone. Late minutes count from your shift start plus the grace time.' },
  { topic: 'Team', q: 'Someone signs in from a new phone and sees "waiting for approval"', to: '/admin/settings/devices', permission: 'devices.manage',
    a: 'Device approval is on. An admin opens Settings → Device Approvals and approves the device. Owners are never blocked.' },
  { topic: 'Calls', q: 'How do I call customers through the office PBX?', to: '/admin/settings/pbx',
    a: 'An admin connects the PBX in Settings → VoiceDrive PBX and gives you an extension. Then the Call button rings your extension first and connects the customer; every call appears in the call log.' },
  { topic: 'Security', q: 'Where are API keys and passwords kept?',
    a: 'In the server vault. Pages show only whether a service is connected and the last 4 characters of a key. Every change to settings, roles and devices is in the Audit Log.' },
]

const Key = ({ children }: { children: string }) => <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">{children}</kbd>

export default function HelpCenterPage() {
  const { can } = useAuth()
  const { staff } = useStaffDirectory()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const articles = useMemo(() => ARTICLES.filter((a) => (!a.permission || can(a.permission))
    && (!q || `${a.q} ${a.a} ${a.topic}`.toLowerCase().includes(q.toLowerCase()))), [q, can])
  const topics = [...new Set(articles.map((a) => a.topic))]
  const admins = staff.filter((s) => s.is_active && ['OWNER', 'ADMIN'].includes(s.role))

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Help Center" description="Answers to common questions, shortcuts, and how to reach the people who can help." />
      <SearchInput value={q} onChange={setQ} placeholder="Search help — e.g. return, stock, courier" className="w-full" autoFocus />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { to: '/admin/support/bugs?new=1', icon: <Bug />, title: 'Report a bug', body: 'Something broken or wrong? Tell us and follow the fix.' },
          { to: '/admin/support/feedback?new=1', icon: <Lightbulb />, title: 'Share an idea', body: 'Features you need or things to make easier.' },
          { to: '/admin/updates', icon: <Sparkles />, title: "What's new", body: 'Recent features and fixes.' },
        ].map((c) => (
          <Link key={c.to} to={c.to}>
            <Card className="h-full gap-1 p-4 transition-colors hover:bg-muted/40">
              <span className="text-brand [&_svg]:size-5">{c.icon}</span>
              <p className="font-medium">{c.title}</p>
              <p className="text-xs text-muted-foreground">{c.body}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          {!articles.length && <EmptyState title="No answer found" description="Try other words, or report it as a bug or idea." />}
          {topics.map((t) => (
            <section key={t} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">{t}</h2>
              <Card className="gap-0 divide-y p-0">
                {articles.filter((a) => a.topic === t).map((a) => {
                  const isOpen = open === a.q || !!q
                  return (
                    <div key={a.q}>
                      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40" aria-expanded={isOpen}
                        onClick={() => setOpen(open === a.q ? null : a.q)}>
                        <span className="flex-1">{a.q}</span>
                        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                      </button>
                      {isOpen && (
                        <div className="space-y-2 px-4 pb-4 text-sm text-muted-foreground">
                          <p>{a.a}</p>
                          {a.to && <Link to={a.to} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">Go there <ArrowRight className="size-3.5" /></Link>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </Card>
            </section>
          ))}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><LifeBuoy className="size-4" /> Contact</CardTitle>
              <CardDescription>Owners and admins can change roles, settings and integrations.</CardDescription></CardHeader>
            <CardContent className="grid gap-2">
              {!admins.length && <p className="text-sm text-muted-foreground">No active owner or admin found.</p>}
              {admins.map((a) => (
                <a key={a.id} href={`mailto:${a.email}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
                  <Mail className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.full_name}</span><span className="block truncate text-xs text-muted-foreground">{a.email}</span></span>
                  <Badge variant="neutral">{a.role === 'OWNER' ? 'Owner' : 'Admin'}</Badge>
                </a>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Keyboard className="size-4" /> Shortcuts</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-1.5 text-sm">
                <li className="flex items-center justify-between"><span>Quick search</span><span className="flex gap-1"><Key>Ctrl</Key><Key>K</Key></span></li>
                <li className="flex items-center justify-between"><span>Collapse menu</span><span className="flex gap-1"><Key>Ctrl</Key><Key>B</Key></span></li>
                <li className="flex items-center justify-between"><span>Help</span><Key>?</Key></li>
                {Object.entries(GO_SHORTCUTS).filter(([, s]) => !s.permission || can(s.permission)).map(([key, s]) => (
                  <li key={key} className="flex items-center justify-between"><span>{s.label}</span><span className="flex gap-1"><Key>G</Key><Key>{key.toUpperCase()}</Key></span></li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

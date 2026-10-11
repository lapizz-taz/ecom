import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Megaphone, Plus, Send } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AnnouncementComposer } from '@/features/platform/ops/announcement-composer'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, formatPercent, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  ANNOUNCEMENT_KINDS, type Announcement, type Audience, cancelAnnouncement, getAnnouncement, listAnnouncements, previewAudience, sendAnnouncement,
} from '@/services/platform-ops'

const STATUS: Record<Announcement['status'], { label: string; variant: BadgeVariant }> = {
  DRAFT: { label: 'Draft', variant: 'neutral' }, SCHEDULED: { label: 'Scheduled', variant: 'info' },
  SENT: { label: 'Sent', variant: 'success' }, CANCELLED: { label: 'Withdrawn', variant: 'neutral' },
}
const SEVERITY: Record<Announcement['severity'], BadgeVariant> = { INFO: 'neutral', WARN: 'warning', CRITICAL: 'danger' }
const kindLabel = (k: string) => ANNOUNCEMENT_KINDS.find((x) => x.value === k)?.label ?? k

export function audienceText(a: Audience, plans?: Array<{ code: string; name: string }>) {
  const demo = a.include_demo ? ' (with demo)' : ''
  if (a.type === 'ALL') return `All merchants${demo}`
  if (a.type === 'PLANS') return `Plans: ${(a.plans ?? []).map((c) => plans?.find((p) => p.code === c)?.name ?? c).join(', ')}${demo}`
  if (a.type === 'STATUSES') return `Status: ${(a.statuses ?? []).map((s) => s.toLowerCase().replace('_', ' ')).join(', ')}${demo}`
  return `${(a.merchants ?? []).length} chosen merchant(s)`
}

function SendDraftDialog({ a, onClose }: { a: Announcement; onClose: () => void }) {
  const queryClient = useQueryClient()
  const preview = useQuery({ queryKey: ['platform-announcements', 'preview', a.id], queryFn: () => previewAudience(a.audience, a.kind) })
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title={`Send “${a.title}”`}
      confirmLabel={preview.data ? `${a.publish_at && new Date(a.publish_at) > new Date() ? 'Schedule for' : 'Send to'} ${formatNumber(preview.data.count)}` : 'Send'}
      reason reasonLabel="Note for the audit log (optional)"
      description={a.publish_at && new Date(a.publish_at) > new Date() ? `It will be published ${formatDateTime(a.publish_at)}.` : 'Merchants see it in their admin right away.'}
      onConfirm={async (reason) => {
        if (!preview.data) return
        try {
          const r = await sendAnnouncement(a.id, preview.data.count, reason || undefined)
          toast.success(r.status === 'SCHEDULED' ? 'Scheduled' : `Sent to ${formatNumber(r.recipients ?? 0)} merchant(s)`)
        } finally {
          void queryClient.invalidateQueries({ queryKey: ['platform-announcements'] })
        }
      }}>
      {preview.isLoading ? <Spinner /> : preview.error ? <ErrorState error={preview.error} /> : preview.data && (
        <div className="rounded-md border p-3 text-sm">
          <p><strong>{formatNumber(preview.data.count)}</strong> merchant(s) match {audienceText(a.audience).toLowerCase()}
            {preview.data.muted > 0 && `; ${formatNumber(preview.data.muted)} turned this kind off`}.</p>
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{preview.data.sample.slice(0, 20).map((m) => `#${m.number} ${m.name}`).join(', ')}</p>
        </div>
      )}
    </ConfirmDialog>
  )
}

function DetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['platform-announcements', 'detail', id], queryFn: () => getAnnouncement(id!), enabled: !!id })
  const d = q.data
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState /> : (
          <div className="space-y-4 px-5 pb-6">
            <SheetHeader className="px-0">
              <SheetTitle>{d.title}</SheetTitle>
              <SheetDescription>{kindLabel(d.kind)} · {audienceText(d.audience)} · <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge></SheetDescription>
            </SheetHeader>
            <p className="text-sm whitespace-pre-wrap">{d.body}</p>
            {d.link && <p className="text-xs text-muted-foreground">Link: {d.link}</p>}
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md border p-2"><p className="text-lg font-semibold">{formatNumber(d.deliveries.filter((x) => x.status === 'DELIVERED').length)}</p>delivered</div>
              <div className="rounded-md border p-2"><p className="text-lg font-semibold">{formatNumber(d.deliveries.filter((x) => x.first_read_at).length)}</p>merchants read it</div>
              <div className="rounded-md border p-2"><p className="text-lg font-semibold">{formatNumber(d.deliveries.filter((x) => x.status === 'MUTED').length)}</p>turned off</div>
            </div>
            {d.deliveries.length === 0 ? <p className="text-sm text-muted-foreground">Not delivered yet.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Delivery</TableHead><TableHead>Read</TableHead></TableRow></TableHeader>
                <TableBody>{d.deliveries.map((x) => (
                  <TableRow key={x.merchant.id}>
                    <TableCell className="text-sm"><Link className="hover:underline" to={`/super-admin/merchants/${x.merchant.id}`}>#{x.merchant.number} {x.merchant.name}</Link></TableCell>
                    <TableCell className="text-xs">{x.status === 'MUTED' ? 'Turned off by the merchant' : `In app ${timeAgo(x.delivered_at)}`}</TableCell>
                    <TableCell className="text-xs">{x.first_read_at ? `${timeAgo(x.first_read_at)} · ${x.readers} reader(s)` : '—'}</TableCell>
                  </TableRow>))}</TableBody>
              </Table>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default function NotificationsPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ open: '' })
  const [composing, setComposing] = useState(false)
  const [sending, setSending] = useState<Announcement | null>(null)
  const [withdrawing, setWithdrawing] = useState<Announcement | null>(null)
  const q = useQuery({ queryKey: ['platform-announcements'], queryFn: listAnnouncements })
  const cancel = useMutation({
    mutationFn: (v: { id: string; reason: string }) => cancelAnnouncement(v.id, v.reason),
    onSuccess: () => { toast.success('Withdrawn'); void queryClient.invalidateQueries({ queryKey: ['platform-announcements'] }) },
  })
  const d = q.data
  const sent30 = d?.rows.filter((a) => a.status === 'SENT' && a.sent_at && Date.now() - new Date(a.sent_at).getTime() < 30 * 864e5) ?? []
  const delivered = sent30.reduce((s, a) => s + (a.delivered ?? 0), 0)
  const read = sent30.reduce((s, a) => s + (a.read_merchants ?? 0), 0)
  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" description="Announcements to merchants inside their admin: maintenance, feature releases, billing, integration problems, usage limits and recharge reminders. Delivery and reads are tracked per merchant."
        actions={d?.can.create && <Button onClick={() => setComposing(true)}><Plus /> New announcement</Button>} />
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Channel: in-app only. Email and SMS to merchants are not connected for platform announcements yet, so nothing is sent outside the app.
        Merchants can turn off feature news, recharge reminders and general notices under Settings → Notifications; service notices always reach them.
      </p>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <TableSkeleton rows={5} cols={6} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Sent in 30 days" value={formatNumber(sent30.length)} icon={<Megaphone />} />
            <StatCard label="Delivered in 30 days" value={formatNumber(delivered)} hint="merchant inboxes" />
            <StatCard label="Read rate (30 days)" value={delivered ? formatPercent((read / delivered) * 100) : '—'} hint="merchants with at least one reader" />
            <StatCard label="Waiting" value={formatNumber(d.rows.filter((a) => a.status === 'DRAFT' || a.status === 'SCHEDULED').length)} hint="drafts and scheduled" />
          </div>
          <Card className="gap-0 overflow-hidden py-0">
            {d.rows.length === 0 ? <EmptyState icon={<Megaphone />} title="No announcements yet" description="Write one to tell merchants about maintenance, a new feature or a billing change." /> : (
              <div className="overflow-x-auto"><Table>
                <TableHeader><TableRow><TableHead>Announcement</TableHead><TableHead>Who</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Delivered</TableHead><TableHead className="text-right">Read</TableHead><TableHead>When</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{d.rows.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => update({ open: a.id })}>
                    <TableCell className="max-w-sm">
                      <p className="truncate text-sm font-medium">{a.title}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{kindLabel(a.kind)} <Badge variant={SEVERITY[a.severity]} className="text-[10px]">{a.severity.toLowerCase()}</Badge>
                        {a.source !== 'MANUAL' && <span>· by {a.source === 'AUTOMATION' ? 'an automation rule' : 'an incident'}</span>}</p>
                    </TableCell>
                    <TableCell className="text-xs">{audienceText(a.audience, d.plans)}</TableCell>
                    <TableCell><Badge variant={STATUS[a.status].variant}>{STATUS[a.status].label}</Badge></TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{a.status === 'SENT' ? <>{formatNumber(a.delivered)}{a.muted ? <span className="text-muted-foreground"> (+{a.muted} off)</span> : null}</> : '—'}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{a.status === 'SENT' ? formatNumber(a.read_merchants) : '—'}</TableCell>
                    <TableCell className="text-xs">{a.sent_at ? timeAgo(a.sent_at) : a.publish_at ? `for ${formatDateTime(a.publish_at)}` : `created ${timeAgo(a.created_at)}`}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        {d.can.manage && a.status === 'DRAFT' && <Button size="sm" variant="outline" onClick={() => setSending(a)}><Send /> Send</Button>}
                        {d.can.manage && a.status !== 'CANCELLED' && <Button size="sm" variant="ghost" aria-label="Withdraw" onClick={() => setWithdrawing(a)}><Ban /></Button>}
                      </div>
                    </TableCell>
                  </TableRow>))}</TableBody>
              </Table></div>
            )}
          </Card>
        </>
      )}
      {composing && <AnnouncementComposer onClose={() => setComposing(false)} />}
      {sending && <SendDraftDialog a={sending} onClose={() => setSending(null)} />}
      {withdrawing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setWithdrawing(null)} title={`Withdraw “${withdrawing.title}”?`} destructive confirmLabel="Withdraw"
          description={withdrawing.status === 'SENT' ? 'It disappears from merchants\' admin. Delivery and read records are kept.' : 'It will not be sent.'}
          reason reasonRequired reasonLabel="Why (at least 5 characters)"
          onConfirm={(reason) => cancel.mutateAsync({ id: withdrawing.id, reason })} />
      )}
      <DetailSheet id={state.open || null} onClose={() => update({ open: '' })} />
    </div>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Megaphone } from 'lucide-react'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { AnnouncementLink, KIND_LABEL, SEVERITY_VARIANT, useMarkRead, useMyAnnouncements } from '@/features/shell/platform-announcements'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type AnnouncementKind, saveAnnouncementPreferences } from '@/services/platform-ops'

export default function AnnouncementsPage() {
  const { can, access } = useAuth()
  const queryClient = useQueryClient()
  const q = useMyAnnouncements()
  const read = useMarkRead()
  const prefs = useMutation({
    mutationFn: saveAnnouncementPreferences,
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['my-announcements'] }) },
  })
  const d = q.data
  const unread = d?.items.filter((i) => !i.read) ?? []
  const toggle = (k: AnnouncementKind, on: boolean) => {
    const muted = new Set(d?.muted ?? [])
    if (on) muted.delete(k)
    else muted.add(k)
    prefs.mutate([...muted])
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Messages from the platform" description="Maintenance, billing, integration and feature news from the Fullfilio team."
        actions={unread.length > 0 && !access?.support_session && (
          <Button variant="outline" size="sm" disabled={read.isPending} onClick={async () => { for (const a of unread) await read.mutateAsync(a.id) }}>Mark all read</Button>
        )} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState /> : (
        <>
          {d.items.length === 0 ? <EmptyState icon={<Megaphone />} title="No messages" description="Messages from the platform team appear here." /> : (
            <div className="space-y-2">
              {d.items.map((a) => (
                <Card key={a.id} className={cn('gap-1.5 p-4', !a.read && 'border-brand/40')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={SEVERITY_VARIANT[a.severity]}>{KIND_LABEL[a.kind]}</Badge>
                    {!a.read && <Badge variant="info">Unread</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(a.sent_at)}</span>
                  </div>
                  <p className="font-medium">{a.title}</p>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">{a.body}</p>
                  <div className="flex items-center gap-3">
                    <AnnouncementLink link={a.link} />
                    {!a.read && !access?.support_session && <button type="button" className="text-xs underline" onClick={() => read.mutate(a.id)}>Mark read</button>}
                  </div>
                </Card>
              ))}
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What we send you</CardTitle>
              <CardDescription>Maintenance, billing, integration problems and usage limits always reach you. You can turn the rest off.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.optional_kinds.map((k) => (
                <label key={k} className="flex items-center justify-between gap-3 text-sm">
                  <span>{KIND_LABEL[k]}</span>
                  <Switch checked={!d.muted.includes(k)} disabled={!can('settings.manage') || prefs.isPending || !!access?.support_session}
                    onCheckedChange={(on) => toggle(k, on)} aria-label={`${KIND_LABEL[k]} messages`} />
                </label>
              ))}
              {!can('settings.manage') && <p className="text-xs text-muted-foreground">Only staff who manage settings can change this.</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

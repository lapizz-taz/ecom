import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, MessageCircleReply, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { PLATFORM, PlatformIcon } from '@/features/inbox/ui'
import { toUserMessage } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  deleteSavedReply, disconnectChannel, type InboxChannel, inboxConfig, inboxOverview, type MetaConnectKind, metaConnectStart, savedReplies,
  saveSavedReply, setChannelComments,
} from '@/services/inbox'

const STEPS: Array<{ icon: typeof Lock; title: string; text: string }> = [
  { icon: Lock, title: 'Sign in with Facebook', text: 'Log in to Facebook and allow Fullfilio. Your password never comes to Fullfilio.' },
  { icon: ShieldCheck, title: 'Pick Pages, Instagram & WhatsApp', text: 'Choose which Pages, Instagram accounts and WhatsApp numbers to connect. You can change this any time.' },
  { icon: MessageCircleReply, title: 'Reply from one inbox', text: 'Messages and comments arrive in the inbox; replies go out from the same Page, account or number.' },
]

export default function InboxChannelsPage() {
  const { can } = useAuth()
  const manage = can('inbox.manage')
  const qc = useQueryClient()
  const overview = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview })
  const config = useQuery({ queryKey: ['inbox-config'], queryFn: inboxConfig })
  const [removing, setRemoving] = useState<InboxChannel | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    void qc.invalidateQueries({ queryKey: ['inbox-config'] })
  }
  const onError = (e: unknown) => toast.error(toUserMessage(e))

  // Off to Meta's login; it comes back to /admin/inbox/meta-callback.
  const start = useMutation({ mutationFn: (kind: MetaConnectKind) => metaConnectStart(kind), onSuccess: (r) => window.location.assign(r.url), onError })
  const comments = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => setChannelComments(id, on), onSuccess: refresh, onError })

  if (overview.isLoading || config.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const ready = !!config.data?.ready
  const whatsapp = !!config.data?.whatsapp
  const channels = overview.data!.channels
  const busy = (k: MetaConnectKind) => start.isPending && start.variables === k

  return (
    <div className="space-y-4">
      <MessagingTabs unread={overview.data!.counts.unread} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connect channels</CardTitle>
              <CardDescription>Sign in with Facebook to bring your Page, Instagram and WhatsApp messages and comments into Fullfilio.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!ready ? (
                <p className="rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm">Connecting with Facebook is not switched on yet. Fullfilio is finishing the setup with Meta; this page will let you connect as soon as it is ready.</p>
              ) : manage ? (
                <div className="flex flex-wrap gap-2">
                  <Button className="gap-2 bg-[#1877F2] text-white hover:bg-[#1877F2]/90" disabled={start.isPending} onClick={() => start.mutate('PAGES')}>
                    {busy('PAGES') ? <Spinner /> : <PlatformIcon platform="FACEBOOK" className="size-4 brightness-0 invert" />} Continue with Facebook
                  </Button>
                  <Button variant="outline" className="gap-2" disabled={start.isPending || !whatsapp} onClick={() => start.mutate('WHATSAPP')}
                    title={whatsapp ? undefined : 'Opens once Meta approves Fullfilio for WhatsApp'}>
                    {busy('WHATSAPP') ? <Spinner /> : <PlatformIcon platform="WHATSAPP" className="size-4" />} Connect WhatsApp
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Ask an admin to connect channels.</p>
              )}
              {ready && manage && !whatsapp && <p className="text-xs text-muted-foreground">WhatsApp opens once Meta approves Fullfilio as a WhatsApp provider. Facebook Pages and Instagram work now.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connected channels</CardTitle>
              <CardDescription>Messages and comments from these arrive in the inbox. Replies go out from the same Page, account or number.</CardDescription>
            </CardHeader>
            <CardContent>
              {channels.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing connected yet.</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {channels.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                      {c.avatar_url ? <img src={c.avatar_url} alt="" className="size-9 rounded-full object-cover" /> : <PlatformIcon platform={c.platform} className="size-9" />}
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {c.name}
                          <Badge variant={c.status === 'OK' ? 'success' : c.status === 'FAILED' ? 'danger' : 'neutral'}>{c.status === 'OK' ? 'Connected' : c.status === 'FAILED' ? 'Needs reconnecting' : 'Disconnected'}</Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {PLATFORM[c.platform].label}{c.display_phone && ` · ${c.display_phone}`}
                          {c.last_event_at ? ` · last message ${timeAgo(c.last_event_at)}` : ' · no messages yet'}
                        </p>
                        {c.status_error && <p className="mt-1 text-xs text-destructive">{c.status_error}</p>}
                      </div>
                      {c.platform !== 'WHATSAPP' && c.status !== 'DISCONNECTED' && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch checked={c.receive_comments} disabled={!manage} onCheckedChange={(on) => comments.mutate({ id: c.id, on })} /> Comments
                        </label>
                      )}
                      {manage && ready && c.status !== 'OK' && (
                        <Button size="sm" variant="outline" className="gap-1.5" disabled={start.isPending || (c.platform === 'WHATSAPP' && !whatsapp)}
                          onClick={() => start.mutate(c.platform === 'WHATSAPP' ? 'WHATSAPP' : 'PAGES')}><RefreshCw /> Reconnect</Button>
                      )}
                      {manage && c.status !== 'DISCONNECTED' && (
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving(c)}>Disconnect</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <SavedRepliesCard manage={manage} />
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">How it works</CardTitle>
            <CardDescription>Fullfilio is a Meta app; you only sign in and choose.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted"><s.icon className="size-4" /></span>
                  <div className="text-sm">
                    <p className="font-medium">{i + 1}. {s.title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted-foreground">To remove access later, disconnect here or in Facebook → Settings → Business integrations.</p>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive title={`Disconnect ${removing?.name}?`}
        description="Its access is deleted and new messages stop arriving. Conversations already in the inbox stay." confirmLabel="Disconnect"
        onConfirm={async () => {
          try { await disconnectChannel(removing!.id); toast.success('Disconnected'); refresh() } catch (e) { onError(e); throw e }
        }} />
    </div>
  )
}

function SavedRepliesCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['inbox-saved-replies'], queryFn: savedReplies })
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string } | null>(null)
  const done = () => void qc.invalidateQueries({ queryKey: ['inbox-saved-replies'] })
  const save = useMutation({ mutationFn: () => saveSavedReply(edit!), onSuccess: () => { setEdit(null); done() }, onError: (e) => toast.error(toUserMessage(e)) })
  const del = useMutation({ mutationFn: deleteSavedReply, onSuccess: done, onError: (e) => toast.error(toUserMessage(e)) })
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Saved replies</CardTitle>
          <CardDescription>Answers your team sends often: price, delivery charge, payment numbers.</CardDescription>
        </div>
        {manage && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEdit({ title: '', body: '' })}><Plus /> Add</Button>}
      </CardHeader>
      <CardContent>
        {!list.data?.length ? <p className="py-4 text-center text-sm text-muted-foreground">No saved replies yet.</p> : (
          <ul className="divide-y rounded-lg border">
            {list.data.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{r.title}</p>
                  <p className="line-clamp-2 text-xs whitespace-pre-wrap text-muted-foreground">{r.body}</p>
                </div>
                {manage && <>
                  <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEdit(r)}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => del.mutate(r.id)}><Trash2 /></Button>
                </>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{edit?.id ? 'Edit saved reply' : 'New saved reply'}</DialogTitle><DialogDescription className="sr-only">Title and text</DialogDescription></DialogHeader>
          {edit && (
            <div className="space-y-3">
              <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={80} placeholder="Delivery charge" /></Field>
              <Field label="Text"><Textarea value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={5} maxLength={2000} placeholder="Inside Dhaka ৳80, outside Dhaka ৳120. Cash on delivery." /></Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !edit?.title.trim() || !edit?.body.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

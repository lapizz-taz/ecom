import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { functionsUrl } from '@/lib/env'
import { toUserMessage } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  connectPage, connectWhatsApp, deleteSavedReply, disconnectChannel, type InboxChannel, inboxConfig, inboxOverview, savedReplies, saveInboxApp,
  saveSavedReply, setChannelComments,
} from '@/services/inbox'

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <Button size="icon-sm" variant="ghost" className="size-6" aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => undefined)}>
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export default function InboxChannelsPage() {
  const { can } = useAuth()
  const manage = can('inbox.manage')
  const qc = useQueryClient()
  const overview = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview })
  const config = useQuery({ queryKey: ['inbox-config'], queryFn: inboxConfig })
  const [app, setApp] = useState({ id: '', secret: '' })
  const [connect, setConnect] = useState<'page' | 'whatsapp' | null>(null)
  const [removing, setRemoving] = useState<InboxChannel | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    void qc.invalidateQueries({ queryKey: ['inbox-config'] })
  }
  const onError = (e: unknown) => toast.error(toUserMessage(e))

  const saveApp = useMutation({
    mutationFn: () => saveInboxApp(app.id || config.data?.app_id || '', app.secret),
    onSuccess: () => { toast.success('Meta app saved'); setApp({ id: '', secret: '' }); refresh() },
    onError,
  })
  const comments = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => setChannelComments(id, on), onSuccess: refresh, onError })

  if (overview.isLoading || config.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const cfg = config.data
  const webhook = cfg ? `${functionsUrl('inbox')}?m=${cfg.merchant_id}` : ''
  const channels = overview.data!.channels

  return (
    <div className="space-y-4">
      <MessagingTabs unread={overview.data!.counts.unread} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base">Connected channels</CardTitle>
                <CardDescription>Messages and comments from these arrive in the inbox. Replies go out from the same Page, account or number.</CardDescription>
              </div>
              {manage && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!cfg?.has_app_secret} onClick={() => setConnect('page')}>
                    <PlatformIcon platform="FACEBOOK" /> Facebook & Instagram
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!cfg?.has_app_secret} onClick={() => setConnect('whatsapp')}>
                    <PlatformIcon platform="WHATSAPP" /> WhatsApp
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {!cfg?.has_app_secret && <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs">First save your Meta app on the right (step 1), then connect your Page or number.</p>}
              {channels.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing connected yet.</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {channels.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                      {c.avatar_url ? <img src={c.avatar_url} alt="" className="size-9 rounded-full object-cover" /> : <PlatformIcon platform={c.platform} className="size-9" />}
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          {c.name}
                          <Badge variant={c.status === 'OK' ? 'success' : c.status === 'FAILED' ? 'danger' : 'neutral'}>{c.status === 'OK' ? 'Connected' : c.status === 'FAILED' ? 'Needs attention' : 'Disconnected'}</Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {PLATFORM[c.platform].label}{c.display_phone && ` · ${c.display_phone}`}{c.token_hint && ` · token ${c.token_hint}`}
                          {c.last_event_at ? ` · last message ${timeAgo(c.last_event_at)}` : ' · no messages yet'}
                        </p>
                        {c.status_error && <p className="mt-1 text-xs text-destructive">{c.status_error}</p>}
                      </div>
                      {c.platform !== 'WHATSAPP' && c.status !== 'DISCONNECTED' && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch checked={c.receive_comments} disabled={!manage} onCheckedChange={(on) => comments.mutate({ id: c.id, on })} /> Comments
                        </label>
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
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" /> Setup</CardTitle>
            <CardDescription>Uses your own Meta app (developers.facebook.com), the same one as Meta Ads works too.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-2">
              <p className="font-medium">1. Your Meta app</p>
              {cfg?.has_app_secret && <p className="text-xs text-muted-foreground">Saved: App ID {cfg.app_id}. Paste a new secret only to change it.</p>}
              {manage && (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); saveApp.mutate() }}>
                  <Input value={app.id} onChange={(e) => setApp({ ...app, id: e.target.value })} placeholder={cfg?.app_id ?? 'App ID'} inputMode="numeric" className="h-8" aria-label="App ID" />
                  <Input value={app.secret} onChange={(e) => setApp({ ...app, secret: e.target.value })} placeholder="App Secret" type="password" className="h-8" aria-label="App Secret" autoComplete="off" />
                  <Button size="sm" type="submit" disabled={saveApp.isPending || !(app.id || cfg?.app_id) || (!app.secret && !cfg?.has_app_secret)}>
                    {saveApp.isPending && <Spinner />} Save app
                  </Button>
                </form>
              )}
            </div>
            {cfg?.has_app_secret && (
              <div className="space-y-2">
                <p className="font-medium">2. Webhook in your Meta app</p>
                <p className="text-xs text-muted-foreground">In the app: Webhooks → for <b>Page</b>, <b>Instagram</b> and <b>WhatsApp Business Account</b> paste these, then subscribe to messages, message_echoes, message_reads, message_deliveries, feed (Page), comments (Instagram) and messages (WhatsApp).</p>
                <CopyRow label="Callback URL" value={webhook} />
                {cfg.verify_token && <CopyRow label="Verify token" value={cfg.verify_token} />}
              </div>
            )}
            <div className="space-y-1">
              <p className="font-medium">3. Connect</p>
              <p className="text-xs text-muted-foreground">
                Facebook & Instagram: a Page access token with pages_messaging, pages_manage_metadata, pages_read_engagement, pages_manage_engagement, instagram_basic, instagram_manage_messages and instagram_manage_comments.
                WhatsApp: the phone number ID, WhatsApp Business Account ID and a permanent System User token with whatsapp_business_messaging.
              </p>
              <p className="text-xs text-muted-foreground">Until Meta approves these permissions for your app (App Review), only people with a role on the app can message it.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <ConnectDialog mode={connect} onClose={() => setConnect(null)} onDone={refresh} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive title={`Disconnect ${removing?.name}?`}
        description="Its access token is deleted and new messages stop arriving. Conversations already in the inbox stay." confirmLabel="Disconnect"
        onConfirm={async () => {
          try { await disconnectChannel(removing!.id); toast.success('Disconnected'); refresh() } catch (e) { onError(e); throw e }
        }} />
    </div>
  )
}

function ConnectDialog({ mode, onClose, onDone }: { mode: 'page' | 'whatsapp' | null; onClose: () => void; onDone: () => void }) {
  const [page, setPage] = useState({ token: '', instagram: true, comments: true })
  const [wa, setWa] = useState({ phone: '', waba: '', token: '' })
  const run = useMutation({
    mutationFn: () => (mode === 'page' ? connectPage(page.token.trim(), page.instagram, page.comments) : connectWhatsApp(wa.phone.trim(), wa.waba.trim(), wa.token.trim())),
    onSuccess: (r) => {
      toast.success(`Connected ${r.channels.map((c) => c.name).join(' and ')}`)
      r.warnings.forEach((w) => toast.warning(w))
      setPage({ token: '', instagram: true, comments: true })
      setWa({ phone: '', waba: '', token: '' })
      onDone()
      onClose()
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'page' ? 'Connect a Facebook Page' : 'Connect WhatsApp'}</DialogTitle>
          <DialogDescription>{mode === 'page' ? 'The Page’s Instagram professional account is connected with it.' : 'From WhatsApp Manager → API setup in your Meta app.'}</DialogDescription>
        </DialogHeader>
        <form id="connect-channel" className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate() }}>
          {mode === 'page' ? (
            <>
              <Field label="Page access token"><Textarea value={page.token} onChange={(e) => setPage({ ...page, token: e.target.value })} rows={3} className="font-mono text-xs" placeholder="EAAG…" autoComplete="off" /></Field>
              <label className="flex items-center justify-between gap-3 text-sm">Also connect the linked Instagram account <Switch checked={page.instagram} onCheckedChange={(v) => setPage({ ...page, instagram: v })} /></label>
              <label className="flex items-center justify-between gap-3 text-sm">Bring post and ad comments into the inbox <Switch checked={page.comments} onCheckedChange={(v) => setPage({ ...page, comments: v })} /></label>
            </>
          ) : (
            <>
              <Field label="Phone number ID"><Input value={wa.phone} onChange={(e) => setWa({ ...wa, phone: e.target.value })} inputMode="numeric" /></Field>
              <Field label="WhatsApp Business Account ID"><Input value={wa.waba} onChange={(e) => setWa({ ...wa, waba: e.target.value })} inputMode="numeric" /></Field>
              <Field label="Permanent access token"><Textarea value={wa.token} onChange={(e) => setWa({ ...wa, token: e.target.value })} rows={3} className="font-mono text-xs" placeholder="EAAG…" autoComplete="off" /></Field>
            </>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="connect-channel" disabled={run.isPending || (mode === 'page' ? page.token.trim().length < 20 : !wa.phone || !wa.waba || wa.token.trim().length < 20)}>
            {run.isPending && <Spinner />} Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

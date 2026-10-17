import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, ExternalLink, KeyRound, Link2, Pencil, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { ConnectGuide, guideSkipped } from '@/features/inbox/connect-guide'
import { listenForMetaAnswer, openMetaWindow } from '@/features/inbox/meta-popup'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { PlatformIcon } from '@/features/inbox/ui'
import { toUserMessage } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  deleteSavedReply, disconnectChannel, type InboxChannel, type InboxPlatform, inboxConfig, inboxOverview, type MetaConnectKind, metaConnectStart, savedReplies,
  connectWhatsAppManually, removeChannel, saveSavedReply, setChannelComments,
} from '@/services/inbox'

type Filter = 'ALL' | InboxPlatform

const TITLE: Record<InboxPlatform, string> = { FACEBOOK: 'Facebook Page', INSTAGRAM: 'Instagram Account', WHATSAPP: 'WhatsApp Business Account' }
const BLURB: Record<InboxPlatform, string> = {
  FACEBOOK: 'Messenger conversations, and comments on your posts and ads.',
  INSTAGRAM: 'DMs, story replies and comments on your posts and Reels.',
  WHATSAPP: 'Chats with customers on your business number.',
}
const profileUrl = (c: InboxChannel): string | null => (c.platform === 'INSTAGRAM' && c.username ? `https://www.instagram.com/${c.username}` : null)

export default function InboxChannelsPage() {
  const { can } = useAuth()
  const manage = can('inbox.manage')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const overview = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview })
  const config = useQuery({ queryKey: ['inbox-config'], queryFn: inboxConfig })
  const [removing, setRemoving] = useState<InboxChannel | null>(null)
  const [deleting, setDeleting] = useState<InboxChannel | null>(null)
  const [guide, setGuide] = useState<MetaConnectKind | null>(null)
  const [manualWa, setManualWa] = useState(false)
  const [waOpen, setWaOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('ALL')
  const popup = useRef<Window | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    void qc.invalidateQueries({ queryKey: ['inbox-config'] })
  }
  const onError = (e: unknown) => toast.error(toUserMessage(e))

  // Meta's window hands its answer back here; the pick-your-Pages step then opens on this tab.
  useEffect(() => listenForMetaAnswer((search) => {
    popup.current = null
    navigate(`/admin/inbox/meta-callback${search}`)
  }), [navigate])

  // Meta's sign-in opens in a window over this page; without pop-ups it takes over the tab instead.
  const start = useMutation({
    mutationFn: ({ kind, inPopup, coexist }: { kind: MetaConnectKind; inPopup: boolean; coexist?: boolean }) => metaConnectStart(kind, inPopup, coexist),
    onSuccess: (r, v) => {
      const w = popup.current
      if (v.inPopup && w && !w.closed) { w.location.href = r.url; w.focus() } else window.location.assign(r.url)
    },
    onError: (e) => { popup.current?.close(); popup.current = null; onError(e) },
  })
  const connect = (kind: MetaConnectKind, coexist?: boolean) => {
    setGuide(null)
    setWaOpen(false)
    const w = openMetaWindow()
    popup.current = w
    start.mutate({ kind, inPopup: !!w, coexist })
  }
  // WhatsApp asks first whether the number stays on the WhatsApp Business app.
  const begin = (kind: MetaConnectKind) => (kind === 'WHATSAPP' ? setWaOpen(true) : guideSkipped() ? connect(kind) : setGuide(kind))
  const comments = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => setChannelComments(id, on), onSuccess: refresh, onError })

  if (overview.isLoading || config.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const ready = !!config.data?.ready
  const business = !!config.data?.business
  const whatsapp = !!config.data?.whatsapp
  const channels = overview.data!.channels
  const busy = (k: MetaConnectKind) => start.isPending && start.variables?.kind === k
  const numbered = channels.map((c) => ({ c, n: channels.filter((o) => o.platform === c.platform && o.created_at <= c.created_at).length }))
  const shown = numbered.filter(({ c }) => filter === 'ALL' || c.platform === filter)
  const adds = (['FACEBOOK', 'INSTAGRAM', 'WHATSAPP'] as const).filter((p) => filter === 'ALL' || p === filter)

  return (
    <div className="space-y-4">
      <MessagingTabs unread={overview.data!.counts.unread} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Channels</h1>
          <p className="text-sm text-muted-foreground">Connect Facebook Pages, Instagram and WhatsApp. Messages and comments arrive in the inbox; replies go out from the same Page, account or number.</p>
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="ALL">All</TabsTrigger>
            <TabsTrigger value="FACEBOOK">Facebook</TabsTrigger>
            <TabsTrigger value="INSTAGRAM">Instagram</TabsTrigger>
            <TabsTrigger value="WHATSAPP">WhatsApp</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {!ready && (
        <p className="rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm">Connecting with Facebook is not switched on yet. Fullfilio is finishing the setup with Meta; you can connect as soon as it is ready.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map(({ c, n }) => (
          <Card key={c.id} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                {c.avatar_url ? <img src={c.avatar_url} alt="" className="size-9 rounded-full object-cover" /> : <PlatformIcon platform={c.platform} className="size-9" />}
                <Badge variant={c.status === 'OK' ? 'success' : c.status === 'FAILED' ? 'danger' : 'neutral'}>{c.status === 'OK' ? 'Connected' : c.status === 'FAILED' ? 'Needs reconnecting' : 'Disconnected'}</Badge>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold"><PlatformIcon platform={c.platform} className="size-3.5" /> {TITLE[c.platform]} {n}</p>
                <p className="text-xs text-muted-foreground">{BLURB[c.platform]}</p>
              </div>
              <div className="rounded-[10px] bg-muted/50 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">{c.platform === 'WHATSAPP' ? 'Number' : c.platform === 'INSTAGRAM' ? 'Account' : 'Page name'}</p>
                <p className="flex min-w-0 items-center gap-1 text-sm font-medium">
                  <span className="truncate">{c.platform === 'WHATSAPP' ? c.display_phone ?? c.name : c.name}</span>
                  {profileUrl(c) && <a href={profileUrl(c)!} target="_blank" rel="noreferrer" aria-label={`Open ${c.name}`} className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                </p>
                <p className="text-[11px] text-muted-foreground">{c.last_event_at ? `Last message ${timeAgo(c.last_event_at)}` : 'No messages yet'}</p>
              </div>
              {c.status_error && <p className="text-xs text-destructive">{c.status_error}</p>}
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                {c.platform !== 'WHATSAPP' && c.status !== 'DISCONNECTED' && (
                  <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={c.receive_comments} disabled={!manage} onCheckedChange={(on) => comments.mutate({ id: c.id, on })} /> Comments
                  </label>
                )}
                {manage && ready && c.status !== 'OK' && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={start.isPending || (c.platform === 'WHATSAPP' && !whatsapp)}
                    onClick={() => begin(c.platform === 'WHATSAPP' ? 'WHATSAPP' : 'PAGES')}><RefreshCw /> Reconnect</Button>
                )}
                {manage && c.status !== 'DISCONNECTED' && (
                  <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setRemoving(c)}><Unplug /> Disconnect</Button>
                )}
                {manage && (
                  <Button size="icon-sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" title="Remove from Fullfilio"
                    aria-label={`Remove ${c.name}`} onClick={() => setDeleting(c)}><Trash2 /></Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {adds.map((p) => (
          <Card key={`add-${p}`} className="flex flex-col border-dashed">
            <CardContent className="flex flex-1 flex-col gap-3 p-4">
              <PlatformIcon platform={p} className="size-9" />
              <div>
                <p className="text-sm font-semibold">{channels.some((c) => c.platform === p) ? `Add another ${TITLE[p]}` : TITLE[p]}</p>
                <p className="text-xs text-muted-foreground">{BLURB[p]}</p>
                {p === 'INSTAGRAM' && <p className="mt-1 text-xs text-muted-foreground">Instagram connects through the Facebook Page your professional account is linked to.</p>}
                {p === 'WHATSAPP' && !whatsapp && <p className="mt-1 text-xs text-muted-foreground">Opens once Meta approves Fullfilio as a WhatsApp provider.</p>}
              </div>
              {manage ? (
                <div className="mt-auto grid gap-2 pt-1">
                  {p === 'FACEBOOK' && (
                    <>
                      <Button className="gap-2 bg-[#1877F2] text-white hover:bg-[#1877F2]/90" disabled={!ready || start.isPending} onClick={() => begin('PAGES')}>
                        {busy('PAGES') ? <Spinner /> : <Link2 />} Connect with Page access
                      </Button>
                      {business && (
                        <Button variant="outline" className="gap-2" disabled={!ready || start.isPending} onClick={() => begin('BUSINESS')}>
                          {busy('BUSINESS') ? <Spinner /> : <Building2 />} Connect using Business
                        </Button>
                      )}
                    </>
                  )}
                  {p === 'INSTAGRAM' && (
                    <Button className="gap-2" disabled={!ready || start.isPending} onClick={() => begin('PAGES')}>
                      {busy('PAGES') ? <Spinner /> : <Link2 />} Connect Instagram
                    </Button>
                  )}
                  {p === 'WHATSAPP' && (
                    <Button variant="outline" className="gap-2" disabled={!ready || !whatsapp || start.isPending} onClick={() => begin('WHATSAPP')}>
                      {busy('WHATSAPP') ? <Spinner /> : <Link2 />} Connect WhatsApp
                    </Button>
                  )}
                  {p === 'WHATSAPP' && ready && (
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setManualWa(true)}>
                      <KeyRound /> Connect with an access token
                    </Button>
                  )}
                </div>
              ) : (
                <p className="mt-auto text-xs text-muted-foreground">Ask an admin to connect channels.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">Your Facebook password never comes to Fullfilio. To take access away later, disconnect or remove the channel here, or in Facebook → Settings → Business integrations.</p>
      <SavedRepliesCard manage={manage} />

      <ConnectGuide kind={guide} onClose={() => setGuide(null)} onConnect={connect} />
      <WhatsAppTokenDialog open={manualWa} onOpenChange={setManualWa} onDone={refresh} />
      <WhatsAppConnectDialog open={waOpen} onOpenChange={setWaOpen} busy={busy('WHATSAPP')} onContinue={(coexist) => connect('WHATSAPP', coexist)} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive title={`Disconnect ${removing?.name}?`}
        description="Its access is deleted and new messages stop arriving. Conversations already in the inbox stay." confirmLabel="Disconnect"
        onConfirm={async () => {
          try { await disconnectChannel(removing!.id); toast.success('Disconnected'); refresh() } catch (e) { onError(e); throw e }
        }} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} destructive title={`Remove ${deleting?.name}?`}
        description="It is taken off this store and its conversations and messages in the inbox are deleted. Nothing changes on Facebook or Instagram; you can connect it again later."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await removeChannel(deleting!.id)
            toast.success('Removed')
            refresh()
            void qc.invalidateQueries({ queryKey: ['inbox-list'] })
          } catch (e) { onError(e); throw e }
        }} />
    </div>
  )
}

/**
 * "Connect WhatsApp": first the owner says whether the number stays on the WhatsApp Business app
 * (coexistence: chats keep working on the phone and history is shared) or becomes an API-only number,
 * then Meta's sign-up opens to pick or add the number.
 */
function WhatsAppConnectDialog({ open, onOpenChange, onContinue, busy }: {
  open: boolean; onOpenChange: (o: boolean) => void; onContinue: (coexist: boolean) => void; busy: boolean
}) {
  const [mode, setMode] = useState<'COEXIST' | 'API'>('COEXIST')
  const [understood, setUnderstood] = useState(false)
  const [ready, setReady] = useState(false)
  const close = (o: boolean) => { if (!o) { setReady(false); setUnderstood(false) } onOpenChange(o) }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><PlatformIcon platform="WHATSAPP" className="size-5" /> Connect WhatsApp</DialogTitle>
          <DialogDescription>Keep using your WhatsApp Business app and reply from Fullfilio too, or connect a number only Fullfilio uses.</DialogDescription>
        </DialogHeader>
        {!ready ? (
          <div className="space-y-3">
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'COEXIST' | 'API')} className="gap-2">
              <label className={`flex cursor-pointer gap-3 rounded-[10px] border p-3 ${mode === 'COEXIST' ? 'border-primary bg-primary/5' : ''}`}>
                <RadioGroupItem value="COEXIST" className="mt-0.5" />
                <span className="text-sm">
                  <span className="font-medium">Keep WhatsApp Business app + Fullfilio</span>
                  <span className="block text-xs text-muted-foreground">Use WhatsApp Business app 2.24.17 or newer. Allow chat history sharing when Meta asks; keep the app open while it syncs.</span>
                </span>
              </label>
              <label className={`flex cursor-pointer gap-3 rounded-[10px] border p-3 ${mode === 'API' ? 'border-primary bg-primary/5' : ''}`}>
                <RadioGroupItem value="API" className="mt-0.5" />
                <span className="text-sm">
                  <span className="font-medium">Connect an API-only or new number</span>
                  <span className="block text-xs text-muted-foreground">The number works only through Fullfilio (no WhatsApp app on a phone).</span>
                </span>
              </label>
            </RadioGroup>
            {mode === 'API' && (
              <label className="flex items-start gap-2 text-xs">
                <Checkbox checked={understood} onCheckedChange={(v) => setUnderstood(v === true)} className="mt-0.5" />
                I understand this number will use the Cloud API without WhatsApp Business app messaging or calling.
              </label>
            )}
            <DialogFooter>
              <Button disabled={mode === 'API' && !understood} onClick={() => setReady(true)}>Prepare connection</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">Complete Meta sign-up, then select the numbers to connect.</p>
            <p className="text-xs text-muted-foreground">{mode === 'COEXIST'
              ? 'Pick your existing WhatsApp Business number when Meta asks, and scan the code with the WhatsApp Business app.'
              : 'Pick a number or add a new one; Meta sends a code by SMS or call to verify it.'}</p>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={() => setReady(false)}>Back</Button>
              <Button className="gap-2 bg-[#25D366] text-white hover:bg-[#25D366]/90" disabled={busy} onClick={() => onContinue(mode === 'COEXIST')}>
                {busy ? <Spinner /> : <PlatformIcon platform="WHATSAPP" className="size-4 brightness-0 invert" />} Continue with Meta
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A WhatsApp number connected with its IDs and an access token copied from Meta (WhatsApp →
 * API Setup, or a system user's token). For numbers that cannot use Embedded Signup yet,
 * such as Meta's test number. The token is kept encrypted like any other channel's.
 */
function WhatsAppTokenDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ waba_id: '', phone_number_id: '', token: '' })
  const save = useMutation({
    mutationFn: () => connectWhatsAppManually(form),
    onSuccess: (r) => {
      toast.success(`Connected ${r.channels.map((c) => c.name).join(', ')}`)
      for (const w of r.warnings) toast.error(w)
      setForm({ waba_id: '', phone_number_id: '', token: '' })
      onOpenChange(false)
      onDone()
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const digits = (v: string) => v.replace(/\D/g, '')
  const valid = form.waba_id.length >= 3 && form.phone_number_id.length >= 3 && form.token.length >= 20
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect WhatsApp with an access token</DialogTitle>
          <DialogDescription>Copy these from Meta → your app → WhatsApp → API Setup. Use this for Meta's test number or a number you manage yourself.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate() }}>
          <Field label="WhatsApp Business Account ID" htmlFor="wa-waba">
            <Input id="wa-waba" inputMode="numeric" value={form.waba_id} onChange={(e) => setForm({ ...form, waba_id: digits(e.target.value) })} placeholder="Messaging account ID" />
          </Field>
          <Field label="Phone number ID" htmlFor="wa-phone">
            <Input id="wa-phone" inputMode="numeric" value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: digits(e.target.value) })} placeholder="Phone number ID" />
          </Field>
          <Field label="Access token" htmlFor="wa-token" hint="A token from API Setup lasts 24 hours; a system user's token keeps working. It is stored encrypted.">
            <Input id="wa-token" type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value.trim() })} placeholder="EAA…" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!valid || save.isPending}>{save.isPending && <Spinner />} Connect</Button>
          </DialogFooter>
        </form>
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

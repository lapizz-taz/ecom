import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Clock, FlaskConical, Loader2, Plus, ShieldCheck, Trash2, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { PlatformIcon } from '@/features/inbox/ui'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type AutoReplyInput, type AutoReplyRule, deleteAutoReply, inboxActivity, inboxAutomation, type InboxAutomation, inboxOverview,
  saveAutoReply, saveInboxSettings, toggleAutoReply, tryAutoReply,
} from '@/services/inbox'

const TABS = [['rules', 'Auto Replies'], ['channels', 'Channels'], ['follow-up', 'Auto follow-up'], ['moderation', 'Moderation'], ['activity', 'Activity']] as const
type Tab = (typeof TABS)[number][0]
const APPLIES: Record<AutoReplyRule['applies_to'], string> = { MESSAGE: 'Message', COMMENT: 'Comment', BOTH: 'Message + comment' }

export default function InboxAutoRepliesPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const manage = can('inbox.manage')
  const [params, setParams] = useSearchParams()
  const [s, update] = useUrlState({ tab: 'rules' })
  const data = useQuery({ queryKey: ['inbox-automation'], queryFn: inboxAutomation })
  const inbox = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview, refetchInterval: 30_000 })
  const [editing, setEditing] = useState<AutoReplyInput | null>(null)
  const [trying, setTrying] = useState(false)

  // "Auto Reply for this post" from the Comments page.
  useEffect(() => {
    if (params.get('new') === '1' && manage) {
      const post = params.get('post')
      const channel = params.get('channel')
      setEditing({ ...blank(), name: 'Reply on this post', applies_to: 'COMMENT', post_ids: post ? [post] : [], channel_ids: channel ? [channel] : [] })
      setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); n.delete('post'); n.delete('channel'); return n }, { replace: true })
    }
  }, [params, setParams, manage])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['inbox-automation'] })
  if (data.isLoading) return <LoadingState />
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  const a = data.data!
  const tab = s.tab as Tab

  return (
    <div className="space-y-4">
      <MessagingTabs unread={inbox.data?.counts.unread} comments={inbox.data?.comments?.awaiting} />
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold"><Zap className="size-5 shrink-0" /> Auto Replies</h1>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setTrying(true)} aria-label="Try a message"><FlaskConical /> <span className="hidden sm:inline">Try a message</span></Button>
            {manage && <Button size="sm" className="gap-1.5" disabled={a.rules.length >= a.limit} onClick={() => { update({ tab: 'rules' }); setEditing(blank()) }}><Plus /> New<span className="hidden sm:inline"> Auto Reply</span></Button>}
          </div>
        </div>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
          <span><b className="font-medium text-foreground">{formatNumber(a.stats.sent_today)}</b> today</span>
          <span><b className="font-medium text-foreground">{formatNumber(a.stats.sent_7d)}</b> this week</span>
          <span><b className="font-medium text-foreground">{formatNumber(a.stats.follow_ups_7d)}</b> follow-ups</span>
          <span><b className="font-medium text-foreground">{formatNumber(a.stats.hidden_7d)}</b> hidden</span>
          {a.stats.failed_7d > 0 && <span className="text-red-500"><b className="font-medium">{formatNumber(a.stats.failed_7d)}</b> failed</span>}
          <span>{a.rules.length}/{a.limit} rules</span>
        </p>
      </div>

      <div className="-mx-1 flex gap-1 overflow-x-auto border-b px-1 [scrollbar-width:none]">
        {TABS.map(([v, l]) => (
          <button key={v} type="button" onClick={() => update({ tab: v })}
            className={cn('-mb-px shrink-0 border-b-2 border-transparent px-2.5 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground sm:px-3', tab === v && 'border-primary font-medium text-foreground')}>{l}</button>
        ))}
      </div>

      {tab === 'rules' && <Rules a={a} manage={manage} editing={editing} setEditing={setEditing} onChanged={refresh} onChannels={() => update({ tab: 'channels' })} />}
      {tab === 'channels' && <Channels a={a} manage={manage} onChanged={refresh} />}
      {tab === 'follow-up' && <FollowUp a={a} manage={manage} onChanged={refresh} />}
      {tab === 'moderation' && <Moderation a={a} manage={manage} onChanged={refresh} />}
      {tab === 'activity' && <Activity />}

      <TryDialog open={trying} onOpenChange={setTrying} a={a} />
    </div>
  )
}

const blank = (): AutoReplyInput => ({
  name: '', enabled: true, is_default: false, applies_to: 'BOTH', keywords: [], match: 'CONTAINS', channel_ids: [], post_ids: [],
  reply_text: '', private_text: '', like_comment: false, once_per_customer: true,
})

function channelLabel(a: InboxAutomation, ids: string[]): string {
  if (!a.settings.auto_reply_channels.length) return 'No channel'
  const on = (ids.length ? ids : a.settings.auto_reply_channels).filter((id) => a.settings.auto_reply_channels.includes(id))
  if (!on.length) return 'No channel'
  if (!ids.length) return 'All channels'
  return on.map((id) => a.channels.find((c) => c.id === id)?.name ?? 'Channel').join(', ')
}

function Rules({ a, manage, editing, setEditing, onChanged, onChannels }: {
  a: InboxAutomation; manage: boolean; editing: AutoReplyInput | null; setEditing: (r: AutoReplyInput | null) => void; onChanged: () => void; onChannels: () => void
}) {
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => toggleAutoReply(id, on),
    onSuccess: onChanged, onError: (e) => toast.error(toUserMessage(e)),
  })
  const running = a.settings.auto_reply_channels.length > 0
  const hasDefault = a.rules.some((r) => r.is_default)
  return (
    <div className="space-y-3">
      {!running && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <span className="flex-1"><b>Not running anywhere yet.</b> Switch a channel on and your Auto Replies start answering.</span>
          <Button size="sm" variant="outline" onClick={onChannels}>Manage channels</Button>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-2">
          {!hasDefault && manage && (
            <button type="button" onClick={() => setEditing({ ...blank(), name: 'Default first reply', is_default: true, applies_to: 'MESSAGE', reply_text: 'Hi! Thanks for your message. How can we help you today?' })}
              className="w-full rounded-xl border border-dashed p-3 text-left text-sm text-muted-foreground hover:text-foreground">
              <b>+ Default first reply</b><br /><span className="text-xs">Sent once to a first-time customer when no keyword matched.</span>
            </button>
          )}
          {a.rules.map((r) => (
            <div key={r.id} role="button" tabIndex={0} onClick={() => setEditing({ ...r })} onKeyDown={(e) => e.key === 'Enter' && setEditing({ ...r })}
              className={cn('cursor-pointer rounded-xl border bg-card p-3 transition-colors hover:border-foreground/20', r.is_default && 'border-amber-500/50',
                editing && 'id' in editing && editing.id === r.id && 'ring-2 ring-primary/40')}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.name}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {r.is_default ? 'Sent once to a first-time customer when no keyword matched.' : `When it ${r.match === 'EXACT' ? 'is' : 'contains'}: ${r.keywords.join(', ') || (r.post_ids.length ? 'any comment on the chosen post' : '—')}`}
                  </p>
                </div>
                <Switch checked={r.enabled} disabled={!manage || toggle.isPending} onClick={(e) => e.stopPropagation()} onCheckedChange={(on) => toggle.mutate({ id: r.id, on })} aria-label="On" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <Badge variant="info" className="px-1.5 py-0 text-[10px]">{APPLIES[r.applies_to]}</Badge>
                <Badge variant={channelLabel(a, r.channel_ids) === 'No channel' ? 'warning' : 'neutral'} className="px-1.5 py-0 text-[10px]">{channelLabel(a, r.channel_ids)}</Badge>
                {r.post_ids.length > 0 && <Badge variant="violet" className="px-1.5 py-0 text-[10px]">{r.post_ids.length} post{r.post_ids.length > 1 ? 's' : ''}</Badge>}
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{formatNumber(r.sent_count)} sent</span>
              </div>
            </div>
          ))}
        </div>
        <div className={cn('min-h-64 rounded-xl border bg-card', !editing && 'hidden lg:block')}>
          {editing ? <RuleEditor key={('id' in editing && editing.id) || 'new'} a={a} rule={editing} manage={manage} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />
            : <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"><Zap className="size-5" />Select an Auto Reply to edit<br />or create a new one to get started.</div>}
        </div>
      </div>
    </div>
  )
}

function RuleEditor({ a, rule, manage, onClose, onSaved }: { a: InboxAutomation; rule: AutoReplyInput; manage: boolean; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<AutoReplyInput>(rule)
  const [word, setWord] = useState('')
  const set = (p: Partial<AutoReplyInput>) => setR((x) => ({ ...x, ...p }))
  const save = useMutation({ mutationFn: () => saveAutoReply(r), onSuccess: () => { toast.success('Auto reply saved'); onSaved() }, onError: (e) => toast.error(toUserMessage(e)) })
  const del = useMutation({ mutationFn: () => deleteAutoReply(r.id!), onSuccess: () => { toast.success('Deleted'); onSaved() }, onError: (e) => toast.error(toUserMessage(e)) })
  const addWord = () => {
    const words = word.split(',').map((w) => w.trim()).filter(Boolean)
    if (words.length) set({ keywords: [...new Set([...(r.keywords ?? []), ...words])] })
    setWord('')
  }
  const comments = r.applies_to !== 'MESSAGE'
  const channels = r.channel_ids ?? []
  return (
    <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{r.id ? 'Edit auto reply' : r.is_default ? 'Default first reply' : 'New auto reply'}</h2>
        <label className="flex items-center gap-2 text-xs"><Switch checked={!!r.enabled} onCheckedChange={(v) => set({ enabled: v })} disabled={!manage} /> On</label>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close"><X /></Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ar-name">Name</Label>
        <Input id="ar-name" value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Price question" maxLength={80} disabled={!manage} />
      </div>
      <div className="space-y-1.5">
        <Label>Answers</Label>
        <div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(['MESSAGE', 'COMMENT', 'BOTH'] as const).map((v) => (
            <button key={v} type="button" disabled={!manage} onClick={() => set({ applies_to: v })}
              className={cn('rounded-md px-2.5 py-1 text-xs text-muted-foreground', r.applies_to === v && 'bg-background font-medium text-foreground shadow-xs')}>
              {v === 'MESSAGE' ? 'Messages' : v === 'COMMENT' ? 'Comments' : 'Both'}
            </button>
          ))}
        </div>
      </div>
      {r.is_default ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Sent once to a customer writing for the first time, when none of your keywords matched.</p>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="ar-word">Keywords</Label>
          <div className="flex flex-wrap gap-1">
            {(r.keywords ?? []).map((k) => (
              <Badge key={k} variant="violet" className="gap-1">{k}
                {manage && <button type="button" onClick={() => set({ keywords: (r.keywords ?? []).filter((x) => x !== k) })} aria-label={`Remove ${k}`}><X className="size-3" /></button>}
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input id="ar-word" value={word} onChange={(e) => setWord(e.target.value)} placeholder="price, দাম, koto, available…" disabled={!manage}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addWord() } }} />
            <Select value={r.match} onValueChange={(v) => set({ match: v as AutoReplyRule['match'] })} disabled={!manage}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="CONTAINS">Contains</SelectItem><SelectItem value="EXACT">Is exactly</SelectItem></SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground">Bangla, Banglish and English work. Press Enter after each word.</p>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="ar-reply">{comments && r.applies_to === 'COMMENT' ? 'Public reply under the comment' : comments ? 'Reply (message, or public reply under a comment)' : 'Reply'}</Label>
        <Textarea id="ar-reply" value={r.reply_text ?? ''} onChange={(e) => set({ reply_text: e.target.value })} rows={3} maxLength={2000} disabled={!manage}
          placeholder={comments ? 'Thanks! We sent you the details in a private message. Please check your inbox.' : 'Price: ৳580 with delivery. Would you like to order?'} />
      </div>
      {comments && (
        <div className="space-y-1.5">
          <Label htmlFor="ar-private">Private message to the commenter (optional)</Label>
          <Textarea id="ar-private" value={r.private_text ?? ''} onChange={(e) => set({ private_text: e.target.value })} rows={3} maxLength={2000} disabled={!manage}
            placeholder="Hi! The price is ৳580 with delivery inside Dhaka. Send your name, number and address to order." />
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={!!r.like_comment} onCheckedChange={(v) => set({ like_comment: v })} disabled={!manage} /> Like the comment too (Facebook)</label>
        </div>
      )}
      <div className="space-y-1.5">
        <Label>Channels</Label>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={!manage} onClick={() => set({ channel_ids: [] })}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs', !channels.length ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>All switched-on channels</button>
          {a.channels.map((c) => {
            const on = channels.includes(c.id)
            return (
              <button key={c.id} type="button" disabled={!manage} onClick={() => set({ channel_ids: on ? channels.filter((x) => x !== c.id) : [...channels, c.id] })}
                className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
                <PlatformIcon platform={c.platform} className="size-3" /> {c.name}{!c.auto_reply && ' (off)'}
              </button>
            )
          })}
        </div>
        {(r.post_ids ?? []).length > 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">Only comments on {(r.post_ids ?? []).length} chosen post(s).
            {manage && <button type="button" className="underline" onClick={() => set({ post_ids: [] })}>Any post</button>}</p>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={r.once_per_customer !== false} onCheckedChange={(v) => set({ once_per_customer: v })} disabled={!manage} />
        Once per customer (otherwise at most every 10 minutes)
      </label>
      {manage && (
        <div className="flex items-center gap-2 border-t pt-3">
          <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          {r.id && <Button type="button" variant="ghost" className="ml-auto text-destructive" disabled={del.isPending} onClick={() => del.mutate()}><Trash2 /> Delete</Button>}
        </div>
      )}
    </form>
  )
}

function Channels({ a, manage, onChanged }: { a: InboxAutomation; manage: boolean; onChanged: () => void }) {
  const save = useMutation({ mutationFn: saveInboxSettings, onSuccess: () => { toast.success('Saved'); onChanged() }, onError: (e) => toast.error(toUserMessage(e)) })
  const auto = a.settings.auto_reply_channels
  const modOn = (id: string) => a.channels.find((c) => c.id === id)?.moderation ?? false
  if (!a.channels.length) {
    return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Connect a Facebook Page, Instagram account or WhatsApp number first. <Link to="/admin/inbox/channels" className="underline">Channels</Link></div>
  }
  return (
    <div className="divide-y rounded-xl border bg-card">
      {a.channels.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <PlatformIcon platform={c.platform} className="size-6" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{c.name}</p>
            <p className="text-xs text-muted-foreground">{c.platform === 'WHATSAPP' ? 'Messages' : c.receive_comments ? 'Messages and comments' : 'Messages (comments are off for this channel)'}</p>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={auto.includes(c.id)} disabled={!manage || save.isPending}
              onCheckedChange={(on) => save.mutate({ auto_reply_channels: on ? [...auto, c.id] : auto.filter((x) => x !== c.id) })} /> Auto replies
          </label>
          {c.platform !== 'WHATSAPP' && (
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={a.settings.moderation.enabled && modOn(c.id)} disabled={!manage || save.isPending}
                onCheckedChange={(on) => {
                  const pages = a.channels.filter((x) => x.platform !== 'WHATSAPP')
                  const list = pages.filter((x) => (x.id === c.id ? on : a.settings.moderation.enabled && x.moderation)).map((x) => x.id)
                  // An empty list means every channel, so switching the last one off turns moderation off.
                  if (!list.length) save.mutate({ moderation: { ...a.settings.moderation, enabled: false }, moderation_channels: [] })
                  else save.mutate({ moderation: { ...a.settings.moderation, enabled: true }, moderation_channels: list.length === pages.length ? [] : list })
                }} /> Moderation
            </label>
          )}
        </div>
      ))}
    </div>
  )
}

const AFTER = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1200, '20 hours']] as const

function FollowUp({ a, manage, onChanged }: { a: InboxAutomation; manage: boolean; onChanged: () => void }) {
  const f = a.settings.follow_up
  const [enabled, setEnabled] = useState(f.enabled)
  const [after, setAfter] = useState(String(f.after_minutes ?? 180))
  const [text, setText] = useState(f.text ?? '')
  const save = useMutation({
    mutationFn: () => saveInboxSettings({ follow_up: { enabled, after_minutes: Number(after), text: text.trim() || null } }),
    onSuccess: () => { toast.success('Auto follow-up saved'); onChanged() }, onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <div className="max-w-2xl space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 size-5 text-muted-foreground" />
        <div className="flex-1">
          <p className="text-sm font-semibold">Follow up when a customer goes quiet</p>
          <p className="text-xs text-muted-foreground">After you reply in a chat, Fullfilio sends this message by itself if the customer has not answered. It is cancelled as soon as they write, and it is only sent inside Meta's 24-hour window.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!manage} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <div className="space-y-1.5">
          <Label>Send after</Label>
          <Select value={after} onValueChange={setAfter} disabled={!manage}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{AFTER.map(([m, l]) => <SelectItem key={m} value={String(m)}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fu-text">Message</Label>
          <Textarea id="fu-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder={f.default_text} disabled={!manage} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Staff can also schedule a follow-up for one chat with “Follow up on this chat” in the Inbox.</p>
      {manage && <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save</Button>}
    </div>
  )
}

function Moderation({ a, manage, onChanged }: { a: InboxAutomation; manage: boolean; onChanged: () => void }) {
  const m = a.settings.moderation
  const [v, setV] = useState(m)
  const [word, setWord] = useState('')
  const save = useMutation({ mutationFn: () => saveInboxSettings({ moderation: v }), onSuccess: () => { toast.success('Moderation saved'); onChanged() }, onError: (e) => toast.error(toUserMessage(e)) })
  const add = () => {
    const words = word.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
    if (words.length) setV({ ...v, keywords: [...new Set([...v.keywords, ...words])] })
    setWord('')
  }
  return (
    <div className="max-w-2xl space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 text-muted-foreground" />
        <div className="flex-1">
          <p className="text-sm font-semibold">Hide spam comments by themselves</p>
          <p className="text-xs text-muted-foreground">Competitors posting their numbers or links, and words you choose, are hidden on your posts and ads as they arrive. Hidden comments stay visible to the person who wrote them and their friends. Find them under Comments → Filtered.</p>
        </div>
        <Switch checked={v.enabled} onCheckedChange={(enabled) => setV({ ...v, enabled })} disabled={!manage} />
      </div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={v.hide_phone} onCheckedChange={(hide_phone) => setV({ ...v, hide_phone })} disabled={!manage} /> Hide comments with a phone number</label>
      <label className="flex items-center gap-2 text-sm"><Switch checked={v.hide_links} onCheckedChange={(hide_links) => setV({ ...v, hide_links })} disabled={!manage} /> Hide comments with a link</label>
      <div className="space-y-1.5">
        <Label htmlFor="mod-word">Hidden words</Label>
        <div className="flex flex-wrap gap-1">
          {v.keywords.map((k) => (
            <Badge key={k} variant="danger" className="gap-1"><Ban className="size-3" />{k}
              {manage && <button type="button" onClick={() => setV({ ...v, keywords: v.keywords.filter((x) => x !== k) })} aria-label={`Remove ${k}`}><X className="size-3" /></button>}
            </Badge>
          ))}
        </div>
        <Input id="mod-word" value={word} onChange={(e) => setWord(e.target.value)} placeholder="scam, fake, bad words…" disabled={!manage}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }} />
      </div>
      <p className="text-xs text-muted-foreground">Choose which Pages and Instagram accounts use it under Channels.</p>
      {manage && <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" />} Save</Button>}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = { AUTO_REPLY: 'Auto reply', FOLLOW_UP: 'Follow-up', MODERATION: 'Moderation', COMMENT_ACTION: 'Comment action' }
const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'neutral' | 'info' | 'warning'> = {
  SENT: 'success', DONE: 'success', FAILED: 'danger', SKIPPED: 'neutral', SCHEDULED: 'info', CANCELLED: 'warning',
}

function Activity() {
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [limit, setLimit] = useState(50)
  const list = useQuery({ queryKey: ['inbox-activity', kind, status, limit], queryFn: () => inboxActivity({ kind, status, limit }), refetchInterval: 20_000, placeholderData: (p) => p })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={kind || 'all'} onValueChange={(v) => setKind(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            {Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status || 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any result</SelectItem>
            {Object.keys(STATUS_VARIANT).map((k) => <SelectItem key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="divide-y rounded-xl border bg-card">
        {list.data?.items.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">Nothing yet. Auto replies, follow-ups and hidden comments show up here.</p>}
        {list.data?.items.map((i) => (
          <div key={i.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">{timeAgo(i.created_at)}</span>
            <Badge variant="neutral" className="shrink-0">{KIND_LABEL[i.kind]}</Badge>
            <Badge variant={STATUS_VARIANT[i.status]} className="shrink-0">{i.status.toLowerCase()}</Badge>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5">
                {i.platform && <PlatformIcon platform={i.platform} className="size-3.5" />}
                {i.conversation_id ? (
                  <Link className="font-medium hover:underline" to={i.conversation_kind === 'COMMENT' ? `/admin/inbox/comments?view=comments&state=all&c=${i.conversation_id}` : `/admin/inbox?c=${i.conversation_id}`}>
                    {i.customer_name ?? 'Customer'}
                  </Link>
                ) : <span className="font-medium">—</span>}
                {i.rule_name && <span className="text-xs text-muted-foreground">· “{i.rule_name}”</span>}
              </p>
              {(i.detail || i.message) && <p className="line-clamp-2 text-xs text-muted-foreground">{i.detail}{i.detail && i.message ? ' · ' : ''}{i.message}</p>}
            </div>
            <span className="text-xs text-muted-foreground">{i.actor_name ?? 'Automatic'}</span>
          </div>
        ))}
      </div>
      {list.data && list.data.total > list.data.items.length && <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 50)}>Show more</Button>}
    </div>
  )
}

function TryDialog({ open, onOpenChange, a }: { open: boolean; onOpenChange: (v: boolean) => void; a: InboxAutomation }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<'MESSAGE' | 'COMMENT'>('MESSAGE')
  const [channel, setChannel] = useState('any')
  const [first, setFirst] = useState(true)
  const test = useMutation({ mutationFn: () => tryAutoReply(text, kind, channel === 'any' ? null : channel, first), onError: (e) => toast.error(toUserMessage(e)) })
  const r = test.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Try a message</DialogTitle>
          <DialogDescription>See which auto reply would answer it. Nothing is sent.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) test.mutate() }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Price koto? / দাম কত?" autoFocus />
          <div className="flex flex-wrap gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as 'MESSAGE' | 'COMMENT')}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="MESSAGE">As a message</SelectItem><SelectItem value="COMMENT">As a comment</SelectItem></SelectContent>
            </Select>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any channel</SelectItem>
                {a.channels.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs"><Switch checked={first} onCheckedChange={setFirst} /> First-time customer</label>
          </div>
          <Button type="submit" disabled={!text.trim() || test.isPending}>{test.isPending && <Loader2 className="animate-spin" />} Try it</Button>
        </form>
        {r && (
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            {r.moderation && <p className="text-amber-600">This comment would be hidden ({r.moderation.reason}){r.moderation.active ? '' : ', once moderation is switched on'}.</p>}
            {r.rule ? (
              <>
                <p><b>{r.rule.default ? 'Default first reply' : `“${r.rule.name}”`}</b> answers{!r.running && <span className="text-amber-600"> (switch this channel on under Channels to send it)</span>}:</p>
                {r.rule.reply_text && <p className="rounded-md bg-muted px-3 py-2 whitespace-pre-wrap">{r.rule.reply_text}</p>}
                {r.rule.private_text && <p className="rounded-md bg-primary/10 px-3 py-2 whitespace-pre-wrap"><span className="text-xs font-medium">Private: </span>{r.rule.private_text}</p>}
              </>
            ) : !r.moderation && <p className="text-muted-foreground">No auto reply matches. Staff answer it in the Inbox.</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

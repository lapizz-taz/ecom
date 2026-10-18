import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Ban, Check, ChevronDown, ChevronRight, CircleSlash, ExternalLink, Eye, EyeOff, Heart, ImageOff, Lock, MessageCircle,
  MoreHorizontal, RefreshCw, Search, ShieldCheck, Tag, Trash2, UserRound, X, Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BulkBar } from '@/components/common/bulk-bar'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { CommentReply, type ReplyMode } from '@/features/inbox/comment-reply'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { ChatAvatar, PlatformIcon, shortAgo, Waiting } from '@/features/inbox/ui'
import { useDebounce } from '@/hooks/use-debounce'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDate, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  commentAction, type CommentFilters, type CommentItem, type CommentOp, type CommentPost, commentsList, commentsOverview, type CommentState,
  inboxAutomation, inboxBulk, inboxOverview, inboxStaff, inboxThread, inboxUpdate, type InboxPlatform, refreshPost,
} from '@/services/inbox'

const STATES: Array<{ value: CommentState; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'awaiting', label: 'Awaiting reply' }, { value: 'replied', label: 'Replied' },
  { value: 'no_reply', label: 'No reply needed' }, { value: 'unread', label: 'Unread' }, { value: 'liked', label: 'Liked' },
  { value: 'hidden', label: 'Hidden' }, { value: 'deleted', label: 'Deleted' }, { value: 'filtered', label: 'Filtered' },
]
/** One-tap labels for sorting comments the way a shop does. */
const QUICK_LABELS = ['Complaint', 'Order', 'Price ask', 'Return-exchange', 'Spam', 'Where is my order']
const postKey = (p: { channel_id: string; post_id: string | null }) => `${p.channel_id}|${p.post_id ?? ''}`

export default function InboxCommentsPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const [s, update] = useUrlState({ view: 'post', state: 'awaiting', platform: '', post: '', c: '' })
  const [q, setQ] = useState('')
  const search = useDebounce(q, 300)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<{ label: string; done: number; total: number; failed: string[] } | null>(null)
  const [progressOpen, setProgressOpen] = useState(true)
  const [replying, setReplying] = useState<{ id: string; mode: ReplyMode } | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)

  const filters: CommentFilters = { platform: s.platform as InboxPlatform | '', state: s.state as CommentState, q: search || undefined }
  const overview = useQuery({ queryKey: ['comments-overview', filters], queryFn: () => commentsOverview(filters), refetchInterval: 15_000, placeholderData: (p) => p })
  const inbox = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview, refetchInterval: 30_000 })
  const automation = useQuery({ queryKey: ['inbox-automation'], queryFn: inboxAutomation, staleTime: 60_000 })

  const posts = overview.data?.posts ?? []
  const selectedPost = s.view === 'post' ? (posts.find((p) => postKey(p) === s.post) ?? posts[0] ?? null) : null
  const [channelId, postId] = selectedPost ? [selectedPost.channel_id, selectedPost.post_id] : [undefined, undefined]
  const listArgs = { ...filters, ...(s.view === 'post' && selectedPost ? { channel_id: channelId, post_id: postId ?? null } : {}), limit: 100 }
  const list = useQuery({
    queryKey: ['comments-list', listArgs], queryFn: () => commentsList(listArgs), refetchInterval: 15_000, placeholderData: (p) => p,
    enabled: s.view === 'comments' || !!selectedPost || (!!overview.data && posts.length === 0),
  })
  const items = useMemo(() => list.data?.items ?? [], [list.data])
  const current = items.find((i) => i.id === s.c) ?? null

  useEffect(() => { setPicked(new Set()) }, [s.view, s.state, s.platform, s.post, search])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['comments-overview'] })
    void qc.invalidateQueries({ queryKey: ['comments-list'] })
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    if (s.c) void qc.invalidateQueries({ queryKey: ['inbox-thread', s.c] })
  }
  const bulk = useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: Parameters<typeof inboxBulk>[1] }) => inboxBulk(ids, patch),
    onSuccess: (n) => { toast.success(`${formatNumber(n)} updated`); setPicked(new Set()); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  /** Like / hide / delete one by one on Meta, with progress. */
  const runOnMeta = async (label: string, op: CommentOp, targets: CommentItem[]) => {
    const list = targets.filter((t) => t.comment.id && !(op === 'like' && t.platform === 'INSTAGRAM'))
    if (!list.length) return toast.error(op === 'like' ? 'Instagram comments cannot be liked by apps' : 'Nothing to do')
    setProgress({ label, done: 0, total: list.length, failed: [] })
    setProgressOpen(true)
    for (const t of list) {
      try {
        await commentAction(t.comment.id!, op)
        setProgress((p) => p && { ...p, done: p.done + 1 })
      } catch (e) {
        setProgress((p) => p && { ...p, done: p.done + 1, failed: [...p.failed, `${t.customer_name ?? 'Comment'}: ${toUserMessage(e)}`] })
      }
    }
    setPicked(new Set())
    refresh()
  }
  const one = useMutation({
    mutationFn: ({ item, op }: { item: CommentItem; op: CommentOp }) => commentAction(item.comment.id!, op),
    onSuccess: (_r, v) => { toast.success({ like: 'Liked', unlike: 'Like removed', hide: 'Hidden', unhide: 'Shown again', delete: 'Deleted' }[v.op]); refresh() },
    onError: (e) => { toast.error(toUserMessage(e)); refresh() },
  })

  const open = (id: string) => {
    update({ c: id }, { resetPage: false })
    if (!window.matchMedia('(min-width: 1280px)').matches) setMobileDetail(true)
  }
  const next = () => {
    const waiting = items.filter((i) => i.awaiting_since && !i.no_reply_needed && i.id !== s.c)
    const after = waiting.find((i) => items.indexOf(i) > items.findIndex((x) => x.id === s.c)) ?? waiting[0]
    if (after) open(after.id)
    else toast.success('Nothing else is waiting here')
  }

  if (overview.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const counts = overview.data!.counts
  const autoOn = (automation.data?.settings.auto_reply_channels.length ?? 0) > 0
  const modOn = !!automation.data?.settings.moderation.enabled
  const activeFilters = s.state !== 'all' || !!s.platform || !!search
  const pickedItems = items.filter((i) => picked.has(i.id))

  return (
    <div className="space-y-3">
      <MessagingTabs unread={inbox.data?.counts.unread} comments={inbox.data?.comments?.awaiting} />

      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Comments</h1>
        <span className="hidden size-1.5 animate-pulse rounded-full bg-emerald-500 sm:inline-block" title="Live: checked every 15 seconds" />
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          <b className="text-amber-500">{formatNumber(counts.awaiting)}</b> waiting · {formatNumber(counts.unread)} unread
        </p>
        <div className="ml-auto flex items-center gap-1">
          <StatusLink to="/admin/inbox/auto-replies" on={autoOn} label="Auto Reply" icon={<Zap />} />
          <StatusLink to="/admin/inbox/auto-replies?tab=moderation" on={modOn} label="Moderation" icon={<ShieldCheck />} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!items.some((i) => i.unread_count > 0) || bulk.isPending}
                onClick={() => bulk.mutate({ ids: items.filter((i) => i.unread_count > 0).map((i) => i.id), patch: { read: true } })}><Check /> Mark these read</DropdownMenuItem>
              <DropdownMenuItem onClick={refresh}><RefreshCw /> Refresh</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-80">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search comments or people" className="h-8 pl-8 text-sm" />
        </div>
        <Segmented value={s.platform} onChange={(v) => update({ platform: v, post: '', c: '' }, { resetPage: false })}
          options={[['', 'All'], ['FACEBOOK', <PlatformIcon key="f" platform="FACEBOOK" className="size-3.5" />], ['INSTAGRAM', <PlatformIcon key="i" platform="INSTAGRAM" className="size-3.5" />]]} />
        <Segmented className="ml-auto" value={s.view} onChange={(v) => update({ view: v, c: '' }, { resetPage: false })}
          options={[['post', 'Posts'], ['comments', 'All']]} />
      </div>

      <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
        {STATES.map((t) => (
          <button key={t.value} type="button" onClick={() => update({ state: t.value, post: '', c: '' }, { resetPage: false })}
            className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
              s.state === t.value && 'bg-foreground text-background hover:text-background')}>
            {t.label}
          </button>
        ))}
        {activeFilters && (
          <button type="button" className="ml-1 shrink-0 text-xs whitespace-nowrap text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => { setQ(''); update({ state: 'all', platform: '', post: '', c: '' }, { resetPage: false }) }}>Clear</button>
        )}
      </div>

      {progress && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <button type="button" onClick={() => setProgressOpen((o) => !o)} className="flex flex-1 items-center gap-1.5 font-medium">
              {progressOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Comment action progress
            </button>
            <span className="text-xs text-muted-foreground tabular-nums">{progress.label}: {progress.done}/{progress.total}{progress.failed.length ? ` · ${progress.failed.length} failed` : ''}</span>
            <Button size="icon-sm" variant="ghost" onClick={() => setProgress(null)} aria-label="Close"><X /></Button>
          </div>
          {progressOpen && (
            <div className="space-y-2 border-t px-3 py-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(100 * progress.done) / progress.total}%` }} /></div>
              {progress.failed.map((f) => <p key={f} className="text-xs text-destructive">{f}</p>)}
            </div>
          )}
        </div>
      )}

      <div className="grid h-[calc(100dvh-12.5rem)] min-h-[480px] gap-3 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        {/* Posts */}
        <aside className={cn('flex min-h-0 flex-col rounded-xl border bg-card', s.view === 'post' && s.post && 'hidden lg:flex')}>
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <h2 className="text-sm font-semibold">{s.view === 'post' ? 'Posts' : 'Post'}</h2>
            <span className="text-[11px] text-muted-foreground">{s.view === 'post' ? 'Select a post to read and reply' : 'Where the selected comment is'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {s.view === 'post' ? (
              posts.length === 0 ? <Empty text={activeFilters ? 'No post has comments that match.' : 'Comments on your posts and ads appear here.'} /> : (
                <ul>{posts.map((p) => <PostRow key={postKey(p)} p={p} on={selectedPost ? postKey(p) === postKey(selectedPost) : false}
                  onClick={() => update({ post: postKey(p), c: '' }, { resetPage: false })} />)}</ul>
              )
            ) : current ? <PostRow p={posts.find((p) => p.channel_id === current.channel_id && p.post_id === current.post_id) ?? {
              channel_id: current.channel_id, post_id: current.post_id, platform: current.platform, channel_name: current.channel_name, caption: current.post_caption,
              image_url: current.post_image, permalink: null, posted_at: null, is_ad: false, media_type: null, likes: null, shares: null, meta_comments: null,
              matching: 1, awaiting: current.awaiting_since ? 1 : 0, total: 1, latest: null, last_at: current.last_message_at,
            }} on onClick={() => update({ view: 'post', post: `${current.channel_id}|${current.post_id ?? ''}` }, { resetPage: false })} />
              : <Empty text="Select a comment to see its post here." />}
          </div>
        </aside>

        {/* Comments */}
        <section className={cn('flex min-h-0 flex-col rounded-xl border bg-card', s.view === 'post' && !s.post && 'hidden lg:flex')}>
          {s.view === 'post' && selectedPost && (
            <>
              <Button size="sm" variant="ghost" className="m-2 mb-0 w-fit gap-1 lg:hidden" onClick={() => update({ post: '', c: '' }, { resetPage: false })}><ArrowLeft /> Posts</Button>
              <PostHeader p={selectedPost} canManage={can('inbox.manage')} />
            </>
          )}
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Badge variant="warning" className="tabular-nums">{formatNumber(items.filter((i) => i.awaiting_since && !i.no_reply_needed).length)} awaiting in these results</Badge>
            {s.view === 'comments' && <span className="text-[11px] text-muted-foreground">Customer comments across all posts</span>}
            <Button size="sm" variant={selecting ? 'secondary' : 'ghost'} className="ml-auto h-7 text-xs" onClick={() => { setSelecting((v) => !v); setPicked(new Set()) }}>
              {selecting ? 'Done selecting' : 'Select comments'}
            </Button>
            {selecting && (
              <Checkbox checked={items.length > 0 && picked.size === items.length} onCheckedChange={(v) => setPicked(v ? new Set(items.map((i) => i.id)) : new Set())} aria-label="Select all" />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isLoading ? <div className="flex justify-center py-10"><Spinner /></div>
              : items.length === 0 ? <Empty text={s.state === 'awaiting' ? 'Nothing is waiting for a reply. 🎉' : 'No comments match these filters.'} />
                : (
                  <ul className="divide-y">
                    {items.map((i) => (
                      <CommentRow key={i.id} i={i} on={i.id === s.c} selecting={selecting} picked={picked.has(i.id)}
                        onPick={(v) => setPicked((p) => { const n = new Set(p); if (v) n.add(i.id); else n.delete(i.id); return n })}
                        onOpen={() => open(i.id)} replying={replying?.id === i.id ? replying.mode : null}
                        onReply={(mode) => { setReplying({ id: i.id, mode }); update({ c: i.id }, { resetPage: false }) }}
                        onCloseReply={() => setReplying(null)} onSent={() => { setReplying(null); refresh() }}
                        onAction={(op) => one.mutate({ item: i, op })}
                        onNoReply={(v) => bulk.mutate({ ids: [i.id], patch: { no_reply_needed: v, read: true } })} />
                    ))}
                  </ul>
                )}
            {list.data && list.data.total > items.length && <p className="p-3 text-center text-xs text-muted-foreground">Showing the newest {items.length} of {formatNumber(list.data.total)}.</p>}
          </div>
        </section>

        {/* Detail */}
        <aside className="hidden min-h-0 rounded-xl border bg-card xl:block">
          {current ? <CommentDetail item={current} onClose={() => update({ c: '' }, { resetPage: false })} onNext={next} onChanged={refresh}
            onAction={(op) => one.mutate({ item: current, op })} onReply={(mode) => setReplying({ id: current.id, mode })}
            onNoReply={(v) => bulk.mutate({ ids: [current.id], patch: { no_reply_needed: v, read: true } })} />
            : <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">Click a comment to open it here.</div>}
        </aside>
      </div>

      <Sheet open={mobileDetail && !!current} onOpenChange={setMobileDetail}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-sm">
          <SheetTitle className="sr-only">Comment</SheetTitle>
          {current && <CommentDetail item={current} onClose={() => setMobileDetail(false)} onNext={next} onChanged={refresh}
            onAction={(op) => one.mutate({ item: current, op })} onReply={(mode) => { setReplying({ id: current.id, mode }); setMobileDetail(false) }}
            onNoReply={(v) => bulk.mutate({ ids: [current.id], patch: { no_reply_needed: v, read: true } })} />}
        </SheetContent>
      </Sheet>

      <BulkBar count={picked.size} onClear={() => setPicked(new Set())} noun="comments">
        <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={() => bulk.mutate({ ids: [...picked], patch: { no_reply_needed: true, read: true } })}><CircleSlash /> No reply needed</Button>
        <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={() => bulk.mutate({ ids: [...picked], patch: { read: true } })}><Check /> Mark read</Button>
        <Button size="sm" variant="ghost" onClick={() => void runOnMeta('Liking', 'like', pickedItems)}><Heart /> Like</Button>
        <Button size="sm" variant="ghost" onClick={() => void runOnMeta('Hiding', 'hide', pickedItems)}><EyeOff /> Hide</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost"><Tag /> Label</Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            {QUICK_LABELS.map((l) => <DropdownMenuItem key={l} onClick={() => bulk.mutate({ ids: [...picked], patch: { add_label: l } })}>{l}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </BulkBar>
    </div>
  )
}

/** Small on/off link to an automation setting: icon with a green dot when on. */
function StatusLink({ to, on, label, icon }: { to: string; on: boolean; label: string; icon: React.ReactNode }) {
  return (
    <Link to={to} title={`${label}: ${on ? 'on' : 'off'}`} aria-label={`${label}: ${on ? 'on' : 'off'}`}
      className="relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4">
      {icon}
      <span className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
    </Link>
  )
}

function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: ReadonlyArray<readonly [T, React.ReactNode]>; className?: string
}) {
  return (
    <div className={cn('inline-flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5', className)}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={cn('inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-xs font-medium text-muted-foreground', value === v && 'bg-background text-foreground shadow-xs')}>{l}</button>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground"><MessageCircle className="size-6" />{text}</div>
}

function PostThumb({ src, className }: { src: string | null; className?: string }) {
  return src
    ? <img src={src} alt="" className={cn('shrink-0 rounded-md bg-muted object-cover', className)} loading="lazy" referrerPolicy="no-referrer" />
    : <span className={cn('flex shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground', className)}><ImageOff className="size-4" /></span>
}

function PostRow({ p, on, onClick }: { p: CommentPost; on: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={cn('flex w-full gap-2.5 border-b border-l-2 border-l-transparent px-3 py-3 text-left transition-colors hover:bg-muted/50',
        on && 'border-l-primary bg-muted/60')}>
        <PostThumb src={p.image_url} className="size-10" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><PlatformIcon platform={p.platform} className="size-3" /> <span className="truncate">{p.channel_name}</span>{p.is_ad && <Badge variant="info" className="px-1 py-0 text-[9px]">Ad</Badge>}</span>
          <span className="line-clamp-2 text-sm font-medium">{p.caption || (p.post_id ? `Post ${p.post_id.split('_').pop()}` : 'A post or ad')}</span>
          {p.latest && <span className="line-clamp-1 text-[11px] text-muted-foreground"><span className="text-primary">•</span> Matching comment · {p.latest}</span>}
          <span className="flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
            {p.awaiting > 0 && <Badge variant="warning" className="px-1.5 py-0 text-[10px]">{p.awaiting} awaiting</Badge>}
            <span className="tabular-nums">{p.matching} matching · {p.meta_comments ?? p.total} total</span>
            <span className="ml-auto">{shortAgo(p.last_at)}</span>
          </span>
        </span>
      </button>
    </li>
  )
}

function PostHeader({ p, canManage }: { p: CommentPost; canManage: boolean }) {
  const qc = useQueryClient()
  const reload = useMutation({
    mutationFn: () => refreshPost(p.channel_id, p.post_id!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['comments-overview'] }),
    onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <div className="m-3 flex gap-3 rounded-xl border bg-muted/20 p-3">
      <PostThumb src={p.image_url} className="size-16 sm:h-40 sm:w-32" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <PlatformIcon platform={p.platform} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{p.channel_name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{p.posted_at ? `Posted ${formatDate(p.posted_at)}` : p.is_ad ? 'Ad' : 'Post'}{p.media_type ? ` · ${p.media_type.toLowerCase().replace(/_/g, ' ')}` : ''}</p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            {canManage && p.post_id && (
              <Link to={`/admin/inbox/auto-replies?new=1&post=${encodeURIComponent(p.post_id)}&channel=${p.channel_id}`} title="Auto Reply for this post" aria-label="Auto Reply for this post"
                className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-primary hover:bg-muted">
                <Zap /> <span className="hidden sm:inline">Auto Reply</span>
              </Link>
            )}
            {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" title="View on Meta" aria-label="View on Meta" className="inline-flex size-7 items-center justify-center rounded-full hover:bg-muted hover:text-foreground"><ExternalLink /></a>}
            {p.post_id && <button type="button" onClick={() => reload.mutate()} title="Refresh post" aria-label="Refresh post" className="inline-flex size-7 items-center justify-center rounded-full hover:bg-muted hover:text-foreground"><RefreshCw className={cn(reload.isPending && 'animate-spin')} /></button>}
          </div>
        </div>
        <p className="line-clamp-3 text-sm whitespace-pre-wrap sm:line-clamp-6">{p.caption || <span className="text-muted-foreground">The post text appears once Meta shares it.</span>}</p>
        <p className="flex flex-wrap gap-3 border-t pt-2 text-xs text-muted-foreground tabular-nums">
          {p.likes != null && <span>♡ {formatNumber(p.likes)}</span>}
          {p.shares != null && <span>↗ {formatNumber(p.shares)}</span>}
          <span className="ml-auto">{p.awaiting} awaiting · {formatNumber(p.meta_comments ?? p.total)} published on this post</span>
        </p>
      </div>
    </div>
  )
}

function StatusChip({ i }: { i: CommentItem }) {
  if (i.comment.removed_at) return <Badge variant="danger" className="px-1.5 py-0 text-[10px]">Deleted</Badge>
  if (i.comment.filtered) return <Badge variant="warning" className="px-1.5 py-0 text-[10px]" title={i.comment.filtered}>Filtered</Badge>
  if (i.comment.hidden) return <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">Hidden</Badge>
  return <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]"><Check className="size-2.5" /> Published</Badge>
}

function CommentRow({ i, on, selecting, picked, onPick, onOpen, replying, onReply, onCloseReply, onSent, onAction, onNoReply }: {
  i: CommentItem; on: boolean; selecting: boolean; picked: boolean; onPick: (v: boolean) => void; onOpen: () => void
  replying: ReplyMode | null; onReply: (mode: ReplyMode) => void; onCloseReply: () => void; onSent: () => void
  onAction: (op: CommentOp) => void; onNoReply: (v: boolean) => void
}) {
  const name = i.customer_name ?? 'Customer'
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  const waiting = i.awaiting_since && !i.no_reply_needed && !i.comment.removed_at
  return (
    <li className={cn('cursor-pointer px-3 py-3 transition-colors hover:bg-muted/30', on && 'bg-muted/50', i.unread_count > 0 && 'border-l-2 border-l-primary')} onClick={onOpen}>
      <div className="flex gap-2.5">
        {selecting && <Checkbox checked={picked} onCheckedChange={(v) => onPick(!!v)} onClick={(e) => e.stopPropagation()} className="mt-2" aria-label={`Select ${name}`} />}
        <ChatAvatar name={name} src={i.customer_avatar} platform={i.platform} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="inline-block max-w-full rounded-2xl bg-muted px-3 py-2">
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">{name} <StatusChip i={i} /></p>
            <p className={cn('text-sm break-words whitespace-pre-wrap', i.comment.removed_at && 'text-muted-foreground line-through')}>{i.comment.body || (i.comment.attachments?.length ? '📷 Photo' : '…')}</p>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>{shortAgo(i.comment.created_at)}</span>
            <button type="button" className="font-medium hover:text-foreground" onClick={stop(() => onReply('public'))}>Reply</button>
            <button type="button" className="font-medium hover:text-foreground" onClick={stop(() => onReply('private'))}><span className="sm:hidden">Private</span><span className="hidden sm:inline">Private message</span></button>
            {i.platform === 'FACEBOOK' && (
              <button type="button" className={cn('hidden font-medium hover:text-foreground sm:inline', i.comment.liked && 'text-primary')} onClick={stop(() => onAction(i.comment.liked ? 'unlike' : 'like'))}>
                {i.comment.liked ? 'Liked' : 'Like'}
              </button>
            )}
            <button type="button" className={cn('hidden font-medium hover:text-foreground sm:inline', i.no_reply_needed && 'text-foreground')} onClick={stop(() => onNoReply(!i.no_reply_needed))}>
              {i.no_reply_needed ? 'Needs a reply' : 'No reply needed'}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" onClick={(e) => e.stopPropagation()} aria-label="More"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
              <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                {i.platform === 'FACEBOOK' && <DropdownMenuItem className="sm:hidden" onClick={() => onAction(i.comment.liked ? 'unlike' : 'like')}><Heart /> {i.comment.liked ? 'Remove like' : 'Like'}</DropdownMenuItem>}
                <DropdownMenuItem className="sm:hidden" onClick={() => onNoReply(!i.no_reply_needed)}><CircleSlash /> {i.no_reply_needed ? 'Needs a reply' : 'No reply needed'}</DropdownMenuItem>
                {i.comment.hidden ? <DropdownMenuItem onClick={() => onAction('unhide')}><Eye /> Show again</DropdownMenuItem>
                  : <DropdownMenuItem onClick={() => onAction('hide')}><EyeOff /> Hide on {i.platform === 'FACEBOOK' ? 'Facebook' : 'Instagram'}</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => onReply('both')}><Lock /> Reply in public + private</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" disabled={!!i.comment.removed_at} onClick={() => onAction('delete')}><Trash2 /> Delete comment</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="ml-auto">{waiting ? <Waiting since={i.awaiting_since} /> : i.replied ? <span className="text-emerald-600">Replied</span> : null}</span>
          </div>
          {i.last_reply && i.replies > 0 && !replying && (
            <p className="mt-1.5 ml-1 line-clamp-1 border-l-2 pl-2 text-xs text-muted-foreground">
              {i.last_reply.direction === 'OUT' ? <b className="text-foreground">{i.last_reply.auto_kind ? 'Auto reply' : 'You'}{i.last_reply.private_reply ? ' (private)' : ''}:</b> : <b>{i.last_reply.sender_name ?? 'Customer'}:</b>} {i.last_reply.body}
              {i.replies > 1 && <span> · {i.replies} replies</span>}
            </p>
          )}
          {replying && <div className="mt-2"><CommentReply conversationId={i.id} name={name} mode={replying} onSent={onSent} onCancel={onCloseReply} /></div>}
        </div>
      </div>
    </li>
  )
}

function CommentDetail({ item, onClose, onNext, onChanged, onAction, onReply, onNoReply }: {
  item: CommentItem; onClose: () => void; onNext: () => void; onChanged: () => void
  onAction: (op: CommentOp) => void; onReply: (mode: ReplyMode) => void; onNoReply: (v: boolean) => void
}) {
  const { user } = useAuth()
  const thread = useQuery({ queryKey: ['inbox-thread', item.id], queryFn: () => inboxThread(item.id), refetchInterval: 10_000 })
  const staff = useQuery({ queryKey: ['inbox-staff'], queryFn: inboxStaff, staleTime: 5 * 60_000 })
  const [historyOpen, setHistoryOpen] = useState(false)
  const update = useMutation({
    mutationFn: (p: Parameters<typeof inboxUpdate>[1]) => inboxUpdate(item.id, p),
    onSuccess: () => { onChanged(); void thread.refetch() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const t = thread.data
  const labels = t?.conversation.labels ?? item.labels
  const chats = (t?.other_conversations ?? []).filter((o) => o.kind === 'MESSAGE')
  const name = item.customer_name ?? 'Customer'
  const icon = (label: string, el: React.ReactNode, fn: () => void, on = false, disabled = false) => (
    <Button size="icon-sm" variant="outline" className={cn('size-8', on && 'border-primary text-primary')} title={label} aria-label={label} onClick={fn} disabled={disabled}>{el}</Button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <ChatAvatar name={name} src={item.customer_avatar} platform={item.platform} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{item.comment.created_at && new Date(item.comment.created_at).toLocaleString()} · {item.channel_name}</p>
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onNext}>Next</Button>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close"><X /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {item.awaiting_since && !item.no_reply_needed && (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <Waiting since={item.awaiting_since} className="text-inherit" /> · waiting since {new Date(item.awaiting_since).toLocaleString()}
          </p>
        )}
        <p className="rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap">{item.comment.body || '…'}</p>
        {item.comment.filtered && <p className="text-xs text-amber-600">Hidden by moderation: {item.comment.filtered}</p>}

        <div className="space-y-1.5">
          {chats.length ? chats.map((o) => (
            <Link key={o.id} to={`/admin/inbox?c=${o.id}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/50">
              <PlatformIcon platform={o.platform} /> <span className="line-clamp-1 flex-1">{o.last_message_preview || 'Chat'}</span> <ExternalLink className="size-3" />
            </Link>
          )) : <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"><MessageCircle className="size-3.5" /> No linked chat yet. A private message starts one.</p>}
        </div>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Actions</h3>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 flex-1 justify-between text-xs">
                  <span className="flex items-center gap-1.5"><UserRound className="size-3.5" /> {t?.conversation.assigned_name ?? item.assigned_name ?? 'Unassigned'}</span> <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={t?.conversation.assigned_to ?? ''} onValueChange={(v) => update.mutate({ assigned_to: v || null })}>
                  <DropdownMenuRadioItem value="">Nobody</DropdownMenuRadioItem>
                  {staff.data?.map((s) => <DropdownMenuRadioItem key={s.id} value={s.id}>{s.full_name ?? 'Staff'}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" className="h-8 text-xs" disabled={!user || t?.conversation.assigned_to === user?.id} onClick={() => user && update.mutate({ assigned_to: user.id })}>Claim</Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {icon(item.no_reply_needed ? 'Needs a reply' : 'No reply needed', <CircleSlash />, () => onNoReply(!item.no_reply_needed), item.no_reply_needed)}
            {icon(item.comment.liked ? 'Remove like' : 'Like', <Heart className={cn(item.comment.liked && 'fill-current')} />, () => onAction(item.comment.liked ? 'unlike' : 'like'), !!item.comment.liked, item.platform !== 'FACEBOOK')}
            {icon(item.comment.hidden ? 'Show again' : 'Hide', item.comment.hidden ? <Eye /> : <EyeOff />, () => onAction(item.comment.hidden ? 'unhide' : 'hide'), !!item.comment.hidden)}
            {icon('Reply in public', <MessageCircle />, () => onReply('public'))}
            {icon('Private message', <Lock />, () => onReply('private'))}
            {icon('Delete on Meta', <Trash2 />, () => onAction('delete'), false, !!item.comment.removed_at)}
            {icon('Mark as spam', <Ban />, () => update.mutate({ labels: [...new Set([...labels, 'Spam'])] }), labels.includes('Spam'))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Labels</h3>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_LABELS.map((l) => {
              const on = labels.includes(l)
              return (
                <button key={l} type="button" onClick={() => update.mutate({ labels: on ? labels.filter((x) => x !== l) : [...labels, l] })}
                  className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>{l}</button>
              )
            })}
          </div>
        </section>

        {t && t.messages.length > 1 && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Thread</h3>
            <ul className="space-y-1.5">
              {t.messages.map((m) => (
                <li key={m.id} className={cn('rounded-lg px-2.5 py-1.5 text-xs', m.direction === 'OUT' ? 'ml-6 bg-primary/10' : 'mr-6 bg-muted')}>
                  <p className="font-medium">{m.direction === 'OUT' ? (m.sender_name ?? 'You') : (m.sender_name ?? name)}{m.private_reply && ' · private'}{m.status === 'FAILED' && <span className="text-destructive"> · not sent</span>}</p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {m.error && <p className="text-destructive">{m.error}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-lg border">
          <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium" onClick={() => setHistoryOpen((o) => !o)}>
            {historyOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Action history & reply outcomes
            <span className="ml-auto text-muted-foreground">{t?.history.length ?? 0}</span>
          </button>
          {historyOpen && (
            <ul className="space-y-1.5 border-t px-3 py-2">
              {(t?.history ?? []).length === 0 && <li className="text-xs text-muted-foreground">Nothing yet.</li>}
              {t?.history.map((h) => (
                <li key={h.id} className="text-xs">
                  <span className={cn('font-medium', h.status === 'FAILED' && 'text-destructive', h.status === 'SKIPPED' && 'text-muted-foreground')}>
                    {h.kind === 'AUTO_REPLY' ? `Auto reply${h.rule_name ? ` "${h.rule_name}"` : ''}` : h.kind === 'MODERATION' ? 'Moderation' : h.kind === 'FOLLOW_UP' ? 'Follow-up' : 'Action'} · {h.status.toLowerCase()}
                  </span>
                  {h.detail && <span className="text-muted-foreground"> · {h.detail}</span>}
                  <span className="block text-[10px] text-muted-foreground">{h.actor_name ?? 'Automatic'} · {timeAgo(h.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

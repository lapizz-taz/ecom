import { useQuery } from '@tanstack/react-query'
import { Inbox, MessageCircle, MessagesSquare, Search, SlidersHorizontal, Star, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useDebounce } from '@/hooks/use-debounce'
import { cn } from '@/lib/utils'
import { type ConversationStatus, type InboxFilters, inboxList, type InboxOverview, type InboxPlatform } from '@/services/inbox'
import { ChatAvatar, chatTime, PLATFORM } from './ui'

const TABS: Array<{ value: ConversationStatus; label: string; count: keyof InboxOverview['counts'] }> = [
  { value: 'OPEN', label: 'Open', count: 'open' },
  { value: 'FOLLOW_UP', label: 'Follow-up', count: 'follow_up' },
  { value: 'DONE', label: 'Done', count: 'done' },
]

export function ConversationList({ overview, selected, onSelect, filters, onFilters }: {
  overview: InboxOverview | undefined
  selected: string | null
  onSelect: (id: string) => void
  filters: InboxFilters
  onFilters: (f: InboxFilters) => void
}) {
  const [q, setQ] = useState(filters.q ?? '')
  const search = useDebounce(q, 300)
  const query = { ...filters, q: search || undefined, limit: 100 }
  const list = useQuery({ queryKey: ['inbox-list', query], queryFn: () => inboxList(query), refetchInterval: 8_000, placeholderData: (p) => p })
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...filters, ...patch })
  const platforms = [...new Set((overview?.channels ?? []).map((c) => c.platform))]
  const active = [filters.platform, filters.kind, filters.unread, filters.starred, filters.assigned, filters.label].filter(Boolean).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">Inbox</h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Filters" className="relative">
                <SlidersHorizontal />
                {active > 0 && <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">{active}</span>}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Channel</DropdownMenuLabel>
              {(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP'] as InboxPlatform[]).map((p) => (
                <DropdownMenuCheckboxItem key={p} checked={filters.platform === p} onCheckedChange={(v) => set({ platform: v ? p : '' })}>{PLATFORM[p].label}</DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Type</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={filters.kind === 'MESSAGE'} onCheckedChange={(v) => set({ kind: v ? 'MESSAGE' : '' })}>Messages</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={filters.kind === 'COMMENT'} onCheckedChange={(v) => set({ kind: v ? 'COMMENT' : '' })}>Post & ad comments</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={!!filters.unread} onCheckedChange={(v) => set({ unread: v })}>Unread only</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={!!filters.starred} onCheckedChange={(v) => set({ starred: v })}>Starred</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={filters.assigned === 'me'} onCheckedChange={(v) => set({ assigned: v ? 'me' : '' })}>Assigned to me</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={filters.assigned === 'none'} onCheckedChange={(v) => set({ assigned: v ? 'none' : '' })}>Not assigned</DropdownMenuCheckboxItem>
              {(overview?.labels.length ?? 0) > 0 && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Label</DropdownMenuLabel>
                {overview!.labels.map((l) => (
                  <DropdownMenuCheckboxItem key={l} checked={filters.label === l} onCheckedChange={(v) => set({ label: v ? l : '' })}>{l}</DropdownMenuCheckboxItem>
                ))}
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number or message" className="h-8 pl-8 text-sm" aria-label="Search conversations" />
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-0.5" role="tablist">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={filters.status === t.value} onClick={() => set({ status: t.value })}
              className={cn('rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors', filters.status === t.value && 'bg-background text-foreground shadow-xs')}>
              {t.label}{overview && overview.counts[t.count] > 0 && <span className="ml-1 tabular-nums opacity-70">{overview.counts[t.count]}</span>}
            </button>
          ))}
        </div>
        {platforms.length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            <Chip on={!filters.platform} onClick={() => set({ platform: '' })}>All</Chip>
            {platforms.map((p) => <Chip key={p} on={filters.platform === p} onClick={() => set({ platform: filters.platform === p ? '' : p })}>{PLATFORM[p].short}</Chip>)}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : !list.data?.items.length ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
            <Inbox className="size-6" />
            {search || active ? 'Nothing matches these filters.' : filters.status === 'DONE' ? 'No closed conversations yet.' : 'No conversations here yet. New messages and comments appear by themselves.'}
          </div>
        ) : (
          <ul>
            {list.data.items.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onSelect(c.id)}
                  className={cn('flex w-full gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-muted/50', selected === c.id && 'bg-muted')}>
                  <ChatAvatar name={c.customer_name} src={c.customer_avatar} platform={c.platform} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cn('truncate text-sm', c.unread_count > 0 ? 'font-semibold' : 'font-medium')}>{c.customer_name ?? c.customer_phone ?? 'Customer'}</span>
                      {c.starred && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{chatTime(c.last_message_at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className={cn('line-clamp-1 flex-1 text-xs', c.unread_count > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                        {c.last_message_direction === 'OUT' && <span className="text-muted-foreground">You: </span>}
                        {c.last_message_preview || '…'}
                      </span>
                      {c.unread_count > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">{c.unread_count}</span>}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1">
                      {c.kind === 'COMMENT'
                        ? <Badge variant="neutral" className="gap-1 px-1.5 py-0 text-[10px]"><MessagesSquare className="size-3" /> Comment</Badge>
                        : <Badge variant="neutral" className="gap-1 px-1.5 py-0 text-[10px]"><MessageCircle className="size-3" /> {PLATFORM[c.platform].label}</Badge>}
                      {c.assigned_name
                        ? <Badge variant="neutral" className="gap-1 px-1.5 py-0 text-[10px]"><UserRound className="size-3" /> {c.assigned_name.split(' ')[0]}</Badge>
                        : <span className="text-[10px] text-muted-foreground">Unassigned</span>}
                      {c.labels.slice(0, 2).map((l) => <Badge key={l} variant="violet" className="px-1.5 py-0 text-[10px]">{l}</Badge>)}
                      {c.linked_order_id && <Badge variant="success" className="px-1.5 py-0 text-[10px]">Order</Badge>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.total > list.data.items.length && (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">Showing the newest {list.data.items.length} of {list.data.total}. Search to find older ones.</p>
        )}
      </div>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
      {children}
    </button>
  )
}

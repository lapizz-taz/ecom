import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, MessageSquareText, Phone } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type ContactMessage, listContactMessages, updateContactMessage } from '@/services/support-center'

const TOPIC: Record<ContactMessage['topic'], string> = { SALES: 'Getting started', SUPPORT: 'Account help', PARTNERSHIP: 'Partnership', GENERAL: 'Other' }
const STATUS: Record<ContactMessage['status'], { label: string; variant: 'warning' | 'success' | 'neutral' }> = {
  NEW: { label: 'New', variant: 'warning' }, REPLIED: { label: 'Replied', variant: 'success' }, CLOSED: { label: 'Closed', variant: 'neutral' },
}
const FILTERS: Array<[ContactMessage['status'] | '', string]> = [['NEW', 'New'], ['REPLIED', 'Replied'], ['CLOSED', 'Closed'], ['', 'All']]

/** Messages from the website contact form: reply by e-mail or phone, then mark them. */
export function ContactMessages() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ status: 'NEW' })
  const status = (state.status || null) as ContactMessage['status'] | null
  const list = useQuery({ queryKey: ['platform-contact', status], queryFn: () => listContactMessages(status) })
  const mark = useMutation({
    mutationFn: ({ id, to }: { id: number; to: ContactMessage['status'] }) => updateContactMessage(id, to),
    onSuccess: (m) => {
      toast.success(`Marked ${STATUS[m.status].label.toLowerCase()}`)
      void queryClient.invalidateQueries({ queryKey: ['platform-contact'] })
    },
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map(([v, l]) => (
          <button key={l} type="button" onClick={() => update({ status: v })}
            className={cn('rounded-md px-2.5 py-1 text-[13px]', state.status === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
            {l}{v === 'NEW' && list.data?.new ? <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-700">{list.data.new}</span> : null}
          </button>
        ))}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : !list.data ? <LoadingState />
          : list.data.items.length === 0 ? <EmptyState icon={<MessageSquareText />} title="No messages here" description="Messages sent from the website's contact page appear here." />
            : (
              <div className="grid gap-2">
                {list.data.items.map((m) => (
                  <Card key={m.id} className="py-0">
                    <CardContent className="space-y-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{m.name}</p>
                        {m.business && <span className="text-[13px] text-muted-foreground">· {m.business}</span>}
                        <Badge variant="outline">{TOPIC[m.topic]}</Badge>
                        <Badge variant={STATUS[m.status].variant}>{STATUS[m.status].label}</Badge>
                        <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(m.created_at)}</span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{m.message}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        {m.email && <Button size="sm" variant="outline" asChild><a href={`mailto:${m.email}?subject=${encodeURIComponent('Your message to Fullfilio')}`}><Mail /> {m.email}</a></Button>}
                        {m.phone && <Button size="sm" variant="outline" asChild><a href={`tel:${m.phone}`}><Phone /> {m.phone}</a></Button>}
                        {can('support', 'edit') && (
                          <span className="ml-auto flex gap-1.5">
                            {m.status !== 'REPLIED' && <Button size="sm" variant="secondary" disabled={mark.isPending} onClick={() => mark.mutate({ id: m.id, to: 'REPLIED' })}>Mark replied</Button>}
                            {m.status !== 'CLOSED' && <Button size="sm" variant="ghost" disabled={mark.isPending} onClick={() => mark.mutate({ id: m.id, to: 'CLOSED' })}>Close</Button>}
                            {m.status === 'CLOSED' && <Button size="sm" variant="ghost" disabled={mark.isPending} onClick={() => mark.mutate({ id: m.id, to: 'NEW' })}>Reopen</Button>}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
    </div>
  )
}

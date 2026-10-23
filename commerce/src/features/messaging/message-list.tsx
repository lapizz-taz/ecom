import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'
import { type CustomerMessage, type MessageChannel, setMessageEnabled } from '@/services/messaging'
import { EVENT_INFO, MESSAGE_EVENTS, type MessageEvent } from './shared'

const GROUPS = ['Order processing', 'Payments', 'Order exceptions', 'Marketing'] as const

/**
 * The store's customer messages in Shopify's groups (Order processing, Payments, Order exceptions, Marketing):
 * each with what it is, when it goes out, a switch and a link to its editor.
 */
export function MessageGroups({ channel, messages, canManage, status, basePath }: {
  channel: MessageChannel
  messages: CustomerMessage[]
  canManage: boolean
  /** Something shown next to the switch (WhatsApp: Meta's review). */
  status?: (m: CustomerMessage) => ReactNode
  basePath: string
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => setMessageEnabled(id, on),
    onSuccess: (_d, v) => {
      toast.success(v.on ? 'Switched on' : 'Switched off')
      void queryClient.invalidateQueries({ queryKey: ['customer-messages', channel] })
    },
  })
  const byEvent = new Map(messages.map((m) => [m.event as MessageEvent, m]))
  return (
    <div className="space-y-4">
      {GROUPS.map((group) => {
        const rows = MESSAGE_EVENTS.filter((e) => EVENT_INFO[e].group === group && byEvent.has(e))
        if (!rows.length) return null
        return (
          <section key={group} className="overflow-hidden rounded-xl border bg-card">
            <h3 className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold">{group}</h3>
            <ul className="divide-y">
              {rows.map((e) => {
                const m = byEvent.get(e)!
                return (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30">
                    <Link to={`${basePath}/${m.id}`} className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{EVENT_INFO[e].title}</span>
                      <span className="block text-xs text-muted-foreground">{EVENT_INFO[e].when}</span>
                    </Link>
                    {status?.(m)}
                    <Switch checked={m.is_enabled} disabled={!canManage || toggle.isPending} aria-label={`Send ${EVENT_INFO[e].title}`}
                      onCheckedChange={(on) => toggle.mutate({ id: m.id, on })} />
                    <Link to={`${basePath}/${m.id}`} aria-label={`Edit ${EVENT_INFO[e].title}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                      <ChevronRight className="size-4" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

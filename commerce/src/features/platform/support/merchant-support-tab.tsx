import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus } from 'lucide-react'
import { useState } from 'react'
import { ErrorState, TableSkeleton } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { usePlatform } from '@/features/platform/platform-context'
import { StartSessionDialog } from '@/features/platform/support/start-session-dialog'
import { NewTicketDialog, SessionsTable, TicketSheet, TicketsTable } from '@/features/platform/support/ticket-parts'
import type { MerchantDetail } from '@/services/platform'
import { listSupportSessions, listTickets } from '@/services/support-center'

/** The merchant's tickets and the customer-view sessions on their account. */
export function MerchantSupportTab({ detail }: { detail: MerchantDetail }) {
  const m = detail.merchant
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [ticket, setTicket] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'ticket' | 'view' | null>(null)
  const tickets = useQuery({ queryKey: ['platform-tickets', 'merchant', m.id], queryFn: () => listTickets({ view: 'all', merchant: m.id }, 100) })
  const sessions = useQuery({ queryKey: ['platform-support-sessions', 'merchant', m.id], queryFn: () => listSupportSessions({ merchant: m.id }, 50) })
  const ref = { id: m.id, number: m.number, name: m.name }
  return (
    <div className="space-y-4">
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-row items-center justify-between border-b py-3">
          <CardTitle className="text-sm">Tickets{tickets.data && ` (${tickets.data.total})`}</CardTitle>
          {can('support', 'create', m.id) && <Button size="sm" variant="outline" onClick={() => setDialog('ticket')}><Plus /> New ticket</Button>}
        </CardHeader>
        {tickets.error ? <ErrorState error={tickets.error} onRetry={() => tickets.refetch()} /> : !tickets.data ? <TableSkeleton /> : (
          <TicketsTable rows={tickets.data.rows} onOpen={setTicket} showMerchant={false} />
        )}
      </Card>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-row items-center justify-between border-b py-3">
          <CardTitle className="text-sm">Customer-view sessions</CardTitle>
          {can('support', 'edit', m.id) && m.status !== 'CLOSED' && <Button size="sm" variant="outline" onClick={() => setDialog('view')}><Eye /> View as merchant</Button>}
        </CardHeader>
        {sessions.error ? <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} /> : !sessions.data ? <TableSkeleton /> : (
          <SessionsTable rows={sessions.data.rows} canManage={sessions.data.can.manage} showMerchant={false}
            onChanged={() => void queryClient.invalidateQueries({ queryKey: ['platform-support-sessions'] })} />
        )}
      </Card>
      <TicketSheet id={ticket} onClose={() => setTicket(null)} />
      {dialog === 'ticket' && <NewTicketDialog merchant={ref} onClose={() => setDialog(null)} onCreated={(id) => { void tickets.refetch(); setTicket(id) }} />}
      {dialog === 'view' && <StartSessionDialog merchant={ref} onClose={() => setDialog(null)} />}
    </div>
  )
}

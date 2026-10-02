import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, MoreHorizontal, Phone, User, Wallet, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { EmptyState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { FraudDecisionDialog } from '@/features/orders/order-dialogs'
import { useUrlState } from '@/hooks/use-url-state'
import { formatPercent, timeAgo } from '@/lib/format'
import { ORDER_STATUS, RISK_LEVEL } from '@/lib/status'
import { addOrderNote, fraudQueue, fraudReviewDecide } from '@/services/orders'
import type { FraudQueueItem, OrderStatus } from '@/types/domain'

const TABS: Record<string, { label: string; statuses: OrderStatus[] }> = {
  review: { label: 'Needs review', statuses: ['FRAUD_REVIEW'] },
  advance: { label: 'Awaiting advance', statuses: ['ADVANCE_REQUIRED'] },
  rejected: { label: 'Rejected', statuses: ['REJECTED_FRAUD'] },
  all: { label: 'All', statuses: ['FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'REJECTED_FRAUD', 'CONFIRMATION_REQUIRED'] },
}
const PAGE_SIZE = 25

export default function FraudReviewPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'review', risk: '', page: '1' })
  const page = Number(state.page) || 1
  const tab = TABS[state.tab] ?? TABS.review
  const [decision, setDecision] = useState<{ item: FraudQueueItem; action: 'APPROVE' | 'REQUEST_ADVANCE' | 'REJECT' } | null>(null)

  const queue = useQuery({
    queryKey: ['orders', 'fraud-queue', state],
    placeholderData: keepPreviousData,
    queryFn: () => fraudQueue(tab.statuses, (state.risk || undefined) as never, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  })

  const logContact = async (item: FraudQueueItem) => {
    window.location.href = `tel:${item.customer_phone}`
    await addOrderNote(item.id, 'Called customer from the fraud review queue', 'INTERNAL', 'CONTACT')
    void queryClient.invalidateQueries({ queryKey: ['order', item.id] })
  }

  const columns: Column<FraudQueueItem>[] = [
    {
      key: 'order', header: 'Order', primary: true,
      cell: (o) => <div><Link to={`/admin/orders/${o.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{o.order_number}</Link><p className="text-xs text-muted-foreground">{timeAgo(o.created_at)}</p></div>,
    },
    { key: 'customer', header: 'Customer', cell: (o) => <div><p>{o.customer_name}</p><p className="text-xs text-muted-foreground">{o.customer_phone} · {o.shipping_district}</p></div> },
    { key: 'value', header: 'Value', align: 'right', cell: (o) => <Money value={o.total_amount} /> },
    { key: 'risk', header: 'Risk', cell: (o) => <div className="flex items-center gap-1.5"><StatusBadge value={o.risk_level} map={RISK_LEVEL} />{o.risk_score !== null && <span className="text-xs text-muted-foreground">{Math.round(o.risk_score)}</span>}</div> },
    { key: 'courier', header: 'Courier score', align: 'right', cell: (o) => (o.courier_score === null ? '—' : formatPercent(o.courier_score, 0)) },
    { key: 'cancel', header: 'Cancel', align: 'right', hideOnMobile: true, cell: (o) => formatPercent(o.cancellation_rate, 0) },
    { key: 'return', header: 'Return', align: 'right', hideOnMobile: true, cell: (o) => formatPercent(o.return_rate, 0) },
    { key: 'failed', header: 'Failed', align: 'right', cell: (o) => formatPercent(o.failed_delivery_rate, 0) },
    { key: 'rec', header: 'Recommendation', hideOnMobile: true, cell: (o) => <span className="block max-w-48 truncate text-xs" title={o.matched_rules?.map((r) => r.name).join(', ')}>{o.recommendation ?? '—'}</span> },
    { key: 'advance', header: 'Advance', align: 'right', cell: (o) => (o.advance_required > 0 ? <span><Money value={o.advance_required} />{o.amount_paid > 0 && <span className="block text-xs text-emerald-700">paid <Money value={o.amount_paid} /></span>}</span> : '—') },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge value={o.status} map={ORDER_STATUS} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (o) => can('fraud.review') ? (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {o.status !== 'REJECTED_FRAUD' && <Button size="icon-sm" variant="outline" title="Approve" aria-label="Approve" onClick={() => setDecision({ item: o, action: 'APPROVE' })}><Check /></Button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setDecision({ item: o, action: 'APPROVE' })}><Check /> Approve</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDecision({ item: o, action: 'REQUEST_ADVANCE' })}><Wallet /> Request advance</DropdownMenuItem>
              {o.status !== 'REJECTED_FRAUD' && <DropdownMenuItem variant="destructive" onClick={() => setDecision({ item: o, action: 'REJECT' })}><X /> Reject</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logContact(o)}><Phone /> Contact customer</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/admin/customers/${o.customer_id}`)}><User /> View customer</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/admin/orders?q=${encodeURIComponent(o.customer_phone)}`)}><History /> Order history</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Fraud review" description="Risky orders held for a decision. Every decision is recorded with who made it and why." />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
          <TabsList>{Object.entries(TABS).map(([k, t]) => <TabsTrigger key={k} value={k}>{t.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <Select value={state.risk || 'all'} onValueChange={(v) => update({ risk: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All risk levels</SelectItem>
            {Object.entries(RISK_LEVEL).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={queue.data?.items}
        rowKey={(o) => o.id}
        loading={queue.isFetching}
        error={queue.error}
        onRetry={() => queue.refetch()}
        rowHref={(o) => `/admin/orders/${o.id}`}
        empty={<EmptyState title="Nothing to review" description="Risky orders will appear here automatically." />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={queue.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />}
      />
      {decision && (
        <FraudDecisionDialog
          open
          action={decision.action}
          order={decision.item}
          onOpenChange={() => setDecision(null)}
          onConfirm={async (input) => {
            await fraudReviewDecide(decision.item.id, decision.action, input)
            toast.success(`${decision.item.order_number}: decision recorded`)
            void queryClient.invalidateQueries({ queryKey: ['orders'] })
          }}
        />
      )}
    </div>
  )
}

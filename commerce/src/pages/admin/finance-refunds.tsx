import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { EmptyState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { RefundDialog, RetainAdvanceDialog } from '@/features/orders/order-dialogs'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime } from '@/lib/format'
import { ORDER_STATUS, PAYMENT_CHANNEL } from '@/lib/status'
import { listRefunds, ordersAwaitingAdvanceResolution } from '@/services/finance'
import type { OrderStatus } from '@/types/domain'

const PAGE_SIZE = 25

export default function FinanceRefundsPage() {
  const [state, update] = useUrlState({ tab: 'refunds', page: '1' })
  const advances = useQuery({ queryKey: ['finance', 'unresolved-advances'], queryFn: ordersAwaitingAdvanceResolution })
  return (
    <div className="space-y-4">
      <PageHeader title="Refunds" description="Refunds on delivered orders reduce revenue. Advances on orders that were never delivered are either refunded or kept as other income." />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <TabsList>
          <TabsTrigger value="refunds">Refund history</TabsTrigger>
          <TabsTrigger value="advances">Unresolved advances{advances.data?.length ? ` (${advances.data.length})` : ''}</TabsTrigger>
        </TabsList>
        <TabsContent value="refunds"><RefundHistory page={Number(state.page) || 1} onPage={(p) => update({ page: String(p) }, { resetPage: false })} /></TabsContent>
        <TabsContent value="advances"><UnresolvedAdvances query={advances} /></TabsContent>
      </Tabs>
    </div>
  )
}

function RefundHistory({ page, onPage }: { page: number; onPage: (p: number) => void }) {
  const { nameOf } = useStaffDirectory()
  const refunds = useQuery({ queryKey: ['finance', 'refunds', page], placeholderData: keepPreviousData, queryFn: () => listRefunds(page, PAGE_SIZE) })
  type Row = NonNullable<typeof refunds.data>['items'][number]
  const columns: Column<Row>[] = [
    { key: 'date', header: 'Date', cell: (r) => formatDateTime(r.created_at) },
    {
      key: 'order', header: 'Order', primary: true,
      cell: (r) => r.orders ? <Link to={`/admin/orders/${r.orders.id}`} className="font-medium hover:underline">{r.orders.order_number}</Link> : '—',
    },
    { key: 'customer', header: 'Customer', cell: (r) => r.orders?.customer_name },
    { key: 'status', header: 'Order status', hideOnMobile: true, cell: (r) => r.orders ? <StatusBadge value={r.orders.status as OrderStatus} map={ORDER_STATUS} /> : null },
    { key: 'channel', header: 'Refunded via', cell: (r) => PAYMENT_CHANNEL[r.channel] },
    { key: 'reason', header: 'Reason', hideOnMobile: true, cell: (r) => <span className="block max-w-64 truncate text-xs" title={r.note ?? ''}>{r.note ?? r.reference ?? '—'}</span> },
    { key: 'by', header: 'By', hideOnMobile: true, cell: (r) => nameOf(r.recorded_by) },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Money value={r.amount} /> },
  ]
  return (
    <DataTable columns={columns} rows={refunds.data?.items} rowKey={(r) => r.id} loading={refunds.isFetching} error={refunds.error}
      onRetry={() => refunds.refetch()} empty={<EmptyState title="No refunds yet" description="Refunds are issued from an order's payment section." />}
      footer={<Pagination page={page} pageSize={PAGE_SIZE} total={refunds.data?.total ?? 0} onPage={onPage} />} />
  )
}

type AdvanceRow = Awaited<ReturnType<typeof ordersAwaitingAdvanceResolution>>[number]

function UnresolvedAdvances({ query }: { query: { data?: AdvanceRow[]; isFetching: boolean; error: unknown; refetch: () => unknown } }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<{ row: AdvanceRow; kind: 'refund' | 'retain' } | null>(null)
  const columns: Column<AdvanceRow>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (o) => <Link to={`/admin/orders/${o.id}`} className="font-medium hover:underline">{o.order_number}</Link> },
    { key: 'customer', header: 'Customer', cell: (o) => o.customer_name },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge value={o.status as OrderStatus} map={ORDER_STATUS} /> },
    { key: 'when', header: 'Closed', hideOnMobile: true, cell: (o) => formatDate(o.cancelled_at ?? o.returned_at) },
    { key: 'paid', header: 'Paid', align: 'right', cell: (o) => <Money value={o.amount_paid} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (o) => can('refunds.manage') ? (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={() => setDialog({ row: o, kind: 'refund' })}>Refund</Button>
          <Button size="sm" variant="outline" onClick={() => setDialog({ row: o, kind: 'retain' })}>Keep</Button>
        </div>
      ) : null,
    },
  ]
  const done = () => {
    setDialog(null)
    void queryClient.invalidateQueries({ queryKey: ['finance'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  return (
    <>
      <DataTable columns={columns} rows={query.data} rowKey={(o) => o.id} loading={query.isFetching} error={query.error}
        onRetry={() => query.refetch()} empty={<EmptyState title="All advances are resolved" description="Cancelled, rejected or returned orders with money paid show up here." />} />
      {dialog?.kind === 'refund' && <RefundDialog open order={dialog.row} onOpenChange={(o) => !o && setDialog(null)} onDone={done} />}
      {dialog?.kind === 'retain' && <RetainAdvanceDialog open order={dialog.row} onOpenChange={(o) => !o && setDialog(null)} onDone={done} />}
    </>
  )
}

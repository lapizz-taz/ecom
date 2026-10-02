import { useQuery } from '@tanstack/react-query'
import { CalendarClock, User } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ProductionActions } from '@/features/production/production-actions'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, isoDateToday, titleCase } from '@/lib/format'
import { PRODUCTION_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { listProduction, type ProductionRow } from '@/services/production'
import type { Enums } from '@/types/database'

type Status = Enums<'production_status'>
const BOARD: Status[] = ['WAITING', 'IN_PRODUCTION', 'PAUSED', 'QUALITY_CHECK', 'PACKING', 'READY']
const PRIORITY = { URGENT: 'destructive', HIGH: 'warning', NORMAL: 'neutral', LOW: 'secondary' } as const

function ProductionCard({ row, nameOf }: { row: ProductionRow; nameOf: (id: string | null) => string }) {
  const overdue = row.deadline && row.deadline < isoDateToday() && !['READY', 'CANCELLED'].includes(row.status)
  const items = row.production_items
  return (
    <Card className="gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/admin/production/${row.id}`} className="font-medium hover:underline">{row.orders?.order_number}</Link>
        <Badge variant={PRIORITY[row.priority]}>{titleCase(row.priority)}</Badge>
      </div>
      <p className="truncate text-xs text-muted-foreground">{row.orders?.customer_name}</p>
      <ul className="space-y-0.5 text-sm">
        {items.slice(0, 3).map((i) => <li key={i.id} className="truncate">{i.quantity}× {i.product_name}{i.variant_title ? ` · ${i.variant_title}` : ''}</li>)}
        {items.length > 3 && <li className="text-xs text-muted-foreground">+{items.length - 3} more</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {row.deadline && <span className={cn('inline-flex items-center gap-1', overdue && 'font-medium text-red-600')}><CalendarClock className="size-3" />{formatDate(row.deadline)}</span>}
        {row.assigned_to && <span className="inline-flex items-center gap-1"><User className="size-3" />{nameOf(row.assigned_to)}</span>}
        {row.rejection_count > 0 && <span className="text-amber-700">QC rejected {row.rejection_count}×</span>}
      </div>
      <ProductionActions id={row.id} status={row.status} compact />
    </Card>
  )
}

export default function ProductionPage() {
  const { nameOf } = useStaffDirectory()
  const [state, update] = useUrlState({ status: '' })
  const statuses = state.status ? [state.status as Status] : BOARD
  const query = useQuery({ queryKey: ['production', statuses], queryFn: () => listProduction(statuses) })
  useRealtimeInvalidate('production_orders', [['production']])

  return (
    <div className="space-y-4">
      <PageHeader title="Production" description="Preparation pipeline: waiting → in production → quality check → packing → ready. Moving a card updates the order." />
      <Tabs value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
        <TabsList>
          <TabsTrigger value="all">Board</TabsTrigger>
          {BOARD.map((s) => <TabsTrigger key={s} value={s}>{PRODUCTION_STATUS[s].label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      {query.isLoading ? <LoadingState /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !query.data?.length ? (
        <EmptyState title="Nothing in production" description="Orders with made-to-order items appear here when they start processing." />
      ) : state.status ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {query.data.map((row) => <ProductionCard key={row.id} row={row} nameOf={nameOf} />)}
        </div>
      ) : (
        <div className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-2 sm:mx-0 sm:px-0">
          {BOARD.map((status) => {
            const rows = query.data.filter((r) => r.status === status)
            return (
              <section key={status} className="w-72 shrink-0 snap-start space-y-2 rounded-xl bg-muted/50 p-2">
                <h2 className="flex items-center justify-between px-1 text-sm font-medium">{PRODUCTION_STATUS[status].label}<Badge variant="secondary">{rows.length}</Badge></h2>
                {rows.map((row) => <ProductionCard key={row.id} row={row} nameOf={nameOf} />)}
                {rows.length === 0 && <p className="px-1 py-4 text-center text-xs text-muted-foreground">Empty</p>}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

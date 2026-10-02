import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { EmptyState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDateTime } from '@/lib/format'
import { MOVEMENT_TYPE } from '@/lib/status'
import { listMovements, type MovementRow } from '@/services/inventory'
import type { Enums } from '@/types/database'

const PAGE_SIZE = 50

function delta(n: number) {
  if (!n) return <span className="text-muted-foreground">—</span>
  return <span className={n > 0 ? 'text-emerald-700' : 'text-red-600'}>{n > 0 ? `+${n}` : n}</span>
}

export function MovementsTable({ types, title }: { types?: Enums<'inventory_movement_type'>[]; title: string }) {
  const { nameOf } = useStaffDirectory()
  const [state, update] = useUrlState({ type: '', from: '', to: '', page: '1' })
  const page = Number(state.page) || 1
  const filters = { type: state.type as Enums<'inventory_movement_type'> | '', types: state.type ? undefined : types, from: state.from, to: state.to }
  const movements = useQuery({
    queryKey: ['inventory', 'movements', filters, page],
    placeholderData: keepPreviousData,
    queryFn: () => listMovements({ ...filters, page, pageSize: PAGE_SIZE }),
  })

  const columns: Column<MovementRow>[] = [
    { key: 'date', header: 'Date', cell: (m) => formatDateTime(m.created_at) },
    { key: 'product', header: 'Product', primary: true, cell: (m) => <div><p className="font-medium">{m.products?.name}</p><p className="text-xs text-muted-foreground">{m.product_variants?.sku}{m.product_variants?.title !== 'Default' ? ` · ${m.product_variants?.title}` : ''}</p></div> },
    { key: 'type', header: 'Type', cell: (m) => <StatusBadge value={m.movement_type} map={MOVEMENT_TYPE} /> },
    { key: 'on_hand', header: 'On hand', align: 'right', cell: (m) => delta(m.on_hand_change) },
    { key: 'reserved', header: 'Reserved', align: 'right', cell: (m) => delta(m.reserved_change) },
    { key: 'damaged', header: 'Damaged', align: 'right', hideOnMobile: true, cell: (m) => delta(m.damaged_change) },
    { key: 'after', header: 'After', align: 'right', hideOnMobile: true, cell: (m) => <span className="text-xs text-muted-foreground">{m.on_hand_after} / {m.reserved_after}</span> },
    {
      key: 'ref', header: 'Reference',
      cell: (m) => m.reference_type === 'ORDER' && m.reference_id ? <Link to={`/admin/orders/${m.reference_id}`} className="underline">{m.reference_label}</Link>
        : m.reference_type === 'PURCHASE_ORDER' && m.reference_id ? <Link to={`/admin/purchases/${m.reference_id}`} className="underline">{m.reference_label}</Link>
        : <span className="text-muted-foreground">{m.reference_type?.toLowerCase() ?? '—'}</span>,
    },
    { key: 'note', header: 'Note', hideOnMobile: true, cell: (m) => <span className="block max-w-56 truncate text-xs" title={m.note ?? ''}>{m.note}</span> },
    { key: 'by', header: 'By', hideOnMobile: true, cell: (m) => <span className="text-xs">{nameOf(m.created_by)}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={state.type || 'all'} onValueChange={(v) => update({ type: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {Object.entries(MOVEMENT_TYPE).filter(([k]) => !types || types.includes(k as never)).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="h-8 w-36" value={state.from} onChange={(e) => update({ from: e.target.value })} aria-label="From" />
        <Input type="date" className="h-8 w-36" value={state.to} onChange={(e) => update({ to: e.target.value })} aria-label="To" />
        <Can permission="reports.export">
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => downloadCsv(title.toLowerCase().replace(/\s+/g, '-'), movements.data?.items ?? [], [
            { header: 'Date', value: (m) => formatDateTime(m.created_at) }, { header: 'Product', value: (m) => m.products?.name },
            { header: 'SKU', value: (m) => m.product_variants?.sku }, { header: 'Type', value: (m) => m.movement_type },
            { header: 'On hand change', value: (m) => m.on_hand_change }, { header: 'Reserved change', value: (m) => m.reserved_change },
            { header: 'Damaged change', value: (m) => m.damaged_change }, { header: 'On hand after', value: (m) => m.on_hand_after },
            { header: 'Reference', value: (m) => m.reference_label ?? m.reference_type }, { header: 'Note', value: (m) => m.note },
            { header: 'By', value: (m) => nameOf(m.created_by) },
          ])}><Download /> Export page</Button>
        </Can>
      </div>
      <DataTable columns={columns} rows={movements.data?.items} rowKey={(m) => m.id} loading={movements.isFetching} error={movements.error}
        onRetry={() => movements.refetch()} empty={<EmptyState title="No stock movements" />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={movements.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
    </div>
  )
}

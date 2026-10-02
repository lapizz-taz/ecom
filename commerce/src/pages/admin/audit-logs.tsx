import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type AuditRow, listAuditLogs } from '@/services/audit'

const PAGE_SIZE = 50
const ENTITY_TYPES = [
  'order', 'shipment', 'customer', 'finance_transaction', 'purchase_order', 'product_variant', 'products', 'product_variants', 'suppliers',
  'coupons', 'couriers', 'delivery_zones', 'settings', 'fraud_rules', 'fraud_rule_actions', 'notifications', 'finance_categories',
  'profile', 'profiles', 'role_permissions',
]

/** Where an entity lives in the admin, if it has a page. */
function entityHref(row: AuditRow): string | null {
  if (!row.entity_id) return null
  switch (row.entity_type) {
    case 'order': return `/admin/orders/${row.entity_id}`
    case 'products': return `/admin/products/${row.entity_id}`
    case 'purchase_order': return `/admin/purchases/${row.entity_id}`
    case 'customer': return `/admin/customers/${row.entity_id}`
    default: return null
  }
}

/** Fields that differ between old and new values. */
function changes(row: AuditRow): Array<{ key: string; from: unknown; to: unknown }> {
  const before = (row.old_values ?? {}) as Record<string, unknown>
  const after = (row.new_values ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !['updated_at', 'created_at'].includes(k))
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ key: k, from: before[k], to: after[k] }))
}

const show = (v: unknown) => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export default function AuditLogsPage() {
  const { staff, nameOf } = useStaffDirectory()
  const [state, update] = useUrlState({ action: '', entity: '', actor: '', from: '', to: '', page: '1' })
  const page = Number(state.page) || 1
  const [open, setOpen] = useState<Set<string>>(new Set())
  const logs = useQuery({
    queryKey: ['audit-logs', state],
    placeholderData: keepPreviousData,
    queryFn: () => listAuditLogs({ action: state.action, entityType: state.entity, actorId: state.actor || undefined, from: state.from, to: state.to, page, pageSize: PAGE_SIZE }),
  })
  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Every sensitive action and settings change, with who did it and what changed. Entries cannot be edited or deleted." />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.action} onChange={(action) => update({ action })} placeholder="Action, e.g. order. or settings" />
        <Select value={state.entity || 'all'} onValueChange={(v) => update({ entity: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All records</SelectItem>
            {ENTITY_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.actor || 'all'} onValueChange={(v) => update({ actor: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name || s.email}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="h-8 w-36" value={state.from} onChange={(e) => update({ from: e.target.value })} aria-label="From date" />
        <Input type="date" className="h-8 w-36" value={state.to} onChange={(e) => update({ to: e.target.value })} aria-label="To date" />
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {logs.error ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : !logs.data ? <TableSkeleton /> : logs.data.items.length === 0 ? <EmptyState title="Nothing recorded for these filters" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" /><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Record</TableHead><TableHead>Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={cn(logs.isFetching && 'opacity-60')}>
                {logs.data.items.map((row) => {
                  const diff = changes(row)
                  const expanded = open.has(row.id)
                  const href = entityHref(row)
                  const meta = row.metadata as Record<string, unknown>
                  return (
                    <Fragment key={row.id}>
                      <TableRow className="cursor-pointer" onClick={() => toggle(row.id)}>
                        <TableCell>{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{formatDateTime(row.created_at)}</TableCell>
                        <TableCell className="text-sm">{row.actor_id ? nameOf(row.actor_id) : <Badge variant="neutral">system</Badge>}{row.actor_email && <p className="text-xs text-muted-foreground">{row.actor_email}</p>}</TableCell>
                        <TableCell><code className="text-xs">{row.action}</code></TableCell>
                        <TableCell className="text-xs">
                          {row.entity_type.replace(/_/g, ' ')}
                          {row.entity_id && (href
                            ? <Link to={href} className="ml-1 font-mono underline" onClick={(e) => e.stopPropagation()}>{String(meta?.order_number ?? row.entity_id).slice(0, 13)}</Link>
                            : <span className="ml-1 font-mono text-muted-foreground">{row.entity_id.slice(0, 8)}</span>)}
                        </TableCell>
                        <TableCell className="max-w-72 truncate text-xs text-muted-foreground">
                          {diff.length ? diff.slice(0, 3).map((d) => d.key).join(', ') + (diff.length > 3 ? ` +${diff.length - 3}` : '') : Object.keys(meta ?? {}).length ? 'details' : '—'}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={5} className="py-3">
                            {diff.length > 0 && (
                              <table className="mb-2 w-full text-xs">
                                <thead><tr className="text-left text-muted-foreground"><th className="w-48 py-1 font-medium">Field</th><th className="py-1 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
                                <tbody>
                                  {diff.map((d) => (
                                    <tr key={d.key} className="align-top">
                                      <td className="py-1 font-mono">{d.key}</td>
                                      <td className="py-1 pr-3 font-mono break-all text-red-700">{show(d.from)}</td>
                                      <td className="py-1 font-mono break-all text-emerald-700">{show(d.to)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {Object.keys(meta ?? {}).length > 0 && <pre className="overflow-x-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">{JSON.stringify(meta, null, 2)}</pre>}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="border-t px-4 py-2">
          <Pagination page={page} pageSize={PAGE_SIZE} total={logs.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />
        </div>
      </Card>
    </div>
  )
}

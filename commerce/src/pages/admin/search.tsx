import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Copy, Loader2, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useDebounce } from '@/hooks/use-debounce'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime } from '@/lib/format'
import { ORDER_STATUS, PAYMENT_STATUS, SHIPMENT_STATUS } from '@/lib/status'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type SearchField, searchOrders } from '@/services/order-search'

const FIELDS: Array<{ key: SearchField; label: string; placeholder: string }> = [
  { key: 'all', label: 'All fields', placeholder: 'Search by invoice, phone, name, courier tracking ID or payment transaction…' },
  { key: 'invoice', label: 'Invoice', placeholder: 'Invoice number, e.g. ISO-10054' },
  { key: 'phone', label: 'Mobile number', placeholder: 'Mobile number, e.g. 01712345678' },
  { key: 'name', label: 'Customer name', placeholder: 'Customer name' },
  { key: 'tracking', label: 'Courier tracking ID', placeholder: 'Tracking or consignment ID' },
  { key: 'transaction', label: 'Payment transaction', placeholder: 'bKash / Nagad transaction ID or payment reference' },
]
const MATCH_LABEL: Record<Exclude<SearchField, 'all'>, string> = {
  invoice: 'Invoice', phone: 'Mobile', name: 'Name', tracking: 'Tracking', transaction: 'Transaction',
}

/** Search orders by any field, like the EcomDrive search page. */
export default function SearchPage() {
  const [state, update] = useUrlState({ field: 'all', q: '' })
  const field = (FIELDS.some((f) => f.key === state.field) ? state.field : 'all') as SearchField
  const term = useDebounce(state.q.trim(), 350)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [field])

  const results = useQuery({
    queryKey: ['order-search', field, term],
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
    queryFn: () => searchOrders(field, term),
  })
  const meta = FIELDS.find((f) => f.key === field)!
  const busy = results.isFetching && term.length >= 2

  return (
    <div className="space-y-4">
      <PageHeader title="Search orders" description="Find any order by invoice, mobile number, customer name, courier tracking ID or payment transaction." />

      <div className="rounded-xl border bg-card">
        <div className="no-scrollbar flex gap-1 overflow-x-auto border-b px-2" role="tablist" aria-label="Search in">
          {FIELDS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={field === f.key} onClick={() => update({ field: f.key })}
              className={cn('relative shrink-0 px-3 py-2.5 text-[13px] transition-colors',
                field === f.key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {f.label}
              {field === f.key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
            </button>
          ))}
        </div>
        <div className="p-3">
          <label className="flex h-11 items-center gap-2.5 rounded-lg border bg-background px-3 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15">
            {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <SearchIcon className="size-4 text-muted-foreground" />}
            <input ref={input} value={state.q} onChange={(e) => update({ q: e.target.value })} placeholder={meta.placeholder}
              inputMode={field === 'phone' ? 'tel' : undefined} aria-label={meta.placeholder}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            {state.q && (
              <button type="button" aria-label="Clear" onClick={() => update({ q: '' })} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
            )}
          </label>
        </div>
      </div>

      {term.length < 2 ? null : results.error ? <ErrorState error={results.error} onRetry={() => results.refetch()} />
        : results.data && results.data.length === 0 ? (
          <EmptyState icon={<SearchIcon />} title="No orders found" description={`Nothing matches “${term}”${field === 'all' ? '' : ` in ${meta.label.toLowerCase()}`}.`} />
        ) : results.data && (
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2.5 text-[13px] text-muted-foreground">
              <span><span className="font-medium text-foreground tabular-nums">{results.data.length}</span> order{results.data.length === 1 ? '' : 's'}{results.data.length === 50 ? ' (first 50)' : ''}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Courier</TableHead>
                  <TableHead>Matched</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.data.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <Link to={`/admin/orders/${o.id}`} className="font-medium hover:underline">{o.order_number}</Link>
                      <p className="text-xs text-muted-foreground">{formatDateTime(o.created_at)}</p>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <p className="truncate font-medium">{o.customer_name}</p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                        {o.customer_phone}
                        <button type="button" aria-label="Copy phone" className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                          onClick={() => { void navigator.clipboard.writeText(o.customer_phone).then(() => toast.success('Phone copied')) }}><Copy className="size-3" /></button>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{[o.shipping_address, o.shipping_district].filter(Boolean).join(', ')}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge value={o.status} map={ORDER_STATUS} />
                        <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} />
                      </div>
                    </TableCell>
                    <TableCell>
                      {o.parcel ? (
                        <div className="space-y-1">
                          <p className="text-[13px]">{o.parcel.courier}</p>
                          {o.parcel.tracking && <p className="font-mono text-xs text-muted-foreground">{o.parcel.tracking}</p>}
                          <StatusBadge value={o.parcel.status} map={SHIPMENT_STATUS} />
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {o.matched.map((m) => (
                          <span key={m.field} className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] text-brand" title={m.value}>{MATCH_LABEL[m.field]}</span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium"><Money value={o.total_amount} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
    </div>
  )
}

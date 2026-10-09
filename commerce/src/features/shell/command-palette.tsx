import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, FileText, Package, Search, ShoppingCart, Truck, User } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAuth } from '@/features/auth/auth-context'
import { useDebounce } from '@/hooks/use-debounce'
import { formatDate, formatMoney } from '@/lib/format'
import { COURIER_INVOICE_STATUS, ORDER_STATUS, SHIPMENT_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { type GlobalSearchResult, globalSearch } from '@/services/search'
import { NAV } from './nav-config'

interface Row {
  key: string
  group: string
  icon: ReactNode
  title: string
  detail?: string
  meta?: string
  to: string
}

const GROUPS = ['Pages', 'Orders', 'Courier', 'Customers', 'Products', 'Invoices'] as const

function rowsFor(r: GlobalSearchResult | undefined): Row[] {
  if (!r) return []
  return [
    ...(r.orders ?? []).map((o) => ({
      key: `o${o.id}`, group: 'Orders', icon: <ShoppingCart />, title: o.order_number,
      detail: `${o.customer_name} · ${o.customer_phone}`,
      meta: `${ORDER_STATUS[o.status]?.label ?? o.status} · ${formatMoney(o.total_amount)}`, to: `/admin/orders/${o.id}`,
    })),
    ...(r.parcels ?? []).map((p) => ({
      key: `p${p.id}`, group: 'Courier', icon: <Truck />, title: p.consignment_id || p.tracking_number || '—',
      detail: `${p.courier} · order ${p.order_number}`, meta: SHIPMENT_STATUS[p.status]?.label ?? p.status, to: `/admin/orders/${p.order_id}`,
    })),
    ...(r.customers ?? []).map((c) => ({
      key: `c${c.id}`, group: 'Customers', icon: <User />, title: c.full_name, detail: c.phone,
      meta: `${c.total_orders} order${c.total_orders === 1 ? '' : 's'}${c.status === 'BLOCKED' ? ' · blocked' : ''}`, to: `/admin/customers/${c.id}`,
    })),
    ...(r.products ?? []).map((p) => ({
      key: `pr${p.id}`, group: 'Products', icon: <Package />, title: p.name, detail: p.sku ?? undefined, meta: p.status.toLowerCase(), to: `/admin/products/${p.id}`,
    })),
    ...(r.invoices ?? []).map((i) => ({
      key: `i${i.id}`, group: 'Invoices', icon: <FileText />, title: i.invoice_number,
      detail: `${i.courier}${i.invoice_date ? ` · ${formatDate(i.invoice_date)}` : ''}`,
      meta: COURIER_INVOICE_STATUS[i.status]?.label ?? i.status, to: '/admin/couriers?tab=statements',
    })),
  ]
}

/**
 * Ctrl+K: one box for orders, phone numbers, consignment / tracking IDs,
 * invoice numbers, customers, products, SKUs — and the admin pages.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const term = useDebounce(q.trim(), 200)

  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  const search = useQuery({
    queryKey: ['global-search', term],
    queryFn: () => globalSearch(term),
    enabled: open && term.length >= 2,
    staleTime: 10_000,
  })

  const pages = useMemo<Row[]>(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    return NAV.flatMap((s) => s.items.flatMap((item) => [
      ...(item.to && (!item.permission || can(item.permission)) ? [{ label: item.label, to: item.to, parent: s.label }] : []),
      ...(item.children ?? []).filter((c) => (!item.permission || can(item.permission)) && (!c.permission || can(c.permission)))
        .map((c) => ({ label: c.label, to: c.to, parent: item.label })),
    ]))
      .filter((p) => p.label.toLowerCase().includes(t))
      .slice(0, 5)
      .map((p) => ({ key: `nav${p.to}`, group: 'Pages', icon: <CornerDownLeft />, title: p.label, detail: p.parent, to: p.to }))
  }, [q, can])

  const rows = useMemo(() => [...pages, ...rowsFor(term === q.trim() ? search.data : undefined)], [pages, search.data, term, q])
  useEffect(() => setCursor(0), [rows.length, term])

  const go = (row: Row | undefined) => {
    if (!row) return
    onOpenChange(false)
    navigate(row.to)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[cursor]) go(rows[cursor])
      else if (q.trim() && can('orders.view')) { onOpenChange(false); navigate(`/admin/orders?q=${encodeURIComponent(q.trim())}`) }
    }
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  let index = -1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Quick search</DialogTitle>
        <DialogDescription className="sr-only">Search orders, customers, products, consignment IDs, invoices and pages</DialogDescription>
        <div className="flex items-center gap-2 border-b px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Order number, phone, consignment ID, invoice, customer, product or SKU"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={rows[cursor] ? `palette-${rows[cursor].key}` : undefined}
          />
          {search.isFetching && <Spinner />}
          <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={listRef} id="palette-results" role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {!q.trim() && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Type at least two characters. Phone numbers work with or without +880.
            </p>
          )}
          {q.trim().length >= 2 && !search.isFetching && term === q.trim() && rows.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing found for “{q.trim()}”.</p>
          )}
          {search.error && <p className="px-3 py-3 text-sm text-red-700">Search failed: {(search.error as Error).message}</p>}
          {GROUPS.map((group) => {
            const items = rows.filter((r) => r.group === group)
            if (!items.length) return null
            return (
              <div key={group} className="mb-1">
                <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{group}</p>
                {items.map((row) => {
                  index += 1
                  const i = index
                  return (
                    <button
                      key={row.key}
                      id={`palette-${row.key}`}
                      data-index={i}
                      type="button"
                      role="option"
                      aria-selected={i === cursor}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => go(row)}
                      className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                        i === cursor && 'bg-accent')}
                    >
                      {row.icon}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{row.title}</span>
                        {row.detail && <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>}
                      </span>
                      {row.meta && <span className="shrink-0 text-xs text-muted-foreground">{row.meta}</span>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="font-sans">↑↓</kbd> move</span>
          <span><kbd className="font-sans">Enter</kbd> open</span>
          {can('orders.view') && <span className="ml-auto">Enter with no match searches all orders</span>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

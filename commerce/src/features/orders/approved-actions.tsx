import { useMutation } from '@tanstack/react-query'
import {
  CheckCheck, ClipboardList, Copy, Download, FileText, ListChecks, MoreVertical, Printer, RefreshCw, Sheet, Tag, Truck, X,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { formatDateTime, timeAgo } from '@/lib/format'
import { STAGE, type OrderStage } from '@/lib/status'
import { cn } from '@/lib/utils'
import { type DuplicateGroup, findDuplicateOrders } from '@/services/orders'
import type { OrderStatus } from '@/types/domain'

const TAG_LIMIT = 30

export type ActionsMenuProps = {
  selected: number
  total: number
  selectingAll: boolean
  onSelectAll: () => void
  onClear: () => void
  can: (p: string) => boolean
  moves: Array<{ to: OrderStatus; label: string }>
  onMove: (to: OrderStatus) => void
  onPrint: (kind: 'invoice' | 'label' | 'picking' | 'sheet') => void
  onBook: () => void
  onRefreshCourier: () => void
  refreshing: boolean
  onTag: () => void
  onExport: () => void
  exporting: boolean
  onDuplicates: () => void
}

const Section = ({ children }: { children: string }) => (
  <DropdownMenuLabel className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</DropdownMenuLabel>
)
const Tile = ({ icon: Icon, label, onSelect, disabled }: { icon: typeof Printer; label: string; onSelect: () => void; disabled?: boolean }) => (
  <DropdownMenuItem onSelect={onSelect} disabled={disabled} className="gap-2 rounded-md">
    <Icon className="size-4 text-muted-foreground" /> {label}
  </DropdownMenuItem>
)

/** One "Actions" menu for Approved Orders: selection, printing, stage moves, courier, tags, export and duplicates. */
export function ApprovedActionsMenu(p: ActionsMenuProps) {
  const none = p.selected === 0
  const moves = p.moves.filter((m) => !['CANCELLED', 'PENDING_CANCEL'].includes(m.to) || p.can('orders.cancel'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <MoreVertical /> Actions
          {p.selected > 0 && <span className="rounded-full bg-foreground px-1.5 text-[11px] text-background tabular-nums">{p.selected}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <div className="flex items-center justify-between rounded-md bg-muted/60 px-2 py-1.5 text-sm">
          <span className="font-medium tabular-nums">{p.selected} selected</span>
          {p.selected > 0 && p.selected >= p.total ? (
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={p.onClear}><X className="size-3.5" /> Clear</button>
          ) : (
            <button type="button" disabled={p.selectingAll || p.total === 0} onClick={p.onSelectAll}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              {p.selectingAll ? <Spinner className="size-3.5" /> : <CheckCheck className="size-3.5" />} Select all {p.total > 0 && `(${p.total})`}
            </button>
          )}
        </div>

        {p.can('orders.fulfill') && (
          <>
            <Section>Print</Section>
            <div className="grid grid-cols-2">
              <Tile icon={FileText} label="Invoice" disabled={none} onSelect={() => p.onPrint('invoice')} />
              <Tile icon={Printer} label="Sticker" disabled={none} onSelect={() => p.onPrint('label')} />
              <Tile icon={ClipboardList} label="Picking" disabled={none} onSelect={() => p.onPrint('picking')} />
              <Tile icon={Sheet} label="Sheet" disabled={none} onSelect={() => p.onPrint('sheet')} />
            </div>
          </>
        )}

        {p.can('orders.status') && moves.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <Section>Update status</Section>
            {moves.map((m) => (
              <DropdownMenuItem key={m.to} disabled={none} onSelect={() => p.onMove(m.to)}
                variant={m.to === 'CANCELLED' || m.to === 'PENDING_CANCEL' ? 'destructive' : 'default'} className="gap-2">
                <ListChecks className="size-4 opacity-70" /> {m.label}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {(p.can('shipments.manage') || p.can('couriers.view')) && (
          <>
            <DropdownMenuSeparator />
            <Section>Courier</Section>
            {p.can('shipments.manage') && <Tile icon={Truck} label="Book courier" disabled={none} onSelect={p.onBook} />}
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); p.onRefreshCourier() }} disabled={p.refreshing} className="gap-2">
              {p.refreshing ? <Spinner className="size-4" /> : <RefreshCw className="size-4 text-muted-foreground" />} Refresh courier status
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />
        <Section>Tools & export</Section>
        <div className="grid grid-cols-2">
          {p.can('orders.update') && <Tile icon={Tag} label="Add tag" disabled={none} onSelect={p.onTag} />}
          {p.can('orders.export') && <Tile icon={Download} label={p.exporting ? 'Exporting…' : p.selected ? `Excel (${p.selected})` : 'Excel'} disabled={p.exporting} onSelect={p.onExport} />}
          <Tile icon={Copy} label="Duplicates" onSelect={p.onDuplicates} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Small dialog to add one tag to the selected orders. */
export function BulkTagDialog({ open, onOpenChange, known, count, onAdd }: {
  open: boolean; onOpenChange: (o: boolean) => void; known: string[]; count: number; onAdd: (tag: string) => void
}) {
  const [text, setText] = useState('')
  const add = (t: string) => { onAdd(t.slice(0, TAG_LIMIT)); setText(''); onOpenChange(false) }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Tag {count} order{count === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>Pick a tag or type a new one.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) add(text.trim()) }} className="flex gap-1.5">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={TAG_LIMIT} placeholder="Tag name" aria-label="Tag name" />
          <Button type="submit" disabled={!text.trim()}>Add</Button>
        </form>
        {known.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {known.map((t) => <button key={t} type="button" onClick={() => add(t)} className="press rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">{t}</button>)}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const DUP_STAGES: Array<{ key: OrderStage; label: string }> = [
  { key: 'PENDING', label: 'Pending' }, { key: 'RTS', label: 'RTS' }, { key: 'SHIPPED', label: 'Shipped' },
  { key: 'PRE_ORDER', label: 'Pre-order' }, { key: 'RETURN_PENDING', label: 'Return pending' }, { key: 'RETURNED', label: 'Returned' },
  { key: 'DELIVERED', label: 'Delivered' },
]

/** Choose the stages to look in, then run the check on the server. */
export function DuplicateCheckDialog({ open, onOpenChange, onResult }: {
  open: boolean; onOpenChange: (o: boolean) => void; onResult: (r: { stages: string[]; groups: DuplicateGroup[]; orders: number }) => void
}) {
  const [stages, setStages] = useState<string[]>(['PENDING', 'RTS', 'SHIPPED'])
  const check = useMutation({
    mutationFn: () => findDuplicateOrders(stages),
    onSuccess: (r) => { onResult({ stages, ...r }); onOpenChange(false) },
  })
  const toggle = (k: string, on: boolean) => setStages((s) => (on ? [...s, k] : s.filter((x) => x !== k)))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Check duplicate orders</DialogTitle>
          <DialogDescription>Finds customers (same phone) with more than one approved order in these stages.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Stages to check</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
            {DUP_STAGES.map((s) => (
              <label key={s.key} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={stages.includes(s.key)} onCheckedChange={(v) => toggle(s.key, v === true)} /> {s.label}
              </label>
            ))}
          </div>
        </div>
        {check.error && <p className="text-sm text-destructive">{(check.error as Error).message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={() => check.mutate()} disabled={!stages.length || check.isPending}>
            {check.isPending ? <Spinner /> : <Copy />} Check duplicates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The result, shown under the search bar: one card per customer, oldest order first. */
export function DuplicatesPanel({ result, onSelect, onClose, onRecheck }: {
  result: { stages: string[]; groups: DuplicateGroup[]; orders: number }
  onSelect: (ids: string[]) => void
  onClose: () => void
  onRecheck: () => void
}) {
  const { groups } = result
  const newer = groups.flatMap((g) => g.orders.slice(1).map((o) => o.id))
  const stageNames = result.stages.map((s) => STAGE[s as OrderStage]?.label ?? s).join(', ')
  return (
    <section className="enter space-y-3 rounded-2xl border bg-card p-3 sm:p-4" aria-label="Duplicate orders">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><Copy className="size-4" /> Duplicate orders</h2>
          <p className="text-xs text-muted-foreground">
            {groups.length
              ? `${groups.length} customer${groups.length === 1 ? '' : 's'} with more than one order · ${result.orders} orders · in ${stageNames}`
              : `No customer has more than one order in ${stageNames}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {groups.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => onSelect(newer)} title="Keeps the first order of each customer unselected">Select newer copies ({newer.length})</Button>
              <Button size="sm" variant="outline" onClick={() => onSelect(groups.flatMap((g) => g.orders.map((o) => o.id)))}>Select all ({result.orders})</Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onRecheck}>Change stages</Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="Close duplicates"><X /></Button>
        </div>
      </div>
      {groups.length > 0 && (
        <div className="grid max-h-[28rem] gap-2 overflow-y-auto pr-1 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g.phone} className={cn('rounded-xl border p-3', g.same_items && 'border-amber-300 bg-amber-50/40 dark:bg-amber-500/5')}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{g.name ?? 'Customer'}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">{g.phone} · {g.count} orders · {timeAgo(g.first_at)} to {timeAgo(g.last_at)}</p>
                </div>
                {g.same_items && <Badge variant="warning" className="shrink-0 text-[10px]">Same product</Badge>}
              </div>
              <ul className="space-y-1.5">
                {g.orders.map((o, i) => (
                  <li key={o.id} className="flex items-start justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs">
                    <div className="min-w-0">
                      <Link to={`/admin/orders/${o.id}`} className="font-medium hover:underline">{o.order_number}</Link>
                      {i === 0 && <span className="ml-1 text-muted-foreground">(first)</span>}
                      <p className="truncate text-muted-foreground" title={o.items ?? ''}>{o.items ?? '—'}</p>
                      <p className="text-muted-foreground">{formatDateTime(o.created_at)}{o.district ? ` · ${o.district}` : ''}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge variant={STAGE[o.stage as OrderStage]?.variant ?? 'neutral'} className="text-[10px]">{STAGE[o.stage as OrderStage]?.label ?? o.stage}</Badge>
                      <p className="mt-0.5"><Money value={o.total} /></p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

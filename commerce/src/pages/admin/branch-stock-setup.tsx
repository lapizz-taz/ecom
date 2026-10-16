import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Save } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useDebounce } from '@/hooks/use-debounce'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type BranchStockRow, branchesOverview, branchStock, setBranchStock, transferStock } from '@/services/branches'

const PAGE = 50

/**
 * Branch Stock Setup: how much each branch holds, per product. The central branch
 * holds whatever the other branches do not, so the store's total never changes here.
 */
export default function BranchStockSetupPage() {
  const { can } = useAuth()
  const edit = can('inventory.adjust')
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const search = useDebounce(q, 300)
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState<Record<string, Record<string, number>>>({})
  const [transfer, setTransfer] = useState<BranchStockRow | null>(null)
  const overview = useQuery({ queryKey: ['branches'], queryFn: branchesOverview })
  const rows = useQuery({ queryKey: ['branch-stock', search, page], placeholderData: keepPreviousData, queryFn: () => branchStock(search, PAGE, (page - 1) * PAGE) })
  const branches = (overview.data?.branches ?? []).filter((b) => b.is_active)
  const central = branches.find((b) => b.is_central)
  const changes = Object.entries(draft).flatMap(([branch, items]) => Object.entries(items).map(([variant, n]) => ({ branch, variant, n })))
  const save = useMutation({
    mutationFn: async () => {
      for (const [branch, items] of Object.entries(draft)) {
        await setBranchStock(branch, Object.entries(items).map(([variant_id, on_hand]) => ({ variant_id, on_hand })))
      }
    },
    onSuccess: () => {
      toast.success('Branch stock saved')
      setDraft({})
      void queryClient.invalidateQueries({ queryKey: ['branch-stock'] })
      void queryClient.invalidateQueries({ queryKey: ['branches'] })
    },
    onError: (e) => toast.error(e),
  })

  if (overview.error || rows.error) return <ErrorState error={overview.error ?? rows.error} onRetry={() => { void overview.refetch(); void rows.refetch() }} />
  if (!overview.data) return <LoadingState />
  if (!overview.data.enabled) return <EmptyState title="Branch stock is off" description="Turn on Multi Warehouse / Branch Stock in Inventory → Branches first." />

  const valueOf = (r: BranchStockRow, branchId: string) => draft[branchId]?.[r.variant_id] ?? r.branches?.[branchId] ?? 0
  const centralOf = (r: BranchStockRow) => r.total - branches.filter((b) => !b.is_central).reduce((s, b) => s + valueOf(r, b.id), 0)
  return (
    <div className="space-y-4">
      <PageHeader title="Branch Stock Setup" description="Set how much each branch holds. What a branch gains comes out of the central branch, and what it gives up goes back to it."
        actions={edit && <Button size="sm" disabled={changes.length === 0 || save.isPending} onClick={() => save.mutate()}><Save /> Save {changes.length > 0 ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : ''}</Button>} />
      <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Product or SKU" className="max-w-sm" />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-medium">Product</th>
                <th className="px-2 text-right font-medium">Total</th>
                {central && <th className="px-2 text-right font-medium">{central.name} <span className="font-normal">(central)</span></th>}
                {branches.filter((b) => !b.is_central).map((b) => <th key={b.id} className="px-2 text-right font-medium whitespace-nowrap">{b.name}</th>)}
                {edit && <th className="px-2" />}
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {(rows.data?.items ?? []).map((r) => {
                const c = centralOf(r)
                return (
                  <tr key={r.variant_id}>
                    <td className="sticky left-0 max-w-64 bg-card px-3 py-2">
                      <p className="truncate font-medium">{r.product}{r.variant ? ` · ${r.variant}` : ''}</p>
                      {r.sku && <p className="font-mono text-[11px] text-muted-foreground">{r.sku}</p>}
                    </td>
                    <td className="px-2 text-right font-medium">{formatNumber(r.total)}</td>
                    {central && <td className={cn('px-2 text-right', c < 0 && 'font-medium text-red-600')}>{formatNumber(c)}</td>}
                    {branches.filter((b) => !b.is_central).map((b) => (
                      <td key={b.id} className="px-2 py-1 text-right">
                        {edit ? (
                          <Input type="number" min={0} className={cn('ml-auto h-8 w-20 text-right', draft[b.id]?.[r.variant_id] !== undefined && 'border-brand')}
                            value={valueOf(r, b.id)} aria-label={`${r.product} at ${b.name}`}
                            onChange={(e) => {
                              const n = Math.max(0, Math.floor(Number(e.target.value) || 0))
                              setDraft((d) => ({ ...d, [b.id]: { ...d[b.id], [r.variant_id]: n } }))
                            }} />
                        ) : formatNumber(valueOf(r, b.id))}
                      </td>
                    ))}
                    {edit && <td className="px-2 text-right"><Button size="icon-sm" variant="ghost" aria-label={`Transfer ${r.product}`} onClick={() => setTransfer(r)}><ArrowLeftRight /></Button></td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {rows.data && rows.data.items.length === 0 && <EmptyState title="No products" />}
        <Pagination page={page} pageSize={PAGE} total={rows.data?.total ?? 0} onPage={setPage} />
      </Card>
      {changes.some((x) => x.n >= 0) && rows.data?.items.some((r) => centralOf(r) < 0) && (
        <p className="text-sm text-red-600">Some products would go below zero at the central branch. Lower the other branches first.</p>
      )}
      {transfer && <TransferDialog row={transfer} branches={branches} onClose={() => setTransfer(null)}
        onDone={() => { void queryClient.invalidateQueries({ queryKey: ['branch-stock'] }); void queryClient.invalidateQueries({ queryKey: ['branches'] }) }} />}
    </div>
  )
}

function TransferDialog({ row, branches, onClose, onDone }: {
  row: BranchStockRow; branches: Array<{ id: string; name: string; is_central: boolean }>; onClose: () => void; onDone: () => void
}) {
  const [from, setFrom] = useState(branches.find((b) => b.is_central)?.id ?? branches[0]?.id ?? '')
  const [to, setTo] = useState(branches.find((b) => !b.is_central)?.id ?? '')
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')
  const move = useMutation({
    mutationFn: () => transferStock(from, to, [{ variant_id: row.variant_id, quantity: qty }], note || undefined),
    onSuccess: () => { toast.success('Stock moved'); onDone(); onClose() },
    onError: (e) => toast.error(e),
  })
  const have = row.branches?.[from] ?? 0
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Move ${row.product}${row.variant ? ` · ${row.variant}` : ''}`} submitLabel="Move" busy={move.isPending}
      onSubmit={() => move.mutate()} description="The store's total stays the same; the move is kept in the branch log.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" hint={`${formatNumber(have)} there`}>
          <Select value={from} onValueChange={setFrom}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent></Select>
        </Field>
        <Field label="To">
          <Select value={to} onValueChange={setTo}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{branches.filter((b) => b.id !== from).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent></Select>
        </Field>
        <Field label="Quantity"><Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /></Field>
        <Field label="Note"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </FormDialog>
  )
}

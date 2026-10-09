import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Palette, Printer } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { normalizeTemplate, pageCss, PAPERS, type PaperId, paperOf } from '@/features/fulfillment/label-template'
import { printInFrame } from '@/features/fulfillment/print-frame'
import { LabelPages, type LabelStore } from '@/features/fulfillment/shipping-label'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatDateTime } from '@/lib/format'
import { labelOrders, markLabelsPrinted } from '@/services/orders'
import { getSettings } from '@/services/settings'

const PAPER_KEY = 'label_paper'

function storedPaper(): PaperId | null {
  try {
    const v = localStorage.getItem(PAPER_KEY)
    return PAPERS.some((p) => p.id === v) ? (v as PaperId) : null
  } catch {
    return null
  }
}

/** Print shipping labels for one or many orders with the Label builder design; every print is recorded. */
export default function LabelsPage() {
  const [params] = useSearchParams()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean), [params])
  const { data: config } = useStoreConfig()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: 60_000 })
  const fulfillment = (settings.data?.fulfillment ?? {}) as Record<string, unknown>
  const saved = useMemo(() => normalizeTemplate(fulfillment.label_template, fulfillment), [fulfillment])
  // A different paper can be picked for this print run (remembered on this computer).
  const [paperId, setPaperId] = useState<PaperId | null>(storedPaper)
  const template = paperId && paperId !== saved.paper ? { ...saved, paper: paperId } : saved
  const paper = paperOf(template)
  const [confirmReprint, setConfirmReprint] = useState(false)
  const pagesRef = useRef<HTMLDivElement>(null)

  const orders = useQuery({ queryKey: ['label-orders', ids], enabled: ids.length > 0, queryFn: () => labelOrders(ids) })
  const printable = (orders.data ?? []).filter((o) => !['CANCELLED', 'REJECTED_FRAUD'].includes(o.status))
  const already = printable.filter((o) => o.label_printed_at)
  const store: LabelStore = {
    name: config?.store.name ?? 'Store', phone: config?.store.phone, address: config?.store.address,
    logoUrl: config?.store.logo_url, siteUrl: config?.store.website_url || window.location.origin,
  }

  const print = useMutation({
    mutationFn: async () => {
      const result = await markLabelsPrinted(printable.map((o) => o.id), template.paper)
      await printInFrame(pagesRef.current?.innerHTML ?? '', pageCss(paper), `Labels ${printable[0]?.order_number ?? ''}`)
      return result
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['label-orders'] })
      void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
      toast.success(`${r.printed + r.reprinted} label(s) sent to the printer${r.reprinted ? ` (${r.reprinted} reprint)` : ''}`)
    },
  })

  const start = () => (already.length ? setConfirmReprint(true) : print.mutate())

  if (!ids.length) return <EmptyState title="No orders selected" description="Select orders in the list and choose Print labels." />
  if (orders.isLoading || settings.isLoading) return <LoadingState label="Preparing labels…" />
  if (orders.error) return <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
  const sheets = paper.sheet ? Math.ceil(printable.length / (paper.sheet.columns * paper.sheet.rows)) : printable.length

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/approved?print=1"><ArrowLeft /> Orders</Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Shipping labels</h1>
          <p className="text-sm text-muted-foreground">
            {printable.length} label{printable.length === 1 ? '' : 's'} on {sheets} {paper.sheet ? 'A4 sheet' : 'label'}{sheets === 1 ? '' : 's'}
            {already.length > 0 && <> · <span className="text-amber-700">{already.length} already printed</span></>}
            {orders.data!.length > printable.length && <> · {orders.data!.length - printable.length} cancelled skipped</>}
          </p>
        </div>
        <Select value={template.paper} onValueChange={(v) => {
          setPaperId(v as PaperId)
          try { localStorage.setItem(PAPER_KEY, v) } catch { /* private mode: not remembered */ }
        }}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PAPERS.map((p) => <SelectItem key={p.id} value={p.id} title={p.hint}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" asChild><Link to="/admin/settings?tab=labels"><Palette /> Edit design</Link></Button>
        <Button size="lg" className="rounded-full" onClick={start} disabled={!printable.length || print.isPending}>
          {print.isPending ? <Spinner /> : <Printer />} Print {printable.length} label{printable.length === 1 ? '' : 's'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        In the print dialog choose your label printer, paper size {paper.sheet ? 'A4' : `${paper.width} × ${paper.height} mm`}, margins “None” and scale 100%.
      </p>

      {already.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {already.map((o) => (
            <Badge key={o.id} variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
              {o.order_number} · printed {o.label_print_count}× · {formatDateTime(o.label_printed_at!)}
            </Badge>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl bg-muted/60 p-6">
        <div ref={pagesRef} className="label-preview mx-auto flex w-fit flex-wrap justify-center gap-6 [&_.label-page]:shadow-md">
          <LabelPages orders={printable} template={template} store={store} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmReprint}
        onOpenChange={setConfirmReprint}
        title={`${already.length} label${already.length === 1 ? ' was' : 's were'} already printed`}
        description="Reprinting is recorded in each order's history. Use it when a label was damaged or lost — make sure the old label is not used on another parcel."
        confirmLabel={`Print all ${printable.length}`}
        onConfirm={() => print.mutateAsync()}
      />
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LABEL_FORMATS, type LabelFormat, pageCss, ShippingLabel } from '@/features/fulfillment/shipping-label'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatDateTime } from '@/lib/format'
import { labelOrders, markLabelsPrinted } from '@/services/orders'
import { getSettings } from '@/services/settings'

const FORMAT_KEY = 'label_format'

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/** Print shipping labels for one or many orders; every print is recorded. */
export default function LabelsPage() {
  const [params] = useSearchParams()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean), [params])
  const { data: config } = useStoreConfig()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: 60_000 })
  const fulfillment = (settings.data?.fulfillment ?? {}) as { label_size?: LabelFormat; show_cod_on_label?: boolean; show_items_on_label?: boolean; label_note?: string }
  const [format, setFormat] = useState<LabelFormat | null>(() => (localStorage.getItem(FORMAT_KEY) as LabelFormat | null))
  const activeFormat: LabelFormat = format ?? fulfillment.label_size ?? '100x150'
  const [confirmReprint, setConfirmReprint] = useState(false)

  const orders = useQuery({ queryKey: ['label-orders', ids], enabled: ids.length > 0, queryFn: () => labelOrders(ids) })
  const printable = (orders.data ?? []).filter((o) => !['CANCELLED', 'REJECTED_FRAUD'].includes(o.status))
  const already = printable.filter((o) => o.label_printed_at)

  const print = useMutation({
    mutationFn: () => markLabelsPrinted(printable.map((o) => o.id), activeFormat),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['label-orders'] })
      void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
      toast.success(`${r.printed + r.reprinted} label(s) sent to the printer${r.reprinted ? ` (${r.reprinted} reprint)` : ''}`)
      // Give the browser a moment to apply the page size before the dialog opens.
      setTimeout(() => window.print(), 50)
    },
  })

  const start = () => (already.length ? setConfirmReprint(true) : print.mutate())
  const options = {
    storeName: config?.store.name ?? 'Store',
    storePhone: config?.store.phone,
    showCod: fulfillment.show_cod_on_label !== false,
    showItems: fulfillment.show_items_on_label !== false,
    note: fulfillment.label_note,
  }

  if (!ids.length) return <EmptyState title="No orders selected" description="Select orders in the list and choose Print labels." />
  if (orders.isLoading) return <LoadingState label="Preparing labels…" />
  if (orders.error) return <ErrorState error={orders.error} onRetry={() => orders.refetch()} />

  return (
    <div className="space-y-5">
      <style>{pageCss(activeFormat)}</style>
      <div className="no-print flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild><Link to="/admin/orders/approved?print=1"><ArrowLeft /> Orders</Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Shipping labels</h1>
          <p className="text-sm text-muted-foreground">
            {printable.length} label{printable.length === 1 ? '' : 's'}
            {already.length > 0 && <> · <span className="text-amber-700">{already.length} already printed</span></>}
            {orders.data!.length > printable.length && <> · {orders.data!.length - printable.length} cancelled skipped</>}
          </p>
        </div>
        <Select value={activeFormat} onValueChange={(v) => { setFormat(v as LabelFormat); localStorage.setItem(FORMAT_KEY, v) }}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {LABEL_FORMATS.map((f) => (
              <SelectItem key={f.value} value={f.value} title={f.hint}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="lg" className="rounded-full" onClick={start} disabled={!printable.length || print.isPending}>
          {print.isPending ? <Spinner /> : <Printer />} Print {printable.length} label{printable.length === 1 ? '' : 's'}
        </Button>
      </div>

      {already.length > 0 && (
        <div className="no-print flex flex-wrap gap-2 text-xs">
          {already.map((o) => (
            <Badge key={o.id} variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
              {o.order_number} · printed {o.label_print_count}× · {formatDateTime(o.label_printed_at!)}
            </Badge>
          ))}
        </div>
      )}

      <div className="label-sheet flex flex-wrap justify-center gap-6 rounded-2xl bg-muted/60 p-6 print:block print:bg-white print:p-0">
        {activeFormat === 'A4'
          ? chunk(printable, 4).map((group, i) => (
            <div key={i} className="shipping-label grid h-[297mm] w-[210mm] grid-cols-2 grid-rows-2 bg-white shadow-sm print:shadow-none">
              {group.map((o) => <ShippingLabel key={o.id} order={o} format="A4" options={options} />)}
            </div>
          ))
          : printable.map((o) => (
            <div key={o.id} className="shipping-label shadow-sm print:shadow-none">
              <ShippingLabel order={o} format={activeFormat} options={options} />
            </div>
          ))}
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

import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toast } from '@/lib/toast'
import { labelOrders, markLabelsPrinted, type LabelOrder } from '@/services/orders'
import { getSettings } from '@/services/settings'
import { type LabelTemplate, measuredHeight, normalizeTemplate, pageCss, PAPERS, type PaperId, paperOf } from './label-template'
import { printInFrame } from './print-frame'
import { LabelPages, type LabelStore } from './shipping-label'

export type PrintKind = 'label' | 'invoice'
const PAPER_KEY = 'label_paper'
/** The most orders printed in one go. */
export const PRINT_LIMIT = 200

/** The label paper picked for a run on this computer (Shipping labels page), if any. */
export function storedPaper(): PaperId | null {
  try {
    const v = localStorage.getItem(PAPER_KEY)
    return PAPERS.some((p) => p.id === v) ? (v as PaperId) : null
  } catch {
    return null
  }
}
export function rememberPaper(id: PaperId) {
  try { localStorage.setItem(PAPER_KEY, id) } catch { /* private mode: not remembered */ }
}

/** The design to print with: the builder's label or invoice, with this computer's label paper when one was picked. */
export function printTemplate(fulfillment: Record<string, unknown>, kind: PrintKind, paperId: PaperId | null): LabelTemplate {
  const saved = kind === 'invoice' ? normalizeTemplate(fulfillment.invoice_template, {}, 'invoice') : normalizeTemplate(fulfillment.label_template, fulfillment)
  return kind === 'label' && paperId && paperId !== saved.paper && PAPERS.some((p) => p.id === paperId && p.id !== 'A4' && p.id !== 'A5')
    ? { ...saved, paper: paperId } : saved
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)))

/** Draws the pages off screen (barcodes need a moment) and returns their HTML and page size. */
async function renderPages(orders: LabelOrder[], template: LabelTemplate, store: LabelStore) {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // Laid out (so tall labels can be measured) but never seen.
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<LabelPages orders={orders} template={template} store={store} />))
    await nextFrame()
    await nextFrame()
    await new Promise((r) => setTimeout(r, 30))
    const paper = paperOf(template)
    return { html: host.innerHTML, css: pageCss(paper, template.grow ? measuredHeight(host, paper) : undefined) }
  } finally {
    root.unmount()
    host.remove()
  }
}

/**
 * Print shipping labels or invoices straight to the browser's print window: no page in between.
 * Labels already printed ask once before they are printed again; every label print is recorded.
 */
export function useDirectPrint() {
  const queryClient = useQueryClient()
  const { data: config } = useStoreConfig()
  const [busy, setBusyState] = useState(false)
  const busyRef = useRef(false)
  const setBusy = (v: boolean) => { busyRef.current = v; setBusyState(v) }
  const [reprint, setReprint] = useState<{ already: number; total: number; go: () => Promise<void> } | null>(null)

  const run = async (allIds: string[], kind: PrintKind, confirmed = false): Promise<void> => {
    const ids = allIds.slice(0, PRINT_LIMIT)
    if (!ids.length || busyRef.current) return
    if (allIds.length > PRINT_LIMIT && !confirmed) toast.info(`Only the first ${PRINT_LIMIT} orders are printed at once`)
    const what = kind === 'invoice' ? 'invoice' : 'label'
    setBusy(true)
    const tid = `direct-print-${kind}`
    toast.loading(`Preparing ${ids.length} ${what}${ids.length === 1 ? '' : 's'}…`, { id: tid })
    try {
      const [orders, settings] = await Promise.all([
        queryClient.fetchQuery({ queryKey: ['label-orders', ids], queryFn: () => labelOrders(ids), staleTime: 0 }),
        queryClient.fetchQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: 60_000 }),
      ])
      const printable = orders.filter((o) => !['CANCELLED', 'REJECTED_FRAUD'].includes(o.status))
      if (!printable.length) {
        toast.warning('Nothing to print: cancelled orders are skipped', { id: tid })
        return
      }
      const already = printable.filter((o) => o.label_printed_at).length
      if (kind === 'label' && already && !confirmed) {
        toast.dismiss(tid)
        setReprint({ already, total: printable.length, go: () => run(allIds, kind, true) })
        return
      }
      const template = printTemplate((settings?.fulfillment ?? {}) as Record<string, unknown>, kind, storedPaper())
      const store: LabelStore = {
        name: config?.store.name ?? 'Store', phone: config?.store.phone, address: config?.store.address,
        logoUrl: config?.store.logo_url, siteUrl: config?.store.website_url || window.location.origin,
      }
      const pages = await renderPages(printable, template, store)
      const recorded = kind === 'label' ? await markLabelsPrinted(printable.map((o) => o.id), template.paper) : null
      toast.dismiss(tid)
      await printInFrame(pages.html, pages.css, `${kind === 'invoice' ? 'Invoices' : 'Labels'} ${printable[0]?.order_number ?? ''}`)
      if (recorded) {
        void queryClient.invalidateQueries({ queryKey: ['orders'] })
        void queryClient.invalidateQueries({ queryKey: ['order'] })
        void queryClient.invalidateQueries({ queryKey: ['label-orders'] })
        void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
      }
    } catch (e) {
      toast.error(e, { id: tid })
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <ConfirmDialog
      open={!!reprint}
      onOpenChange={(o) => { if (!o) setReprint(null) }}
      title={reprint ? `${reprint.already} label${reprint.already === 1 ? ' was' : 's were'} already printed` : ''}
      description="Reprinting is recorded in each order's history. Use it when a label was damaged or lost — make sure the old label is not used on another parcel."
      confirmLabel={reprint ? `Print all ${reprint.total}` : 'Print'}
      onConfirm={async () => { const r = reprint; setReprint(null); await r?.go() }}
    />
  )

  return { print: (ids: string[], kind: PrintKind = 'label') => run(ids, kind), busy, dialog }
}

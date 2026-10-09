import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Barcode as BarcodeIcon, Box, CheckCircle2, Copy, Eye, EyeOff,
  FileText, GripVertical, Image as ImageIcon, LayoutTemplate, Minus, MapPin, Package, Plus, Printer, QrCode as QrIcon, Receipt,
  Redo2, RotateCcw, Save, StickyNote, Store, Table2, Trash2, Truck, Type, Undo2, Wallet, ZoomIn, ZoomOut,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  BLOCK_DEFAULTS, BLOCK_INFO, type BlockId, type LabelBlock, type LabelTemplate, measuredHeight, nextUid, normalizeTemplate, pageCss, PAPERS,
  paperOf, REPEATABLE, STARTERS, starter, type TemplateKind,
} from '@/features/fulfillment/label-template'
import { printInFrame } from '@/features/fulfillment/print-frame'
import { type LabelData, LabelPages, type LabelStore, ShippingLabel } from '@/features/fulfillment/shipping-label'
import { useStoreConfig } from '@/hooks/use-store-config'
import { cn } from '@/lib/utils'
import { latestLabelOrder } from '@/services/orders'
import { useSettingDraft } from './setting-form'

const SAMPLE: LabelData = {
  order_number: 'ISO-10245', created_at: new Date().toISOString(), customer_name: 'Rahim Uddin', customer_phone: '01712345678',
  shipping_address: 'House 12, Road 7, Block C, Mirpur 10 (near the water tank, 3rd floor)', shipping_area: 'Mirpur', shipping_district: 'Dhaka',
  total_amount: 1350, amount_paid: 100, customer_note: 'Please call before coming',
  subtotal: 1350, delivery_charge: 80, delivery_discount: 0, discount_total: 80, delivery_method: 'standard', payment_method: 'COD',
  order_items: [
    { product_name: 'Korean Leather Belt', variant_title: 'Black / 34', sku: 'BELT-BLK-34', quantity: 1, unit_price: 650, line_subtotal: 650 },
    { product_name: 'Canvas Tote Bag', variant_title: null, sku: 'TOTE-01', quantity: 2, unit_price: 350, line_subtotal: 700 },
  ],
  shipments: [{ is_active: true, tracking_number: null, consignment_id: 'DT091025ABC7', couriers: { name: 'Pathao' } }],
} as LabelData

const ICONS: Record<BlockId, ReactNode> = {
  header: <Wallet />, business_header: <Store />, logo: <ImageIcon />, invoice_header: <Receipt />, order_barcode: <BarcodeIcon />,
  recipient: <MapPin />, courier: <Truck />, qr: <QrIcon />, cod_badge: <Wallet />, delivery_method: <Truck />, items: <Package />,
  product_table: <Table2 />, price_summary: <FileText />, note: <StickyNote />, custom_text: <Type />, divider: <Minus />, return_address: <Box />,
}
const SMART: BlockId[] = ['business_header', 'recipient', 'invoice_header', 'product_table', 'price_summary', 'cod_badge', 'courier', 'qr', 'delivery_method', 'note', 'divider', 'logo', 'items', 'header', 'return_address']
const BASIC: Array<{ id: BlockId; label: string }> = [
  { id: 'custom_text', label: 'Text' }, { id: 'logo', label: 'Logo' }, { id: 'order_barcode', label: 'Barcode' },
  { id: 'qr', label: 'QR' }, { id: 'divider', label: 'Line' }, { id: 'product_table', label: 'Products' },
]
const ALIGNABLE: BlockId[] = ['custom_text', 'logo', 'cod_badge', 'delivery_method', 'business_header', 'qr']
const SIZABLE: BlockId[] = ['custom_text', 'logo', 'cod_badge', 'delivery_method']
const KEY: Record<TemplateKind, string> = { label: 'label_template', invoice: 'invoice_template' }
const PX_PER_MM = 96 / 25.4

/**
 * Label & invoice builder: smart blocks on the left, the page on a canvas in
 * the middle (click a block to edit it), and Design / Layers / Review on the
 * right. Undo and redo cover every change until you save.
 */
export function LabelBuilder() {
  const setting = useSettingDraft('fulfillment')
  const { data: config } = useStoreConfig()
  const latest = useQuery({ queryKey: ['label-builder', 'latest'], queryFn: latestLabelOrder, staleTime: 60_000 })
  const [kind, setKind] = useState<TemplateKind>('label')
  const [source, setSource] = useState<'sample' | 'latest'>('sample')
  const [selected, setSelected] = useState<string | null>(null)
  const [panel, setPanel] = useState<'design' | 'layers' | 'review'>('design')
  const [zoom, setZoom] = useState<number | null>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const draft = setting.draft as Record<string, unknown> | undefined
  const server = setting.query.data?.fulfillment as Record<string, unknown> | undefined
  const template = useMemo(() => normalizeTemplate(draft?.[KEY[kind]], kind === 'label' ? draft ?? {} : {}, kind), [draft, kind])
  const savedTemplate = useMemo(() => normalizeTemplate(server?.[KEY[kind]], kind === 'label' ? server ?? {} : {}, kind), [server, kind])
  const dirty = setting.dirty || JSON.stringify(template) !== JSON.stringify(savedTemplate)

  // Undo / redo, one history per template kind.
  const history = useRef<Record<TemplateKind, { undo: LabelTemplate[]; redo: LabelTemplate[] }>>({ label: { undo: [], redo: [] }, invoice: { undo: [], redo: [] } })
  const [, bump] = useState(0)
  const commit = useCallback((next: LabelTemplate) => {
    const h = history.current[kind]
    h.undo.push(template)
    if (h.undo.length > 80) h.undo.shift()
    h.redo = []
    setting.set([KEY[kind]], next)
    bump((n) => n + 1)
  }, [kind, template, setting])
  const step = (dir: 'undo' | 'redo') => {
    const h = history.current[kind]
    const from = dir === 'undo' ? h.undo : h.redo
    const to = dir === 'undo' ? h.redo : h.undo
    const prev = from.pop()
    if (!prev) return
    to.push(template)
    setting.set([KEY[kind]], prev)
    bump((n) => n + 1)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement)?.closest('input, textarea')) return
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); step(e.shiftKey ? 'redo' : 'undo') }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); step('redo') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const update = (patch: Partial<LabelTemplate>) => commit({ ...template, ...patch })
  const setBlock = (uid: string, patch: Partial<LabelBlock>) => update({ blocks: template.blocks.map((b) => (b.uid === uid ? { ...b, ...patch } : b)) })
  const moveBlock = (uid: string, toIndex: number) => {
    const blocks = [...template.blocks]
    const from = blocks.findIndex((b) => b.uid === uid)
    if (from < 0) return
    const [b] = blocks.splice(from, 1)
    blocks.splice(Math.max(0, Math.min(toIndex > from ? toIndex - 1 : toIndex, blocks.length)), 0, b)
    update({ blocks })
  }
  const addBlock = (id: BlockId, beforeUid?: string | null) => {
    const existing = !REPEATABLE.includes(id) ? template.blocks.find((b) => b.id === id) : undefined
    if (existing) {
      // Single blocks: show it (and move it where it was dropped).
      const blocks = template.blocks.map((b) => (b.uid === existing.uid ? { ...b, enabled: true } : b))
      if (beforeUid && beforeUid !== existing.uid) {
        const without = blocks.filter((b) => b.uid !== existing.uid)
        const at = without.findIndex((b) => b.uid === beforeUid)
        without.splice(at < 0 ? without.length : at, 0, { ...existing, enabled: true })
        update({ blocks: without })
      } else update({ blocks })
      setSelected(existing.uid!)
      setPanel('design')
      return
    }
    const block: LabelBlock = { ...BLOCK_DEFAULTS[id], uid: nextUid(template.blocks, id), enabled: true }
    const blocks = [...template.blocks]
    const anchor = beforeUid ?? (selected ? template.blocks[template.blocks.findIndex((b) => b.uid === selected) + 1]?.uid : null)
    const at = anchor ? blocks.findIndex((b) => b.uid === anchor) : -1
    blocks.splice(at < 0 ? blocks.length : at, 0, block)
    update({ blocks })
    setSelected(block.uid!)
    setPanel('design')
  }
  const removeBlock = (uid: string) => {
    const b = template.blocks.find((x) => x.uid === uid)
    if (!b) return
    update({ blocks: REPEATABLE.includes(b.id) ? template.blocks.filter((x) => x.uid !== uid) : template.blocks.map((x) => (x.uid === uid ? { ...x, enabled: false } : x)) })
    setSelected(null)
  }
  const duplicate = (uid: string) => {
    const b = template.blocks.find((x) => x.uid === uid)
    if (!b || !REPEATABLE.includes(b.id)) return
    const copy = { ...b, uid: nextUid(template.blocks, b.id) }
    const blocks = [...template.blocks]
    blocks.splice(blocks.findIndex((x) => x.uid === uid) + 1, 0, copy)
    update({ blocks })
    setSelected(copy.uid)
  }

  const store: LabelStore = {
    name: config?.store.name ?? 'Store', phone: config?.store.phone, address: config?.store.address,
    logoUrl: config?.store.logo_url, siteUrl: config?.store.website_url || window.location.origin,
  }
  const order = source === 'latest' && latest.data ? latest.data : SAMPLE
  const paper = paperOf(template)
  const papers = PAPERS.filter((p) => (kind === 'invoice' ? ['A4', 'A5', '100x150', 'custom'].includes(p.id) : p.id !== 'A4' && p.id !== 'A5'))

  // Fit the page in the canvas, and warn when content is taller than the page.
  const canvasRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(1)
  useEffect(() => {
    const box = canvasRef.current
    if (!box) return
    const calc = () => setFit(Math.min(1.6, (box.clientWidth - 64) / (paper.width * PX_PER_MM), (box.clientHeight - 64) / (Math.min(paper.height, 297) * PX_PER_MM)))
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(box)
    return () => ro.disconnect()
  }, [paper.width, paper.height])
  const scale = zoom ?? Math.max(0.3, fit)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = pageRef.current?.querySelector('.shipping-label') as HTMLElement | null
    if (el) setOverflow(!template.grow && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2))
  })

  const testRef = useRef<HTMLDivElement>(null)
  const printTest = async () => {
    await printInFrame(testRef.current?.innerHTML ?? '', pageCss(paper, template.grow ? measuredHeight(testRef.current, paper) : undefined),
      kind === 'invoice' ? 'Test invoice' : 'Test label')
  }

  if (setting.query.error) return <ErrorState error={setting.query.error} onRetry={() => setting.query.refetch()} />
  if (!draft) return <LoadingState />
  const sel = template.blocks.find((b) => b.uid === selected) ?? null
  const issues = review(template, overflow)
  const canEdit = setting.canEdit
  const h = history.current[kind]

  return (
    <div className="flex min-h-[680px] flex-col overflow-hidden rounded-xl border bg-card lg:h-[calc(100dvh-7.5rem)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center">
          <Button size="icon-sm" variant="ghost" onClick={() => step('undo')} disabled={!h.undo.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 /></Button>
          <Button size="icon-sm" variant="ghost" onClick={() => step('redo')} disabled={!h.redo.length} aria-label="Redo" title="Redo (Ctrl+Y)"><Redo2 /></Button>
        </div>
        <div className="flex rounded-lg border p-0.5" role="tablist">
          {(['label', 'invoice'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setSelected(null) }}
              className={cn('rounded-md px-3 py-1 text-sm transition-all duration-200', kind === k ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {k === 'label' ? 'Sticker label' : 'Invoice'}
            </button>
          ))}
        </div>
        <Select value={template.paper} onValueChange={(v) => update({ paper: v as LabelTemplate['paper'] })} disabled={!canEdit}>
          <SelectTrigger size="sm" className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>{papers.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
        <span className="hidden rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:inline">{paper.sheet ? `${paper.sheet.columns * paper.sheet.rows} per A4` : 'Single page'}</span>
        <div className="flex items-center rounded-lg border">
          <Button size="icon-sm" variant="ghost" onClick={() => setZoom(Math.max(0.3, +(scale - 0.1).toFixed(2)))} aria-label="Zoom out"><ZoomOut /></Button>
          <button type="button" className="w-12 text-center text-xs tabular-nums" onClick={() => setZoom(null)} title="Fit to screen">{Math.round(scale * 100)}%</button>
          <Button size="icon-sm" variant="ghost" onClick={() => setZoom(Math.min(2.5, +(scale + 0.1).toFixed(2)))} aria-label="Zoom in"><ZoomIn /></Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={source} onValueChange={(v) => setSource(v as 'sample' | 'latest')}>
            <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="sample">Sample order</SelectItem><SelectItem value="latest" disabled={!latest.data}>Latest order</SelectItem></SelectContent>
          </Select>
          <Button size="sm" variant={previewMode ? 'default' : 'outline'} onClick={() => setPreviewMode((v) => !v)}>{previewMode ? <EyeOff /> : <Eye />} Preview</Button>
          <Button size="sm" variant="outline" onClick={() => void printTest()}><Printer /> Test print</Button>
          {canEdit && dirty && <Button size="sm" variant="ghost" onClick={() => { setting.reset(); history.current[kind] = { undo: [], redo: [] }; bump((n) => n + 1) }}>Discard</Button>}
          {canEdit && (
            <Button size="sm" onClick={() => setting.save.mutate()} disabled={!dirty || setting.save.isPending}>
              {setting.save.isPending ? <Spinner /> : <Save />} Save
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
        {/* Blocks */}
        <aside className={cn('min-h-0 overflow-y-auto border-b p-3 lg:border-r lg:border-b-0', (!canEdit || previewMode) && 'pointer-events-none opacity-50')}>
          <p className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Smart blocks</p>
          <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
            {SMART.map((id) => {
              const on = template.blocks.some((b) => b.id === id && b.enabled)
              return (
                <button key={id} type="button" draggable onDragStart={(e) => e.dataTransfer.setData('text/block', id)} onClick={() => addBlock(id)}
                  title={BLOCK_INFO[id].description}
                  className={cn('group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-all duration-150 hover:-translate-y-px hover:border-foreground/40 hover:shadow-sm active:translate-y-0 [&_svg]:size-3.5 [&_svg]:shrink-0',
                    on && !REPEATABLE.includes(id) && 'bg-muted/60')}>
                  <span className="text-muted-foreground">{ICONS[id]}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{BLOCK_INFO[id].name}</span>
                  {on && !REPEATABLE.includes(id) ? <CheckCircle2 className="text-muted-foreground" /> : <Plus className="opacity-0 transition-opacity group-hover:opacity-60" />}
                </button>
              )
            })}
          </div>
          <p className="mt-4 mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Basic elements</p>
          <div className="grid grid-cols-3 gap-1.5">
            {BASIC.map((x) => (
              <button key={x.label} type="button" draggable onDragStart={(e) => e.dataTransfer.setData('text/block', x.id)} onClick={() => addBlock(x.id)}
                className="flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] transition-all duration-150 hover:-translate-y-px hover:border-foreground/40 hover:shadow-sm [&_svg]:size-4">
                <span className="text-muted-foreground">{ICONS[x.id]}</span>{x.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-snug text-muted-foreground">Click to add, or drag onto the page.</p>
        </aside>

        {/* Canvas */}
        <div ref={canvasRef} className="relative min-h-[420px] overflow-auto bg-muted/60 bg-[radial-gradient(circle,rgb(0_0_0/0.06)_1px,transparent_1px)] [background-size:16px_16px]"
          onClick={() => setSelected(null)}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('text/block') || e.dataTransfer.types.includes('text/layer')) e.preventDefault() }}
          onDrop={(e) => {
            e.preventDefault()
            const id = e.dataTransfer.getData('text/block') as BlockId
            const layer = e.dataTransfer.getData('text/layer')
            if (id) addBlock(id, dragOver)
            else if (layer) moveBlock(layer, dragOver ? template.blocks.findIndex((b) => b.uid === dragOver) : template.blocks.length)
            setDragOver(null)
          }}>
          <div className="flex min-h-full min-w-fit items-start justify-center p-8">
            <div className="relative">
              <span className="absolute -top-6 left-0 text-[11px] text-muted-foreground tabular-nums">{template.name} · {paper.width} × {paper.height} mm{template.grow ? ' · grows' : ''}</span>
              <div ref={pageRef} style={{ zoom: scale }} className="shadow-[0_1px_3px_rgb(0_0_0/0.15),0_8px_24px_rgb(0_0_0/0.12)] transition-[zoom] duration-200">
                <ShippingLabel order={order} template={template} store={store} paper={paper}
                  wrap={previewMode ? undefined : (b, node) => (
                    <div
                      onClick={(e) => { e.stopPropagation(); setSelected(b.uid!); setPanel('design') }}
                      draggable={canEdit}
                      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/layer', b.uid!) }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(b.uid!) }}
                      onDragLeave={() => setDragOver((d) => (d === b.uid ? null : d))}
                      className={cn('relative cursor-pointer outline-offset-1 transition-[outline-color] duration-150 hover:outline hover:outline-1 hover:outline-dashed hover:outline-black/50',
                        selected === b.uid && 'outline outline-2 outline-solid outline-black hover:outline-2 hover:outline-solid',
                        dragOver === b.uid && 'before:absolute before:inset-x-0 before:-top-[2px] before:h-[3px] before:bg-black before:content-[""]')}>
                      {selected === b.uid && <span className="absolute -top-[14px] left-0 z-10 rounded-t bg-black px-1.5 text-[9px] leading-[14px] font-medium text-white">{BLOCK_INFO[b.id].name}</span>}
                      {node ?? <p className="py-[1mm] text-center text-[0.7em] text-black/40 italic">{BLOCK_INFO[b.id].name} — nothing to show for this order</p>}
                    </div>
                  )} />
              </div>
            </div>
          </div>
          <div ref={testRef} className="hidden"><LabelPages orders={[order]} template={template} store={store} /></div>
        </div>

        {/* Panel */}
        <aside className="flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l">
          <div className="grid grid-cols-3 border-b text-sm">
            {(['design', 'layers', 'review'] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)}
                className={cn('relative py-2.5 capitalize transition-colors', panel === p ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {p}{p === 'review' && issues.some((i) => i.level !== 'ok') && <span className="ml-1 inline-block size-1.5 rounded-full bg-foreground align-middle" />}
                <span className={cn('absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground transition-transform duration-200', panel === p ? 'scale-x-100' : 'scale-x-0')} />
              </button>
            ))}
          </div>
          <div key={panel + (sel?.uid ?? '')} className="min-h-0 flex-1 overflow-y-auto p-4 animate-in fade-in-0 slide-in-from-right-1 duration-200">
            <fieldset disabled={!canEdit} className="grid gap-4">
              {panel === 'design' && (sel ? (
                <BlockPanel block={sel} hasAddress={!!store.address} onChange={(p) => setBlock(sel.uid!, p)} onBack={() => setSelected(null)}
                  onRemove={() => removeBlock(sel.uid!)} onDuplicate={REPEATABLE.includes(sel.id) ? () => duplicate(sel.uid!) : undefined} />
              ) : (
                <DocumentPanel template={template} kind={kind} papers={papers} onChange={update} />
              ))}
              {panel === 'layers' && (
                <Layers template={template} selected={selected} onSelect={(uid) => { setSelected(uid); setPanel('design') }}
                  onToggle={(uid, on) => setBlock(uid, { enabled: on })} onMove={moveBlock} onRemove={removeBlock} />
              )}
              {panel === 'review' && (
                <ul className="grid gap-2">
                  {issues.map((i) => (
                    <li key={i.text} className={cn('flex gap-2 rounded-lg border p-3 text-sm', i.level === 'error' && 'border-foreground')}>
                      {i.level === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
                      <span>{i.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          </div>
        </aside>
      </div>
    </div>
  )
}

function review(t: LabelTemplate, overflow: boolean): Array<{ level: 'ok' | 'warn' | 'error'; text: string }> {
  const on = (id: BlockId) => t.blocks.some((b) => b.id === id && b.enabled)
  const out: Array<{ level: 'ok' | 'warn' | 'error'; text: string }> = []
  if (overflow) out.push({ level: 'warn', text: 'Some content does not fit on the page. Use a smaller text size, fewer products, fewer blocks, a bigger size or “Grow taller”.' })
  if (!on('recipient') && !(on('invoice_header') && t.blocks.find((b) => b.id === 'invoice_header')?.show_customer !== false)) {
    out.push({ level: 'error', text: 'No customer name, phone or address. Add “Customer address” or “Order summary”.' })
  }
  if (t.kind === 'label') {
    if (!on('order_barcode') && !(on('courier') && t.blocks.find((b) => b.id === 'courier')?.show_barcode)) out.push({ level: 'warn', text: 'No barcode — parcels cannot be scanned at the packing desk or by the courier.' })
    if (!on('cod_badge') && !on('price_summary') && !(on('header') && t.blocks.find((b) => b.id === 'header')?.show_cod)) out.push({ level: 'warn', text: 'The amount to collect is not shown. Add the COD badge or price summary.' })
    if (!t.grow && paperOf(t).height < 60 && (on('product_table') || on('price_summary'))) out.push({ level: 'warn', text: 'A product table on a mini label is hard to read.' })
  } else {
    if (!on('product_table') && !on('items')) out.push({ level: 'warn', text: 'The invoice has no product list.' })
    if (!on('price_summary')) out.push({ level: 'warn', text: 'The invoice has no totals. Add “Price summary”.' })
  }
  if (!out.length) out.push({ level: 'ok', text: 'Looks good — everything a courier and customer need is on the page.' })
  return out
}

function DocumentPanel({ template: t, kind, papers, onChange }: { template: LabelTemplate; kind: TemplateKind; papers: typeof PAPERS; onChange: (p: Partial<LabelTemplate>) => void }) {
  const paper = paperOf(t)
  const custom = t.paper === 'custom'
  return (
    <>
      <div className="flex items-center gap-2 text-sm font-semibold"><LayoutTemplate className="size-4 text-muted-foreground" /> Document</div>
      <Field label="Template name" htmlFor="doc-name"><Input id="doc-name" value={t.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} /></Field>
      <Field label="Paper size" hint={paper.hint}>
        <Select value={t.paper} onValueChange={(v) => onChange({ paper: v as LabelTemplate['paper'] })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{papers.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Width (mm)" htmlFor="doc-w"><Input id="doc-w" type="number" min={30} max={297} disabled={!custom} value={custom ? t.custom_width : paper.width} onChange={(e) => onChange({ custom_width: Number(e.target.value) })} /></Field>
        <Field label="Height (mm)" htmlFor="doc-h"><Input id="doc-h" type="number" min={20} max={420} disabled={!custom} value={custom ? t.custom_height : paper.height} onChange={(e) => onChange({ custom_height: Number(e.target.value) })} /></Field>
      </div>
      {!custom && <button type="button" className="-mt-2 text-left text-xs text-muted-foreground underline" onClick={() => onChange({ paper: 'custom', custom_width: paper.width, custom_height: paper.height })}>Use a custom size</button>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Margin (mm)" htmlFor="doc-pad"><Input id="doc-pad" type="number" min={0} max={20} step={0.5} value={t.padding} onChange={(e) => onChange({ padding: Number(e.target.value) })} /></Field>
        <Field label="Text size">
          <Select value={t.text_size} onValueChange={(v) => onChange({ text_size: v as LabelTemplate['text_size'] })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(['S', 'M', 'L', 'XL'] as const).map((s) => <SelectItem key={s} value={s}>{{ S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large' }[s]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      <Toggle label="Grow taller for long orders" hint="The page gets longer instead of cutting the product list (roll printers and invoices)" checked={t.grow} onChange={(v) => onChange({ grow: v })} />
      <Toggle label="Frame around the page" checked={t.border} onChange={(v) => onChange({ border: v })} />
      <div className="grid gap-2 border-t pt-4">
        <p className="text-sm font-medium">Reset to starter layout</p>
        {STARTERS[kind].map((s) => (
          <Button key={s.key} type="button" variant="outline" size="sm" className="justify-start" onClick={() => onChange({ ...starter(kind, s.key) })}><RotateCcw /> {s.name}</Button>
        ))}
      </div>
    </>
  )
}

function Layers({ template, selected, onSelect, onToggle, onMove, onRemove }: {
  template: LabelTemplate; selected: string | null; onSelect: (uid: string) => void; onToggle: (uid: string, on: boolean) => void
  onMove: (uid: string, to: number) => void; onRemove: (uid: string) => void
}) {
  const [over, setOver] = useState<number | null>(null)
  return (
    <ul className="grid gap-1" onDragLeave={() => setOver(null)}>
      {template.blocks.map((b, i) => (
        <li key={b.uid} draggable onDragStart={(e) => e.dataTransfer.setData('text/layer', b.uid!)}
          onDragOver={(e) => { e.preventDefault(); setOver(i) }}
          onDrop={(e) => { e.preventDefault(); const uid = e.dataTransfer.getData('text/layer'); if (uid) onMove(uid, i); setOver(null) }}
          className={cn('group flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm transition-all duration-150',
            selected === b.uid && 'border-foreground', !b.enabled && 'opacity-50', over === i && 'border-t-2 border-t-foreground')}>
          <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground" />
          <span className="text-muted-foreground [&_svg]:size-3.5">{ICONS[b.id]}</span>
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(b.uid!)}>
            {BLOCK_INFO[b.id].name}{b.id === 'custom_text' && b.text ? <span className="text-muted-foreground"> · {b.text}</span> : null}
          </button>
          <Button type="button" size="icon-sm" variant="ghost" className="size-6" onClick={() => onToggle(b.uid!, !b.enabled)} aria-label={b.enabled ? 'Hide' : 'Show'}>{b.enabled ? <Eye /> : <EyeOff />}</Button>
          <Button type="button" size="icon-sm" variant="ghost" className="size-6" onClick={() => onMove(b.uid!, i - 1)} disabled={i === 0} aria-label="Move up"><ArrowUp /></Button>
          <Button type="button" size="icon-sm" variant="ghost" className="size-6" onClick={() => onMove(b.uid!, i + 2)} disabled={i === template.blocks.length - 1} aria-label="Move down"><ArrowDown /></Button>
          {REPEATABLE.includes(b.id) && <Button type="button" size="icon-sm" variant="ghost" className="size-6" onClick={() => onRemove(b.uid!)} aria-label="Remove"><Trash2 /></Button>}
        </li>
      ))}
    </ul>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span><span className="block">{label}</span>{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode; title: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title} aria-label={o.title} onClick={() => onChange(o.value)}
          className={cn('flex flex-1 items-center justify-center rounded-md py-1 text-xs transition-colors [&_svg]:size-3.5', value === o.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function BlockPanel({ block: b, hasAddress, onChange, onBack, onRemove, onDuplicate }: {
  block: LabelBlock; hasAddress: boolean; onChange: (p: Partial<LabelBlock>) => void; onBack: () => void; onRemove: () => void; onDuplicate?: () => void
}) {
  return (
    <>
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border [&_svg]:size-4">{ICONS[b.id]}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{BLOCK_INFO[b.id].name}</p>
          <p className="text-xs text-muted-foreground">{BLOCK_INFO[b.id].description}</p>
        </div>
      </div>
      <Toggle label="Show on the page" checked={b.enabled} onChange={(v) => onChange({ enabled: v })} />
      {ALIGNABLE.includes(b.id) && (
        <Field label="Align">
          <Segmented value={b.align ?? 'left'} onChange={(v) => onChange({ align: v })} options={[
            { value: 'left', label: <AlignLeft />, title: 'Left' }, { value: 'center', label: <AlignCenter />, title: 'Centre' }, { value: 'right', label: <AlignRight />, title: 'Right' },
          ]} />
        </Field>
      )}
      {SIZABLE.includes(b.id) && (
        <Field label="Size">
          <Segmented value={b.size ?? 'M'} onChange={(v) => onChange({ size: v })} options={[
            { value: 'S', label: 'S', title: 'Small' }, { value: 'M', label: 'M', title: 'Medium' }, { value: 'L', label: 'L', title: 'Large' },
          ]} />
        </Field>
      )}
      <BlockOptions block={b} onChange={onChange} hasAddress={hasAddress} />
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>Document settings</Button>
        {onDuplicate && <Button type="button" size="sm" variant="outline" onClick={onDuplicate}><Copy /> Duplicate</Button>}
        <Button type="button" size="sm" variant="outline" onClick={onRemove}><Trash2 /> {onDuplicate ? 'Remove' : 'Hide'}</Button>
      </div>
    </>
  )
}

function BlockOptions({ block: b, onChange, hasAddress }: { block: LabelBlock; onChange: (p: Partial<LabelBlock>) => void; hasAddress: boolean }) {
  switch (b.id) {
    case 'header':
      return (
        <>
          <Toggle label="Logo (from Store settings)" checked={!!b.show_logo} onChange={(v) => onChange({ show_logo: v })} />
          <Toggle label="Shop phone" checked={!!b.show_phone} onChange={(v) => onChange({ show_phone: v })} />
          <Toggle label="Amount to collect (COD)" checked={!!b.show_cod} onChange={(v) => onChange({ show_cod: v })} />
        </>
      )
    case 'business_header':
      return (
        <>
          <Toggle label="Logo (from Store settings)" checked={!!b.show_logo} onChange={(v) => onChange({ show_logo: v })} />
          <Toggle label="Shop phone" checked={!!b.show_phone} onChange={(v) => onChange({ show_phone: v })} />
        </>
      )
    case 'invoice_header':
      return (
        <>
          <Toggle label="Invoice date" checked={!!b.show_date} onChange={(v) => onChange({ show_date: v })} />
          <Toggle label="Customer name, address and phone" checked={b.show_customer !== false} onChange={(v) => onChange({ show_customer: v })} />
        </>
      )
    case 'order_barcode':
      return (
        <>
          <Toggle label="Order date" checked={!!b.show_date} onChange={(v) => onChange({ show_date: v })} />
          <Field label="Barcode height">
            <Segmented value={b.barcode_height ?? 'M'} onChange={(v) => onChange({ barcode_height: v })} options={[
              { value: 'S', label: 'Short', title: 'Short' }, { value: 'M', label: 'Medium', title: 'Medium' }, { value: 'L', label: 'Tall', title: 'Tall' },
            ]} />
          </Field>
        </>
      )
    case 'recipient':
      return <Toggle label="District in large letters" checked={!!b.big_district} onChange={(v) => onChange({ big_district: v })} />
    case 'courier':
      return <Toggle label="Consignment barcode (not on mini labels)" checked={!!b.show_barcode} onChange={(v) => onChange({ show_barcode: v })} />
    case 'qr':
      return (
        <>
          <Field label="The QR code opens">
            <Select value={b.qr_content ?? 'tracking'} onValueChange={(v) => onChange({ qr_content: v as LabelBlock['qr_content'] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tracking">Consignment / tracking ID</SelectItem>
                <SelectItem value="order">Order number</SelectItem>
                <SelectItem value="track_page">Your order-tracking page</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Toggle label="Next to the address" checked={!!b.qr_beside_address} onChange={(v) => onChange({ qr_beside_address: v })} />
        </>
      )
    case 'items':
    case 'product_table':
      return (
        <>
          <Field label="Most products listed" htmlFor="lb-max" hint={b.id === 'product_table' ? 'All products show when “Grow taller” is on' : undefined}>
            <Input id="lb-max" type="number" min={1} max={50} value={b.max_items ?? 4} onChange={(e) => onChange({ max_items: Number(e.target.value) || 1 })} />
          </Field>
          <Toggle label="SKU" checked={!!b.show_sku} onChange={(v) => onChange({ show_sku: v })} />
        </>
      )
    case 'price_summary':
      return <Toggle label="Advance paid line" checked={b.show_advance !== false} onChange={(v) => onChange({ show_advance: v })} />
    case 'note':
      return (
        <Field label="Footer note (on every page)" htmlFor="lb-note" hint="The customer's own note is printed too.">
          <Input id="lb-note" value={b.text ?? ''} maxLength={120} onChange={(e) => onChange({ text: e.target.value })} placeholder="e.g. Please call before delivery" />
        </Field>
      )
    case 'custom_text':
      return (
        <>
          <Field label="Text" htmlFor="lb-text"><Input id="lb-text" value={b.text ?? ''} maxLength={120} onChange={(e) => onChange({ text: e.target.value })} /></Field>
          <Toggle label="Bold capitals in a box" checked={!!b.bold} onChange={(v) => onChange({ bold: v })} />
        </>
      )
    case 'divider':
      return <Toggle label="Dashed line" checked={!!b.dashed} onChange={(v) => onChange({ dashed: v })} />
    case 'return_address':
      return <p className="text-xs text-muted-foreground">{hasAddress ? 'Uses the address in Store settings.' : 'Add your address in Settings → Store first.'}</p>
    case 'logo':
      return <p className="text-xs text-muted-foreground">Uses the logo from Store settings; the shop name shows when there is none.</p>
    default:
      return null
  }
}

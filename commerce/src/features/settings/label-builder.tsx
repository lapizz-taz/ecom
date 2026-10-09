import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, Printer, RotateCcw, Save } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  BLOCK_INFO, DEFAULT_TEMPLATE, type LabelBlock, type LabelTemplate, normalizeTemplate, pageCss, PAPERS, paperOf,
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
  total_amount: 1350, amount_paid: 0, customer_note: 'Please call before coming',
  order_items: [
    { product_name: 'Korean Leather Belt', variant_title: 'Black / 34', sku: 'BELT-BLK-34', quantity: 1 },
    { product_name: 'Canvas Tote Bag', variant_title: null, sku: 'TOTE-01', quantity: 2 },
  ],
  shipments: [{ is_active: true, tracking_number: null, consignment_id: 'DT091025ABC7', couriers: { name: 'Pathao' } }],
} as LabelData

/** Shopify-style editor for the shipping label: paper, blocks, order and text size, with a live preview. */
export function LabelBuilder() {
  const setting = useSettingDraft('fulfillment')
  const { data: config } = useStoreConfig()
  const latest = useQuery({ queryKey: ['label-builder', 'latest'], queryFn: latestLabelOrder, staleTime: 60_000 })
  const [source, setSource] = useState<'sample' | 'latest'>('sample')
  const [open, setOpen] = useState<string | null>(null)
  const draft = setting.draft as Record<string, unknown> | undefined
  const template = useMemo(() => normalizeTemplate(draft?.label_template, draft ?? {}), [draft])
  const savedTemplate = useMemo(() => normalizeTemplate(setting.query.data?.fulfillment?.label_template, setting.query.data?.fulfillment ?? {}),
    [setting.query.data])
  const dirty = JSON.stringify(template) !== JSON.stringify(savedTemplate) || setting.dirty
  const update = (patch: Partial<LabelTemplate>) => setting.set(['label_template'], { ...template, ...patch })
  const setBlock = (id: string, patch: Partial<LabelBlock>) =>
    update({ blocks: template.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) })
  const move = (i: number, by: number) => {
    const blocks = [...template.blocks]
    const j = i + by
    if (j < 0 || j >= blocks.length) return
    ;[blocks[i], blocks[j]] = [blocks[j], blocks[i]]
    update({ blocks })
  }

  const store: LabelStore = {
    name: config?.store.name ?? 'Store', phone: config?.store.phone, address: config?.store.address,
    logoUrl: config?.store.logo_url, siteUrl: config?.store.website_url || window.location.origin,
  }
  const order = source === 'latest' && latest.data ? latest.data : SAMPLE
  const paper = paperOf(template)

  // Warn when the content is taller than the label.
  const previewRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = previewRef.current?.querySelector('.shipping-label') as HTMLElement | null
    if (el) setOverflow(el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
  })
  // Fit the preview in the column.
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const fit = () => {
      const pxPerMm = 96 / 25.4
      setScale(Math.min(1, (box.clientWidth - 32) / (paper.width * pxPerMm)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [paper.width])

  const printTest = async () => {
    const holder = document.createElement('div')
    holder.innerHTML = previewRef.current?.querySelector('.test-pages')?.innerHTML ?? ''
    await printInFrame(holder.innerHTML, pageCss(paper), 'Test label')
  }

  if (setting.query.error) return <ErrorState error={setting.query.error} onRetry={() => setting.query.refetch()} />
  if (!draft) return <LoadingState />

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Label builder</CardTitle>
          <CardDescription>Choose the paper, what goes on the label and in what order. Every label you print uses this design.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!setting.canEdit || setting.save.isPending} className="grid min-w-0 grid-cols-1 gap-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              <Field label="Paper" htmlFor="lb-paper" hint={paper.hint}>
                <Select value={template.paper} onValueChange={(v) => update({ paper: v as LabelTemplate['paper'] })}>
                  <SelectTrigger id="lb-paper" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{PAPERS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Text size">
                <Tabs value={template.text_size} onValueChange={(v) => update({ text_size: v as LabelTemplate['text_size'] })}>
                  <TabsList className="w-full">
                    {(['S', 'M', 'L', 'XL'] as const).map((s) => <TabsTrigger key={s} value={s} className="flex-1">{s}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
              </Field>
              {template.paper === 'custom' && (
                <>
                  <Field label="Width (mm)" htmlFor="lb-w"><Input id="lb-w" type="number" min={30} max={210} value={template.custom_width} onChange={(e) => update({ custom_width: Number(e.target.value) })} /></Field>
                  <Field label="Height (mm)" htmlFor="lb-h"><Input id="lb-h" type="number" min={20} max={297} value={template.custom_height} onChange={(e) => update({ custom_height: Number(e.target.value) })} /></Field>
                </>
              )}
              <Field label="Margin inside the label (mm)" htmlFor="lb-pad" hint="Thermal printers can't print the last 2–3 mm at the edge.">
                <Input id="lb-pad" type="number" min={0} max={12} step={0.5} value={template.padding} onChange={(e) => update({ padding: Number(e.target.value) })} />
              </Field>
              <label className="flex items-center justify-between gap-3 self-end rounded-lg border px-3 py-2.5">
                <span className="text-sm">Frame around the label</span>
                <Switch checked={template.border} onCheckedChange={(v) => update({ border: v })} />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <p className="text-sm font-medium">Blocks <span className="font-normal text-muted-foreground">— top to bottom; the customer block fills the space left</span></p>
              <ul className="grid grid-cols-1 gap-2">
                {template.blocks.map((b, i) => (
                  <li key={b.id} className={cn('rounded-lg border', !b.enabled && 'bg-muted/40')}>
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Switch checked={b.enabled} onCheckedChange={(v) => setBlock(b.id, { enabled: v })} aria-label={`Show ${BLOCK_INFO[b.id].name}`} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === b.id ? null : b.id)}>
                        <span className={cn('block text-sm font-medium', !b.enabled && 'text-muted-foreground')}>{BLOCK_INFO[b.id].name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{BLOCK_INFO[b.id].description}</span>
                      </button>
                      {hasOptions(b) && (
                        <Button type="button" size="icon-sm" variant="ghost" onClick={() => setOpen(open === b.id ? null : b.id)} aria-label="Options">
                          <ChevronDown className={cn('transition-transform', open === b.id && 'rotate-180')} />
                        </Button>
                      )}
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp /></Button>
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === template.blocks.length - 1} aria-label="Move down"><ArrowDown /></Button>
                    </div>
                    {open === b.id && hasOptions(b) && (
                      <div className="grid grid-cols-1 gap-3 border-t px-3 py-3 sm:grid-cols-2 [&>*]:min-w-0">
                        <BlockOptions block={b} onChange={(patch) => setBlock(b.id, patch)} hasAddress={!!store.address} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </fieldset>
        </CardContent>
        {setting.canEdit && (
          <CardFooter className="flex flex-wrap items-center justify-end gap-2 border-t">
            <Button variant="ghost" size="sm" onClick={() => setting.set(['label_template'], DEFAULT_TEMPLATE)} disabled={setting.save.isPending}><RotateCcw /> Default design</Button>
            {setting.dirty && <Button variant="ghost" size="sm" onClick={setting.reset} disabled={setting.save.isPending}>Discard</Button>}
            <Button size="sm" onClick={() => setting.save.mutate()} disabled={!dirty || setting.save.isPending}>
              {setting.save.isPending ? <Spinner /> : <Save />} Save design
            </Button>
          </CardFooter>
        )}
      </Card>

      <Card className="min-w-0 xl:sticky xl:top-20">
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
          <CardDescription>{paper.width} × {paper.height} mm{paper.sheet ? ` · ${paper.sheet.columns * paper.sheet.rows} per A4 sheet` : ''} · actual size when printed</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={source} onValueChange={(v) => setSource(v as 'sample' | 'latest')}>
              <TabsList>
                <TabsTrigger value="sample">Sample order</TabsTrigger>
                <TabsTrigger value="latest" disabled={!latest.data}>Latest order</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void printTest()}><Printer /> Print a test label</Button>
          </div>
          {overflow && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Some content doesn't fit on this label. Use a smaller text size, fewer products, fewer blocks or a bigger label.
            </p>
          )}
          <div ref={boxRef} className="flex justify-center overflow-hidden rounded-xl bg-muted/60 p-4">
            <div ref={previewRef} style={{ zoom: scale }}>
              <div className="shadow-md"><ShippingLabel order={order} template={template} store={store} paper={paper} /></div>
              <div className="test-pages hidden"><LabelPages orders={[order]} template={template} store={store} /></div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function hasOptions(_b: LabelBlock) {
  return true
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
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
    case 'order_barcode':
      return (
        <>
          <Toggle label="Order date" checked={!!b.show_date} onChange={(v) => onChange({ show_date: v })} />
          <Field label="Barcode height">
            <Select value={b.barcode_height ?? 'M'} onValueChange={(v) => onChange({ barcode_height: v as LabelBlock['barcode_height'] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="S">Short</SelectItem><SelectItem value="M">Medium</SelectItem><SelectItem value="L">Tall</SelectItem></SelectContent>
            </Select>
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
      return (
        <>
          <Field label="Most products listed" htmlFor="lb-max"><Input id="lb-max" type="number" min={1} max={20} value={b.max_items ?? 4} onChange={(e) => onChange({ max_items: Number(e.target.value) || 1 })} /></Field>
          <Toggle label="SKU" checked={!!b.show_sku} onChange={(v) => onChange({ show_sku: v })} />
        </>
      )
    case 'note':
      return (
        <Field label="Footer note (on every label)" htmlFor="lb-note" className="sm:col-span-2" hint="The customer's own note is printed too.">
          <Input id="lb-note" value={b.text ?? ''} maxLength={120} onChange={(e) => onChange({ text: e.target.value })} placeholder="e.g. Please call before delivery" />
        </Field>
      )
    case 'custom_text':
      return (
        <>
          <Field label="Text" htmlFor="lb-text"><Input id="lb-text" value={b.text ?? ''} maxLength={80} onChange={(e) => onChange({ text: e.target.value })} /></Field>
          <Toggle label="Bold capitals in a box" checked={!!b.bold} onChange={(v) => onChange({ bold: v })} />
        </>
      )
    case 'return_address':
      return <p className="text-xs text-muted-foreground">{hasAddress ? 'Uses the address in Store settings.' : 'Add your address in Settings → Store first.'}</p>
  }
}

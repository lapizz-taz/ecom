import { Check, ClipboardPaste, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { type PastedOrder, parseOrderText } from '@/lib/order-paste'
import { cn } from '@/lib/utils'

const FIELDS: Array<{ key: keyof PastedOrder; label: string }> = [
  { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'district', label: 'District' },
  { key: 'area', label: 'Area' }, { key: 'address', label: 'Address' },
]

/** One box for the whole message: paste it and the order form fills itself. */
export function SmartPaste({ districts, onFill, initial }: { districts: readonly string[]; onFill: (order: PastedOrder) => void; initial?: string }) {
  const [text, setText] = useState(initial ?? '')
  const [found, setFound] = useState<PastedOrder | null>(null)
  const run = (value: string) => {
    const order = parseOrderText(value, districts.length ? districts : undefined)
    setFound(order)
    if (Object.keys(order).length) onFill(order)
  }
  // Text handed over (a chat's messages): read it once the districts are known.
  const ranInitial = useRef(false)
  useEffect(() => {
    if (!initial || ranInitial.current || !districts.length) return
    ranInitial.current = true
    run(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, districts])
  const pasteFromClipboard = async () => {
    try {
      const value = await navigator.clipboard.readText()
      if (value) { setText(value); run(value) }
    } catch { /* the browser asked for permission and it was refused: paste into the box instead */ }
  }

  return (
    <div className="rounded-xl border border-dashed bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-brand" /> Smart paste</p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={pasteFromClipboard}><ClipboardPaste /> Paste</Button>
          {text && <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="Clear" onClick={() => { setText(''); setFound(null) }}><X /></Button>}
        </div>
      </div>
      <Textarea rows={3} value={text} aria-label="Paste the customer's message"
        placeholder={'Paste the whole message — e.g.\nRahim Uddin, 01712-345678\nHouse 12, Road 5, Mirpur 10, Dhaka'}
        className="resize-y bg-card text-[13px]"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { const value = e.clipboardData.getData('text'); if (value) { e.preventDefault(); setText(value); run(value) } }} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {found ? FIELDS.map((f) => (
          <span key={f.key} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
            found[f.key] ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'text-muted-foreground')}>
            {found[f.key] ? <Check className="size-3" /> : <X className="size-3" />} {f.label}
          </span>
        )) : <span className="text-[11px] text-muted-foreground">Name, phone, address, district and area are filled in for you. Check them before creating the order.</span>}
        {text && !found && <Button type="button" size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => run(text)}>Fill the form</Button>}
        {found && <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => run(text)}>Fill again</Button>}
      </div>
    </div>
  )
}

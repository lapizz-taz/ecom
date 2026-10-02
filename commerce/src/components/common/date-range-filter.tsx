import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { type DateRange, RANGE_PRESETS, type RangePreset, rangeFor } from '@/lib/dates'

export function DateRangeFilter({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  const preset = RANGE_PRESETS.find((p) => {
    const r = rangeFor(p.key)
    return r.from === value.from && r.to === value.to
  })?.key
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={preset ?? 'custom'} onValueChange={(v) => v !== 'custom' && onChange(rangeFor(v as RangePreset))}>
        <SelectTrigger className="w-40" size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      <Input type="date" className="h-8 w-36" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} aria-label="From date" />
      <span className="text-muted-foreground">–</span>
      <Input type="date" className="h-8 w-36" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} aria-label="To date" />
    </div>
  )
}

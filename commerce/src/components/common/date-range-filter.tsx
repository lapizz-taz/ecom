import { DateRangePicker } from '@/components/ui/date-picker'
import type { DateRange } from '@/lib/dates'

/** The report date filter: quick ranges plus a calendar for any range. */
export function DateRangeFilter({ value, onChange, align = 'start' }: { value: DateRange; onChange: (range: DateRange) => void; align?: 'start' | 'end' }) {
  return <DateRangePicker value={value} onChange={onChange} align={align} max={undefined} />
}

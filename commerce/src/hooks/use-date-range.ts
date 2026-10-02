import { useMemo } from 'react'
import { type DateRange, type RangePreset, rangeFor } from '@/lib/dates'
import { useUrlState } from './use-url-state'

/** A date range kept in the URL (?from=&to=) so report views can be shared and bookmarked. */
export function useDateRange(preset: RangePreset = '30d') {
  const defaults = useMemo(() => rangeFor(preset), [preset])
  const [state, update] = useUrlState(defaults as { from: string; to: string })
  const valid = /^\d{4}-\d{2}-\d{2}$/
  const range: DateRange = {
    from: valid.test(state.from) ? state.from : defaults.from,
    to: valid.test(state.to) ? state.to : defaults.to,
  }
  const setRange = (next: DateRange) => update({ from: next.from, to: next.to })
  return [range, setRange] as const
}

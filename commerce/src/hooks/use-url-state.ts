import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

/** Keeps list filters / pagination in the URL so views are shareable. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams()
  const state = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
  ) as T

  const update = useCallback(
    (patch: Partial<T>, opts: { resetPage?: boolean } = { resetPage: true }) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === '' || value === defaults[key]) next.delete(key)
          else next.set(key, String(value))
        }
        if (opts.resetPage && !('page' in patch)) next.delete('page')
        return next
      }, { replace: true })
    },
    [setParams, defaults],
  )

  return [state, update] as const
}

import { useCallback, useEffect, useState } from 'react'

/** Widget order and which are hidden, remembered per person in this browser. */
export interface DashboardLayout {
  order: string[]
  hidden: string[]
}

function load(key: string, defaults: string[]): DashboardLayout {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { order: defaults, hidden: [] }
    const saved = JSON.parse(raw) as Partial<DashboardLayout>
    const known = new Set(defaults)
    const order = (saved.order ?? []).filter((id) => known.has(id))
    // Widgets added in a later version go to the end.
    for (const id of defaults) if (!order.includes(id)) order.push(id)
    return { order, hidden: (saved.hidden ?? []).filter((id) => known.has(id)) }
  } catch {
    return { order: defaults, hidden: [] }
  }
}

export function useDashboardLayout(userId: string | undefined, defaults: string[]) {
  const key = `dashboard-layout:${userId ?? 'anon'}`
  const [layout, setLayout] = useState<DashboardLayout>(() => load(key, defaults))
  useEffect(() => setLayout(load(key, defaults)), [key])

  const save = useCallback((next: DashboardLayout) => {
    setLayout(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Private mode: the layout lasts for this visit only.
    }
  }, [key])

  return {
    layout,
    move: (id: string, to: number) => {
      const order = layout.order.filter((x) => x !== id)
      order.splice(Math.max(0, Math.min(to, order.length)), 0, id)
      save({ ...layout, order })
    },
    toggle: (id: string) => save({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] }),
    reset: () => save({ order: defaults, hidden: [] }),
  }
}

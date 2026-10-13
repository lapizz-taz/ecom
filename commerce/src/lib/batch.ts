/**
 * Collects calls for a short window and hands them over in one go. Realtime sends one event per
 * changed row, so a bulk approval or a courier status sync of 200 orders would otherwise refetch
 * every open order list 200 times and pop 200 toasts. The first call starts the window; later
 * calls join it; `flush` gets everything collected, in order.
 */
export function batcher<T>(flush: (items: T[]) => void, windowMs = 600) {
  let items: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    timer = null
    const batch = items
    items = []
    if (batch.length) flush(batch)
  }
  return {
    push(item: T) {
      items.push(item)
      timer ??= setTimeout(run, windowMs)
    },
    /** Drop anything pending (on unmount). */
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      items = []
    },
  }
}

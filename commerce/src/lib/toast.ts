import { gooeyToast, type GooeyToastOptions } from 'goey-toast'
import type { ReactNode } from 'react'

/**
 * App-wide notifications (goey-toast, built on Sonner). Errors stay on screen
 * longer and can be closed; nothing is shown as success unless the call
 * succeeded.
 */
type Options = { description?: ReactNode; id?: string | number; duration?: number; action?: { label: string; onClick: () => void } }

const opts = (o?: Options, extra: Partial<GooeyToastOptions> = {}): GooeyToastOptions => ({
  ...extra,
  ...(o?.description !== undefined ? { description: o.description } : {}),
  ...(o?.id !== undefined ? { id: o.id } : {}),
  ...(o?.duration !== undefined ? { duration: o.duration } : {}),
  ...(o?.action ? { action: { label: o.action.label, onClick: o.action.onClick } } : {}),
})

const text = (v: unknown) => (typeof v === 'string' ? v : v instanceof Error ? v.message : String(v ?? ''))

export const toast = {
  success: (title: string, o?: Options) => gooeyToast.success(title, opts(o, { preset: 'smooth' })),
  error: (title: unknown, o?: Options) => gooeyToast.error(text(title) || 'Something went wrong', opts(o, { preset: 'snappy', duration: o?.duration ?? 7000 })),
  warning: (title: string, o?: Options) => gooeyToast.warning(title, opts(o, { duration: o?.duration ?? 6000 })),
  info: (title: string, o?: Options) => gooeyToast.info(title, opts(o)),
  dismiss: gooeyToast.dismiss,
}

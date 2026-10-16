import { AlertTriangle, Check, Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * App-wide notifications (Sonner): a tinted card with the tone's icon in a solid square,
 * the message, and a close button. Errors stay on screen longer; nothing is shown as
 * success unless the call succeeded.
 */
type Options = { description?: ReactNode; id?: string | number; duration?: number; action?: { label: string; onClick: () => void } }
type Tone = 'success' | 'error' | 'warning' | 'info'

const TONES: Record<Tone, { icon: ReactNode; card: string; box: string; text: string; rule: string }> = {
  success: {
    icon: <Check className="size-4" strokeWidth={3} />,
    card: 'border-green-300/70 bg-green-50 dark:border-green-800/70 dark:bg-green-950/80',
    box: 'bg-green-600', text: 'text-green-800 dark:text-green-200', rule: 'bg-green-300 dark:bg-green-800',
  },
  error: {
    icon: <X className="size-4" strokeWidth={3} />,
    card: 'border-red-300/70 bg-red-50 dark:border-red-800/70 dark:bg-red-950/80',
    box: 'bg-red-600', text: 'text-red-700 dark:text-red-200', rule: 'bg-red-300 dark:bg-red-800',
  },
  warning: {
    icon: <AlertTriangle className="size-4" strokeWidth={2.5} />,
    card: 'border-amber-300/80 bg-amber-50 dark:border-amber-800/70 dark:bg-amber-950/80',
    box: 'bg-amber-500', text: 'text-amber-800 dark:text-amber-200', rule: 'bg-amber-300 dark:bg-amber-800',
  },
  info: {
    icon: <Info className="size-4" strokeWidth={2.5} />,
    card: 'border-blue-300/70 bg-blue-50 dark:border-blue-800/70 dark:bg-blue-950/80',
    box: 'bg-blue-600', text: 'text-blue-800 dark:text-blue-200', rule: 'bg-blue-300 dark:bg-blue-800',
  },
}

function ToastCard({ id, tone, title, o }: { id: string | number; tone: Tone; title: string; o?: Options }) {
  const t = TONES[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex w-[min(24rem,calc(100vw-2rem))] items-center gap-3 rounded-xl border p-2.5 pr-2 font-sans shadow-lg shadow-black/5', t.card)}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm', t.box)}>{t.icon}</span>
      <div className={cn('min-w-0 flex-1 py-0.5', t.text)}>
        <p className="text-sm leading-snug font-medium break-words">{title}</p>
        {o?.description !== undefined && <div className="mt-0.5 text-xs leading-snug opacity-80">{o.description}</div>}
        {o?.action && (
          <button type="button" onClick={() => { o.action!.onClick(); sonner.dismiss(id) }}
            className="mt-1.5 text-xs font-semibold underline underline-offset-2 hover:opacity-80">{o.action.label}</button>
        )}
      </div>
      <span className={cn('h-7 w-px shrink-0', t.rule)} aria-hidden />
      <button type="button" onClick={() => sonner.dismiss(id)} aria-label="Close"
        className={cn('flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10', t.text)}>
        <X className="size-4" />
      </button>
    </div>
  )
}

const text = (v: unknown) => (typeof v === 'string' ? v : v instanceof Error ? v.message : String(v ?? ''))

function show(tone: Tone, title: string, o: Options | undefined, duration: number) {
  return sonner.custom((id) => <ToastCard id={id} tone={tone} title={title} o={o} />, {
    duration: o?.duration ?? duration,
    ...(o?.id !== undefined ? { id: o.id } : {}),
  })
}

export const toast = {
  success: (title: string, o?: Options) => show('success', title, o, 4000),
  error: (title: unknown, o?: Options) => show('error', text(title) || 'Something went wrong', o, 7000),
  warning: (title: string, o?: Options) => show('warning', title, o, 6000),
  info: (title: string, o?: Options) => show('info', title, o, 4500),
  dismiss: (id?: string | number) => sonner.dismiss(id),
}

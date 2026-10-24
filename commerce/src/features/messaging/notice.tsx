import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { ReactNode } from 'react'

/** One line at the top of the Email and WhatsApp pages: on, off, or what is missing. */
export function Notice({ tone, text, action }: { tone: 'ok' | 'warn'; text: string; action?: ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : AlertCircle
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm ${tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  )
}

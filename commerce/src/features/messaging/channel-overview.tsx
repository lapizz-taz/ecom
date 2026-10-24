import { Check, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatNumber, timeAgo } from '@/lib/format'
import type { ChannelStats } from '@/services/messaging'

export interface SetupStep {
  title: string
  text: ReactNode
  /** null: something to check outside Fullfilio (Meta's payment method); not counted. */
  done: boolean | null
  optional?: boolean
  action?: ReactNode
}

/**
 * What is left before the channel sends (top of the Email and WhatsApp pages, until everything is done):
 * each step with what it is and the button that does it.
 */
export function SetupChecklist({ title, steps }: { title: string; steps: SetupStep[] }) {
  const counted = steps.filter((s) => s.done !== null)
  const done = counted.filter((s) => s.done).length
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/40 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground tabular-nums">{done} of {counted.length} done</p>
        </div>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={done}>
          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${(done / Math.max(counted.length, 1)) * 100}%` }} />
        </div>
      </header>
      <ol className="divide-y">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap sm:items-center">
            <StepMark done={s.done} n={i + 1} />
            <div className="min-w-0 flex-1 basis-48">
              <p className={`text-sm font-medium ${s.done ? 'text-muted-foreground' : ''}`}>
                {s.title}{s.optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">optional</span>}
              </p>
              <p className="text-xs text-muted-foreground">{s.text}</p>
            </div>
            {!s.done && s.action && <div className="ml-9 shrink-0 sm:ml-0">{s.action}</div>}
          </li>
        ))}
      </ol>
    </section>
  )
}

function StepMark({ done, n }: { done: boolean | null; n: number }) {
  if (done) {
    return <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white sm:mt-0"><Check className="size-3.5" strokeWidth={3} /></span>
  }
  if (done === null) {
    return <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground sm:mt-0"><Info className="size-3.5" /></span>
  }
  return <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums text-muted-foreground sm:mt-0">{n}</span>
}

export interface Figure { label: string; value: number | null; hint?: string; tone?: 'ok' | 'bad' }

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}% of sent` : undefined)

/** The channel's figures for the last days, as one strip (six figures: 2, 3 or 6 to a row). */
export function ChannelNumbers({ stats, loading, figures }: { stats?: ChannelStats; loading: boolean; figures: (s: ChannelStats) => Figure[] }) {
  const empty: ChannelStats = {
    days: 30, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, waiting: 0, last_sent_at: null, by_event: {}, by_sms: 0,
    confirmed: 0, cancelled: 0, unsubscribed: 0, tested: false,
  }
  const s = stats ?? empty
  return (
    <section aria-label={`Last ${s.days} days`} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="text-sm font-semibold">Last {s.days} days</h2>
        <span className="text-xs text-muted-foreground">
          {loading ? 'Counting…' : s.last_sent_at ? `Last sent ${timeAgo(s.last_sent_at)}` : 'Nothing sent yet'}
          {!loading && s.waiting > 0 && ` · ${formatNumber(s.waiting)} waiting to go`}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {figures(s).map((f) => (
          <div key={f.label} className="bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{f.label}</dt>
            <dd className={`mt-0.5 text-xl font-semibold tabular-nums tracking-tight ${loading ? 'text-muted-foreground/50'
              : f.tone === 'bad' && f.value ? 'text-red-600 dark:text-red-400' : f.tone === 'ok' && f.value ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
              {loading || f.value === null ? '—' : formatNumber(f.value)}
            </dd>
            <dd className="h-4 text-xs text-muted-foreground">{!loading && f.hint}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export const EMAIL_FIGURES = (s: ChannelStats): Figure[] => [
  { label: 'Sent', value: s.sent },
  { label: 'Failed', value: s.failed, tone: 'bad', hint: s.failed ? 'See Activity' : undefined },
  { label: 'Not sent', value: s.skipped, hint: 'No address or unsubscribed' },
  { label: 'Confirmed by customers', value: s.confirmed, tone: 'ok', hint: 'From the email’s button' },
  { label: 'Cancelled by customers', value: s.cancelled },
  { label: 'Unsubscribed', value: s.unsubscribed, hint: 'From offer emails only' },
]

export const WHATSAPP_FIGURES = (s: ChannelStats): Figure[] => [
  { label: 'Sent', value: s.sent },
  { label: 'Delivered', value: s.delivered, hint: share(s.delivered, s.sent) },
  { label: 'Read', value: s.read, hint: share(s.read, s.sent) },
  { label: 'Failed', value: s.failed, tone: 'bad', hint: s.failed ? 'See Activity' : undefined },
  { label: 'Confirmed by customers', value: s.confirmed, tone: 'ok', hint: 'Tapped Confirm' },
  { label: 'Sent by SMS instead', value: s.by_sms, hint: 'WhatsApp could not deliver' },
]

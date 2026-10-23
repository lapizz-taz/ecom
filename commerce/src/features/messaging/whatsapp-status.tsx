import { Badge, type BadgeVariant } from '@/components/ui/badge'
import type { CustomerMessage } from '@/services/messaging'

const META: Record<string, { label: string; variant: BadgeVariant; hint: string }> = {
  APPROVED: { label: 'Approved', variant: 'success', hint: 'Meta approved it: it goes out automatically when switched on.' },
  PENDING: { label: 'In review', variant: 'warning', hint: 'Meta is reviewing it (minutes to a day). Press Refresh from Meta to check.' },
  IN_APPEAL: { label: 'In review', variant: 'warning', hint: 'Meta is looking at it again.' },
  REJECTED: { label: 'Rejected', variant: 'danger', hint: 'Meta said no: change the text and submit it again.' },
  PAUSED: { label: 'Paused by Meta', variant: 'danger', hint: 'Customers reported or blocked it; Meta paused it for a while.' },
  DISABLED: { label: 'Disabled by Meta', variant: 'danger', hint: 'Meta switched it off after poor feedback: write a new text.' },
  DELETED: { label: 'Not at Meta', variant: 'danger', hint: 'The template is no longer at Meta: submit it again.' },
}

/** Where a WhatsApp message stands with Meta, as the editor and the list show it. */
export function whatsappState(m: Pick<CustomerMessage, 'wa_status' | 'wa_body' | 'template' | 'wa_reason'>) {
  const meta = m.wa_status ? META[m.wa_status] ?? { label: m.wa_status.toLowerCase(), variant: 'neutral' as const, hint: '' } : null
  const edited = !!m.wa_body && m.wa_body.trim() !== m.template.trim()
  return {
    submitted: !!meta,
    approved: m.wa_status === 'APPROVED',
    edited,
    label: meta?.label ?? 'Not submitted',
    variant: meta?.variant ?? ('neutral' as BadgeVariant),
    hint: meta ? `${meta.hint}${m.wa_reason ? ` ${m.wa_reason}` : ''}` : 'Submit it to Meta for approval before it can go out automatically.',
  }
}

export function WhatsappStatusBadge({ message }: { message: Pick<CustomerMessage, 'wa_status' | 'wa_body' | 'template' | 'wa_reason'> }) {
  const s = whatsappState(message)
  return (
    <span className="flex items-center gap-1.5">
      {s.edited && <Badge variant="info" title="The text changed after it went to Meta: submit it again to use the new text.">Edited</Badge>}
      <Badge variant={s.variant} title={s.hint}>{s.label}</Badge>
    </span>
  )
}

import { useMutation } from '@tanstack/react-query'
import { ChevronDown, Copy, MessageCircle, Phone } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { usePhone } from '@/features/voicedrive/phone-context'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { recordCallTap } from '@/services/calls'

/** Copies text; when the browser refuses, says so and shows the number so it can be typed. */
export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.warning(`Copying is blocked in this browser: ${text}`)
  }
}

/**
 * The customer's phone number as plain text, always shown in full. Tapping it opens one small menu: call (Cloud
 * Calling when it is on, else the phone's dialer), WhatsApp, and copy the number. Every call tap
 * is recorded for call tracking, as before. Clicks never open the order behind it.
 */
export function PhoneMenu({ orderId, phone, name, kind, className }: {
  orderId: string
  phone: string
  name: string
  kind: 'APPROVED_ORDER' | 'WEB_ORDER'
  className?: string
}) {
  const { canCall, dial } = usePhone()
  const call = useMutation({ mutationFn: () => dial({ phone, orderId, kind }), onError: (e) => toast.error((e as Error).message) })
  const wa = waNumber(phone)
  const source = kind === 'WEB_ORDER' ? 'web orders' : 'approved orders'
  if (!phone) return <span className="text-muted-foreground">No phone</span>
  return (
    // The table row and the phone list row open the order on click; nothing in here should.
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Phone ${phone}: call, WhatsApp or copy`} title="Call, WhatsApp or copy"
            className={cn('inline-flex shrink-0 items-center gap-0.5 font-medium whitespace-nowrap text-foreground tabular-nums underline-offset-4',
              'hover:text-sky-700 hover:underline data-[state=open]:text-sky-700 data-[state=open]:underline', call.isPending && 'animate-pulse', className)}>
            {phone}
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel className="space-y-0.5">
            <span className="block truncate text-xs font-normal text-muted-foreground">{name}</span>
            <span className="block text-base font-semibold tabular-nums">{phone}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {canCall ? (
            <DropdownMenuItem disabled={call.isPending} onSelect={() => { recordCallTap(orderId, source); call.mutate() }}>
              <Phone className="text-sky-600" /> Call with Cloud Calling
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem asChild>
              <a href={`tel:${phone}`} onClick={() => recordCallTap(orderId, source)}><Phone className="text-sky-600" /> Call</a>
            </DropdownMenuItem>
          )}
          {wa && (
            <DropdownMenuItem asChild>
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><MessageCircle className="text-emerald-600" /> WhatsApp</a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copyText(phone, 'Number')}>
            <Copy /> Copy number
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

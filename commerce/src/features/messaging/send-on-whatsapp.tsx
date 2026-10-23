import { useQuery } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { orderWhatsappMessages, whatsappLink } from '@/services/messaging'

/**
 * "Send on WhatsApp" on an order: opens WhatsApp (app or web) on the staff member's own phone or
 * computer with one of the store's messages written for this order. Staff press send themselves,
 * so no Meta approval is needed.
 */
export function SendOnWhatsapp({ orderId, phone, size = 'sm', iconOnly = false }: {
  orderId: string
  phone: string
  size?: 'sm' | 'icon' | 'icon-sm'
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wa = waNumber(phone)
  const messages = useQuery({ queryKey: ['order-whatsapp-messages', orderId], queryFn: () => orderWhatsappMessages(orderId), enabled: open && !!wa, staleTime: 30_000 })
  if (!wa) return null
  const go = (text: string) => window.open(text ? whatsappLink(wa, text) : `https://wa.me/${wa}`, '_blank', 'noopener,noreferrer')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={iconOnly ? 'ghost' : 'outline'} aria-label="Send on WhatsApp">
          <MessageCircle />{!iconOnly && ' WhatsApp'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Opens WhatsApp with the message written</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => go('')}>Open chat</DropdownMenuItem>
        <DropdownMenuSeparator />
        {messages.isLoading ? (
          <div className="flex justify-center py-3"><Spinner /></div>
        ) : messages.error ? (
          <p className="px-2 py-2 text-xs text-red-600">Could not load the messages.</p>
        ) : (
          (messages.data?.messages ?? []).map((m) => (
            <DropdownMenuItem key={m.event} onSelect={() => go(m.text)} title={m.text}>
              <span className="truncate">{m.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

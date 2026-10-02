import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/format'
import type { PublicOrder } from '@/types/domain'

/** wa.me wants the number in international format without + or spaces. */
export function waNumber(raw: string, countryCode = '880'): string | null {
  let d = raw.replace(/\D/g, '')
  if (!d) return null
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = `${countryCode}${d.slice(1)}`
  return d.length >= 10 ? d : null
}

export function orderConfirmationMessage(storeName: string, order: PublicOrder, phone: string): string {
  const lines = [
    `Hello ${storeName}, I've just placed an order. Please confirm it.`,
    `Order: ${order.order_number}`,
    `Name: ${order.customer_name}`,
    `Phone: ${phone}`,
    `Total: ${formatMoney(order.total_amount)}`,
    order.amount_due_now > 0 ? `Pay now: ${formatMoney(order.amount_due_now)}` : null,
    order.cod_amount > 0 ? `Due on delivery: ${formatMoney(order.cod_amount)}` : null,
    `Delivery to: ${[order.shipping_area, order.shipping_district].filter(Boolean).join(', ')}`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** One tap opens WhatsApp with the order details typed in, so the store can confirm it. */
export function WhatsAppConfirm({ storeName, whatsapp, order, phone }: { storeName: string; whatsapp?: string; order: PublicOrder; phone: string }) {
  const number = whatsapp ? waNumber(whatsapp) : null
  if (!number) return null
  const href = `https://wa.me/${number}?text=${encodeURIComponent(orderConfirmationMessage(storeName, order, phone))}`
  return (
    <div className="space-y-2 text-center">
      <Button asChild size="lg" className="h-12 w-full rounded-xl bg-[#25d366] text-base text-[#06291a] hover:bg-[#22c25e]">
        <a href={href} target="_blank" rel="noreferrer"><MessageCircle /> Confirm my order on WhatsApp</a>
      </Button>
      <p className="text-xs text-muted-foreground">One tap sends your order details to {storeName} on WhatsApp so we can confirm it faster.</p>
    </div>
  )
}

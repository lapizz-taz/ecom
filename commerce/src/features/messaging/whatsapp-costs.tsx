import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { whatsappMonthEvents } from '@/services/messaging'
import {
  estimateCost, pricePerMessage, RATE_CARD_URL, RATES_FROM, TAKA_PER_USD, taka, whatsappCategory, type WhatsappCategory, WHATSAPP_RATES,
} from './whatsapp-cost'

const ROWS: Array<{ category: WhatsappCategory | 'FREE'; title: string; messages: string }> = [
  { category: 'UTILITY', title: 'Order updates (Utility)', messages: 'Order confirmation, approved, shipped, out for delivery, courier could not reach you, delivered, payments, cancelled, returns' },
  { category: 'MARKETING', title: 'Marketing', messages: 'Abandoned cart reminder, review request' },
  { category: 'FREE', title: 'Free', messages: 'Your replies within 24 hours after the customer writes to you, and order updates sent in that time (like the short reply after a customer taps Confirm)' },
]

const STEPS = [
  <>Add a payment method (a card) in <span className="font-medium text-foreground">Meta Business Suite → Settings → WhatsApp accounts → Payment settings</span>. Meta needs it before it delivers paid messages.</>,
  <>Submit your messages here. Meta reviews them for free, usually within minutes.</>,
  <>When an order reaches a step, its message goes out. Meta charges a message only when it is <span className="font-medium text-foreground">delivered</span>: one that fails or never arrives costs nothing.</>,
  <>Meta bills your card, not Fullfilio. Every charge is listed in <span className="font-medium text-foreground">WhatsApp Manager → Insights</span>.</>,
]

/** What WhatsApp messages cost, how Meta starts charging, and this month's estimate. */
export function WhatsappCosts() {
  const month = useQuery({ queryKey: ['whatsapp-month-events'], queryFn: whatsappMonthEvents, staleTime: 60_000 })
  const usage: Record<WhatsappCategory, number> = { UTILITY: 0, MARKETING: 0 }
  for (const e of month.data ?? []) usage[whatsappCategory(e)] += 1

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What WhatsApp costs</CardTitle>
        <CardDescription>Meta charges your WhatsApp Business account for each message it delivers. Fullfilio adds no charge.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="px-3 py-2 font-medium">Type</th><th className="hidden px-3 py-2 font-medium sm:table-cell">Your messages</th><th className="px-3 py-2 text-right font-medium">Per message</th></tr>
            </thead>
            <tbody className="divide-y">
              {ROWS.map((r) => (
                <tr key={r.category} className="align-top">
                  <td className="px-3 py-2.5">
                    <span className="block font-medium">{r.title}</span>
                    <span className="block text-xs text-muted-foreground sm:hidden">{r.messages}</span>
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-muted-foreground sm:table-cell">{r.messages}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {r.category === 'FREE' ? <span className="font-medium text-emerald-700 dark:text-emerald-400">Free</span> : (
                      <>
                        <span className="block font-medium">about {pricePerMessage(r.category)}</span>
                        <span className="block text-xs text-muted-foreground">${WHATSAPP_RATES[r.category]}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">How charging starts</h4>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground">
            {STEPS.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>

        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
          <span className="font-medium">This month so far: </span>
          {month.isLoading ? <span className="text-muted-foreground">counting…</span> : (
            <span className="text-muted-foreground tabular-nums">
              {usage.UTILITY} order update{usage.UTILITY === 1 ? '' : 's'} and {usage.MARKETING} marketing message{usage.MARKETING === 1 ? '' : 's'} delivered:
              {' '}<span className="font-medium text-foreground">at most about {taka(estimateCost(usage))}</span>.
              {' '}Messages sent inside a free 24-hour window are counted too, so Meta’s bill is the same or lower.
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Meta’s prices for Bangladesh numbers from {RATES_FROM}, in taka at about ৳{TAKA_PER_USD} per US dollar. Meta changes its prices from time to time:{' '}
          <a href={RATE_CARD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline">Meta’s price list <ExternalLink className="size-3" /></a>
        </p>
      </CardContent>
    </Card>
  )
}

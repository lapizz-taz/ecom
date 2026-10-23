// What Meta charges for WhatsApp messages, as the WhatsApp page shows it. Meta bills the store's
// WhatsApp Business account directly; Fullfilio adds nothing. Meta's rate card is the authority.
import { EVENT_INFO, type MessageEvent } from './shared'

/** Meta's price per delivered message for Bangladesh numbers (USD), from 1 October 2026. */
export const WHATSAPP_RATES = { UTILITY: 0.0043, MARKETING: 0.0841 } as const
export type WhatsappCategory = keyof typeof WHATSAPP_RATES
/** Taka per US dollar for the estimates (Meta bills in the account's currency). */
export const TAKA_PER_USD = 122
export const RATES_FROM = '1 Oct 2026'
export const RATE_CARD_URL = 'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing'

/** Cart reminders and review requests are Marketing under Meta's rules; order updates are Utility. */
export const whatsappCategory = (event: string): WhatsappCategory =>
  EVENT_INFO[event as MessageEvent]?.group === 'Marketing' ? 'MARKETING' : 'UTILITY'

/** "৳0.52", "৳10", "৳1,250" */
export function taka(usd: number): string {
  const v = usd * TAKA_PER_USD
  return `৳${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 })}`
}

export const pricePerMessage = (category: WhatsappCategory) => taka(WHATSAPP_RATES[category])

/** The most this month's delivered messages can cost (some may have been free inside a chat window). */
export const estimateCost = (usage: Record<WhatsappCategory, number>) =>
  usage.UTILITY * WHATSAPP_RATES.UTILITY + usage.MARKETING * WHATSAPP_RATES.MARKETING

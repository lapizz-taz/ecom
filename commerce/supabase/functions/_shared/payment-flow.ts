import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchNotificationsInBackground } from './dispatch.ts'
import type { PaymentProvider, VerifiedPayment } from './payments/types.ts'
import { rpc } from './supabase.ts'

/**
 * Records a provider-verified payment. confirm_payment() is idempotent per
 * (provider, event id), so retries and duplicate webhooks are harmless.
 */
export async function recordVerifiedPayment(
  admin: SupabaseClient,
  provider: string,
  verified: VerifiedPayment,
): Promise<{ status: string; orderNumber: string | null }> {
  const { data: payment } = await admin
    .from('payments')
    .select('currency, orders(order_number)')
    .eq('reference', verified.reference)
    .eq('provider', provider)
    .maybeSingle()
  const orderNumber = (payment?.orders as { order_number?: string } | null)?.order_number ?? null
  if (!payment) return { status: 'unknown_payment', orderNumber: null }

  // A different currency is never accepted as payment of the order amount.
  const amount = verified.currency && verified.currency !== payment.currency ? null : verified.amount

  const result = await rpc<{ status: string }>(admin, 'confirm_payment', {
    p_reference: verified.reference,
    p_provider: provider,
    p_provider_transaction_id: verified.providerTransactionId,
    p_amount: amount,
    p_event_id: verified.eventId,
    p_event_type: verified.eventType,
    p_payload: { raw: verified.raw, reason: verified.reason ?? null },
    p_success: verified.success,
  })
  if (result.status === 'succeeded' || result.status === 'failed') dispatchNotificationsInBackground()
  return { status: result.status, orderNumber }
}

export async function formOrQuery(req: Request): Promise<Record<string, string>> {
  const url = new URL(req.url)
  const params: Record<string, string> = Object.fromEntries(url.searchParams.entries())
  if (req.method === 'POST') {
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await req.formData()
      for (const [key, value] of form.entries()) if (typeof value === 'string') params[key] = value
    } else if (type.includes('application/json')) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      for (const [key, value] of Object.entries(body)) if (value !== null && value !== undefined) params[key] = String(value)
    }
  }
  return params
}

export interface PendingGatewayPayment {
  id: string
  provider: string
  reference: string
  sessions: string[]
  age_minutes: number
}

/**
 * Asks the gateway about each attempt of a pending payment (newest first).
 * A confirmed attempt is recorded; if every attempt has definitely failed the
 * payment is marked failed; otherwise it stays pending for the next run.
 */
export async function reconcilePayment(
  admin: SupabaseClient,
  provider: PaymentProvider,
  payment: PendingGatewayPayment,
): Promise<{ status: string; orderNumber: string | null }> {
  if (!provider.reconcile) return { status: 'unsupported', orderNumber: null }
  const sessions = payment.sessions.length ? [...payment.sessions].reverse() : [payment.reference]
  let lastFailure: VerifiedPayment | null = null
  let waiting = false
  for (const session of sessions) {
    const verified = await provider.reconcile(session, payment.reference, payment.age_minutes)
    if (!verified) {
      waiting = true
      continue
    }
    if (verified.success) return recordVerifiedPayment(admin, payment.provider, { ...verified, reference: payment.reference })
    lastFailure = verified
  }
  if (waiting || !lastFailure) return { status: 'pending', orderNumber: null }
  return recordVerifiedPayment(admin, payment.provider, { ...lastFailure, reference: payment.reference })
}

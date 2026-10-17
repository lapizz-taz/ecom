// Payments merchants make to the platform (subscription invoices, credit
// packages) go to the platform's own gateway accounts, saved from the Super
// Admin panel. They never use a merchant's gateway account.
import type { SupabaseClient } from '@supabase/supabase-js'
import { appBase } from './storefront.ts'
import { functionsBase } from './env.ts'
import { HttpError } from './http.ts'
import { type Gateway, gatewayFromCredentials, gatewaySandbox } from './payments/registry.ts'
import { logEvent } from './monitoring.ts'
import { redactGatewayAnswer } from './payments/redact.ts'
import type { PaymentProvider, VerifiedPayment } from './payments/types.ts'
import { adminClient, rpc } from './supabase.ts'

export const PLATFORM_GATEWAYS = ['bkash', 'paystation'] as const
export const platformGatewaySecret = (code: Gateway) => `gateway.${code}`

interface GatewaySettings { enabled?: boolean; connected?: boolean; sandbox?: boolean }

/**
 * The platform's gateway. Uses a client without a merchant, so the bKash
 * token is the platform's (shared by every merchant's payment), not a merchant's.
 */
export async function platformGateway(code: Gateway, opts: { allowDisabled?: boolean; credentials?: Record<string, string>; sandbox?: boolean } = {}): Promise<PaymentProvider> {
  const platform = adminClient()
  const { data: settings, error } = await platform.rpc('platform_billing_gateways_config')
  if (error) throw new HttpError(500, `Could not read the payment settings: ${error.message}`, 'SETTINGS_READ_FAILED')
  const config = ((settings ?? {}) as Record<string, GatewaySettings>)[code] ?? {}
  if (!opts.credentials && !config.enabled && !opts.allowDisabled) throw new HttpError(422, 'This payment method is not available', 'PROVIDER_DISABLED')
  let creds = opts.credentials ?? null
  if (!creds) {
    const { data, error: secretError } = await platform.rpc('platform_secret_get', { p_key: platformGatewaySecret(code) })
    if (secretError) throw new HttpError(500, `Could not load the ${code} account: ${secretError.message}`, 'SECRET_READ_FAILED')
    creds = (data as Record<string, string> | null) ?? null
    if (!creds) throw new HttpError(503, 'Online payment is not set up yet', 'PROVIDER_NOT_CONFIGURED')
  }
  return gatewayFromCredentials(code, { enabled: true, sandbox: opts.sandbox ?? gatewaySandbox(code, config.sandbox) }, creds, platform)
}

/** Where the admin app lives, for returning merchants after a payment. */
export function panelBase(req?: Request): string {
  return appBase(req)
}

/** The billing function's own address (gateway returns and IPNs). */
export function billingCallbackBase(): string {
  return `${functionsBase()}/billing`
}

/** Where a check came from, for the payment's check log. */
export type CheckSource = 'RETURN' | 'IPN' | 'RECONCILE' | 'RECHECK'

export interface ConfirmResult { status: string; invoice_id?: string; kind?: string; purpose?: string; payment_status?: string }

/** What is stored with a check: the outcome, the gateway's own status word, and its answer without phone numbers or tokens. */
export function checkPayload(verified: VerifiedPayment, source: CheckSource): Record<string, unknown> {
  const outcome = verified.success ? 'succeeded'
    : /cancel/i.test(verified.eventType) ? 'cancelled'
    : /initiated|expired/i.test(verified.eventType) ? 'expired'
    : 'failed'
  return {
    source, outcome, currency: verified.currency, gateway_status: verified.eventType.split('.').pop() ?? null,
    raw: redactGatewayAnswer(verified.raw), event: verified.eventId, reason: verified.reason ?? null,
  }
}

/**
 * Records what the gateway confirmed for a platform payment. The database
 * checks the amount, currency and transaction and applies the payment once.
 */
export async function confirmBillingPayment(merchantId: string, provider: string, reference: string, verified: VerifiedPayment, source: CheckSource): Promise<ConfirmResult> {
  if (verified.reference && verified.reference !== reference) {
    void logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'billing', message: `${provider} confirmed a different payment than the one returned`,
      context: { expected: reference, reported: verified.reference }, merchantId })
    await rpc(adminClient(merchantId), 'billing_payment_check_log', {
      p_reference: reference, p_provider: provider, p_source: source, p_outcome: 'reference_mismatch', p_gateway_status: null,
      p_detail: { reported_reference: verified.reference },
    }).catch(() => undefined)
    return { status: 'reference_mismatch' }
  }
  return rpc<ConfirmResult>(adminClient(merchantId), 'billing_gateway_confirm', {
    p_reference: reference, p_provider: provider, p_txn: verified.providerTransactionId, p_amount: verified.amount,
    p_success: verified.success, p_payload: checkPayload(verified, source),
  })
}

/** A check that changed nothing: the gateway could not be reached, is still working, or agrees with us. */
export async function logBillingCheck(merchantId: string, provider: string, reference: string, source: CheckSource, outcome: 'pending' | 'error' | 'matches', detail: Record<string, unknown> = {}) {
  await rpc(adminClient(merchantId), 'billing_payment_check_log', {
    p_reference: reference, p_provider: provider, p_source: source, p_outcome: outcome, p_gateway_status: null, p_detail: detail,
  }).catch(() => undefined)
}

/** How a confirmation reads to the merchant coming back from the gateway. */
export function outcomeFor(status: string, verified?: VerifiedPayment): 'success' | 'review' | 'cancelled' | 'failed' {
  if (['succeeded', 'already_succeeded'].includes(status)) return 'success'
  if (['amount_mismatch', 'currency_mismatch', 'reference_mismatch', 'duplicate_transaction', 'unknown_payment'].includes(status)) return 'review'
  if (status === 'cancelled' || (verified && /cancel/i.test(verified.eventType))) return 'cancelled'
  return 'failed'
}

export type { SupabaseClient }

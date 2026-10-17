import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BKASH_SANDBOX_URL, BkashProvider, clearBkashTokens } from './payments/bkash.ts'
import { redactGatewayAnswer } from './payments/redact.ts'
import type { VerifiedPayment } from './payments/types.ts'
import { checkPayload, outcomeFor } from './platform-billing.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const creds = { appKey: 'app-key-1', appSecret: 'secret-1', username: 'user', password: 'pass', sandbox: true }
const grant = { id_token: 'tok-1', expires_in: 3600, statusCode: '0000' }

function fakeBkash(routes: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(BKASH_SANDBOX_URL, '')
    const route = routes[path]
    if (route === undefined) return jsonResponse({ errorCode: '404', errorMessage: 'no route' }, 404)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    return jsonResponse(typeof route === 'function' ? (route as (b: Record<string, unknown>) => unknown)(body) : route)
  })
}

const verified = (over: Partial<VerifiedPayment>): VerifiedPayment => ({
  reference: 'BP-1', providerTransactionId: null, amount: null, currency: null, success: false, eventId: 'e', eventType: 'execute.failed', raw: {}, ...over,
})

describe('bKash refunds', () => {
  beforeEach(() => clearBkashTokens())

  it('sends the payment, its transaction and the amount, and counts the refund only when bKash completes it', async () => {
    const fetchFn = fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/payment/refund': (b) => b.amount
        ? { statusCode: '0000', transactionStatus: 'Completed', originalTrxID: b.trxID, refundTrxID: 'RFD123', amount: b.amount, currency: 'BDT' }
        : { statusCode: '2071', statusMessage: 'Not found' },
    })
    const bkash = new BkashProvider(creds, fetchFn)
    const result = await bkash.refund({ session: 'TR0011', transactionId: 'BFD90', amount: 360, reference: 'BP-ABC', reason: 'Bought by mistake' })
    expect(result).toMatchObject({ success: true, refundTransactionId: 'RFD123', amount: 360 })
    const sent = JSON.parse(String(fetchFn.mock.calls[1][1]!.body))
    expect(sent).toEqual({ paymentID: 'TR0011', trxID: 'BFD90', amount: '360.00', sku: 'BP-ABC', reason: 'Bought by mistake' })
  })

  it('reports a refused refund as failed, and a refund in progress as pending', async () => {
    const refused = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/payment/refund': { statusCode: '2023', statusMessage: 'Insufficient Balance' },
    }))
    expect(await refused.refund({ session: 'TR1', transactionId: 'T1', amount: 10, reference: 'BP', reason: 'Test refund' }))
      .toMatchObject({ success: false, pending: false, reason: 'Insufficient Balance' })
    clearBkashTokens()
    const working = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/payment/refund': { statusCode: '0000', transactionStatus: 'Initiated' },
    }))
    expect(await working.refundStatus('TR1', 'T1')).toMatchObject({ success: false, pending: true })
  })
})

describe('what is kept from a gateway answer', () => {
  it('cuts phone numbers to their last digits and drops tokens', () => {
    expect(redactGatewayAnswer({
      paymentID: 'TR1', trxID: 'BFD90', customerMsisdn: '01770618575', payerReference: '01711000001', id_token: 'secret', nested: { authorization: 'Bearer x', amount: '360.00' },
    })).toEqual({ paymentID: 'TR1', trxID: 'BFD90', customerMsisdn: '•••575', payerReference: '•••001', nested: { amount: '360.00' } })
  })

  it('names each check by what the gateway said, and tells the merchant the same', () => {
    expect(checkPayload(verified({ eventType: 'callback.cancel' }), 'RETURN')).toMatchObject({ outcome: 'cancelled', source: 'RETURN', gateway_status: 'cancel' })
    expect(checkPayload(verified({ eventType: 'reconcile.initiated' }), 'RECONCILE')).toMatchObject({ outcome: 'expired' })
    expect(checkPayload(verified({ eventType: 'execute.failed' }), 'RETURN')).toMatchObject({ outcome: 'failed' })
    expect(checkPayload(verified({ success: true, currency: 'BDT', eventType: 'execute.completed', raw: { customerMsisdn: '01770618575' } }), 'RETURN'))
      .toMatchObject({ outcome: 'succeeded', currency: 'BDT', raw: { customerMsisdn: '•••575' } })
    expect(outcomeFor('succeeded')).toBe('success')
    expect(outcomeFor('already_succeeded')).toBe('success')
    expect(outcomeFor('currency_mismatch')).toBe('review')
    expect(outcomeFor('cancelled')).toBe('cancelled')
    expect(outcomeFor('expired')).toBe('failed')
  })
})

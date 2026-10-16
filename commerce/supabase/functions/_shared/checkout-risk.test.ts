import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { quoteCart } from './checkout-flow.ts'
import { FraudDetectionService } from './fraud/service.ts'
import type { FraudProvider } from './fraud/types.ts'

// The checkout quote and the courier check: what the customer sees before placing the order.
// A fake database answers the rpc calls; the decision itself is tested in the database tests.

interface Fake {
  admin: SupabaseClient
  calls: Array<{ fn: string; args: Record<string, unknown> }>
}

function fakeAdmin(opts: { fraud?: Record<string, unknown>; cached?: string | null; allowed?: boolean; recorded?: string } = {}): Fake {
  const calls: Fake['calls'] = []
  const answers: Record<string, unknown> = {
    storefront_quote: { total: 1370, subtotal: 1250, delivery_charge: 120, return_charge: 0, lines: [] },
    recent_fraud_check: opts.cached ? { id: opts.cached } : null,
    checkout_lookup_allowed: opts.allowed ?? true,
    record_fraud_check: { id: opts.recorded ?? 'check-new' },
    checkout_risk_preview: { mode: 'ADVANCE', amount: 120, cod_allowed: true, message: 'Pay ৳120 in advance' },
  }
  const settings = { value: opts.fraud ?? { enabled: true, providers: ['internal'], courier_record: false } }
  const query = { select: () => query, eq: () => query, maybeSingle: () => Promise.resolve({ data: settings, error: null }) }
  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: answers[fn] ?? null, error: null })
    },
    from: () => query,
  } as unknown as SupabaseClient
  return { admin, calls }
}

const quoteInput = (over: Record<string, unknown> = {}) => ({
  action: 'quote' as const, items: [{ variant_id: crypto.randomUUID(), quantity: 1 }], delivery_method: 'standard', payment_method: 'COD' as const,
  district: 'Dhaka', phone: '01712345678', check: false, ...over,
})

describe('checkout quote and the courier check', () => {
  it('shows no payment decision before the check has run (no guessing "cash on delivery")', async () => {
    const f = fakeAdmin()
    const r = await quoteCart(f.admin, quoteInput() as never, { ip: '203.0.113.9' })
    expect(r).toMatchObject({ risk: 'pending', payment_requirement: null })
    // A plain quote never starts a lookup.
    expect(f.calls.map((c) => c.fn)).not.toContain('record_fraud_check')
  })

  it('runs the check when asked, within the limits, and returns the real requirement', async () => {
    const f = fakeAdmin()
    const r = await quoteCart(f.admin, quoteInput({ check: true }) as never, { ip: '203.0.113.9' })
    expect(r).toMatchObject({ risk: 'checked', payment_requirement: { mode: 'ADVANCE', amount: 120 } })
    const recorded = f.calls.find((c) => c.fn === 'record_fraud_check')!.args.p_input as Record<string, any>
    // Counted per visitor without keeping the address; the order's amounts go with the check.
    expect(recorded.context).toMatchObject({ origin: 'checkout', order_value: 1370, delivery_charge: 120 })
    expect(recorded.context.ip_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(recorded)).not.toContain('203.0.113.9')
    expect(f.calls.find((c) => c.fn === 'checkout_risk_preview')!.args.p_fraud_check_id).toBe('check-new')
  })

  it('reuses a recent check instead of paying for another', async () => {
    const f = fakeAdmin({ cached: 'check-old' })
    const r = await quoteCart(f.admin, quoteInput({ check: true }) as never, { ip: '1.1.1.1' })
    expect(r.risk).toBe('checked')
    expect(f.calls.map((c) => c.fn)).not.toContain('record_fraud_check')
    expect(f.calls.find((c) => c.fn === 'checkout_risk_preview')!.args.p_fraud_check_id).toBe('check-old')
  })

  it('over the limit, or for a number that is not a Bangladeshi mobile, defers the decision to order placement', async () => {
    const limited = fakeAdmin({ allowed: false })
    expect(await quoteCart(limited.admin, quoteInput({ check: true }) as never, { ip: '1.1.1.1' })).toMatchObject({ risk: 'deferred', payment_requirement: null })
    expect(limited.calls.map((c) => c.fn)).not.toContain('record_fraud_check')

    const foreign = fakeAdmin()
    expect((await quoteCart(foreign.admin, quoteInput({ check: true, phone: '+44 7700 900123' }) as never, { ip: '1.1.1.1' })).risk).toBe('deferred')
    expect(foreign.calls.map((c) => c.fn)).not.toContain('checkout_lookup_allowed')
  })

  it('a store that does not screen orders shows its normal payment options', async () => {
    const f = fakeAdmin({ fraud: { enabled: false } })
    const r = await quoteCart(f.admin, quoteInput({ check: true }) as never, { ip: '1.1.1.1' })
    expect(r.risk).toBe('off')
    expect(r.payment_requirement).not.toBeNull()
  })
})

describe('combining courier sources into one check', () => {
  const ok = (name: string, counts: Record<string, number>, extra = {}): FraudProvider => ({ name, checkCustomer: () => Promise.resolve({ provider: name, ok: true, counts, ...extra }) })
  const down = (name: string, error: string): FraudProvider => ({ name, checkCustomer: () => Promise.resolve({ provider: name, ok: false, counts: {}, error }) })
  const crash = (name: string): FraudProvider => ({ name, checkCustomer: () => Promise.reject(new Error('socket hang up')) })

  it('one source down: the others still decide (PARTIAL), with the failure named', async () => {
    const p = await new FraudDetectionService([ok('internal', {}), ok('courier_history', { total: 12, delivered: 11, returned: 1 }), down('http', 'HTTP 401 (expired key)')])
      .check({ phone: '01712345678' })
    expect(p).toMatchObject({ status: 'PARTIAL', provider: 'courier_history', provider_counts: { total: 12, delivered: 11, returned: 1 } })
    expect(p.error).toBe('http: HTTP 401 (expired key)')
  })

  it('every source down (or crashing): ERROR, no counts at all — never zero deliveries', async () => {
    const p = await new FraudDetectionService([ok('internal', {}), down('courier_history', 'Steadfast: login failed'), crash('http')]).check({ phone: '01712345678' })
    expect(p.status).toBe('ERROR')
    expect(p.provider_counts).toEqual({})
    expect(p.error).toContain('socket hang up')
  })

  it('duplicate history from two sources is not added up (the larger count stands)', async () => {
    const p = await new FraudDetectionService([ok('a', { total: 10, delivered: 8 }), ok('b', { total: 12, delivered: 9 })]).check({ phone: '01712345678' })
    expect(p.provider_counts).toEqual({ total: 12, delivered: 9 })
  })

  it('a provider that only reports a rate passes the rate on, not invented counts', async () => {
    const p = await new FraudDetectionService([ok('courier_history', {}, { courierScore: 41, parcelFloor: 50 })]).check({ phone: '01712345678' })
    expect(p).toMatchObject({ provider_courier_score: 41, provider_parcel_floor: 50, provider_counts: {} })
  })
})

vi.mock('./monitoring.ts', () => ({ logEvent: () => Promise.resolve() }))

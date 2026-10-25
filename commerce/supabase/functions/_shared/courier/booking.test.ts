import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withBookingClaim } from './booking.ts'

/** A fake client that records rpc calls and answers each function with the given error (if any). */
function client(errors: Record<string, { message: string }> = {}) {
  const calls: string[] = []
  const fake = { rpc: vi.fn(async (fn: string) => { calls.push(fn); return { data: null, error: errors[fn] ?? null } }) }
  return { client: fake as unknown as SupabaseClient, calls }
}

describe('courier booking claim', () => {
  it('claims the order before the courier is asked, and keeps the claim once the parcel exists', async () => {
    const { client: c, calls } = client()
    const book = vi.fn(async () => { calls.push('courier'); return { tracking: 'DT1' } })
    expect(await withBookingClaim(c, 'o1', 'c1', book)).toEqual({ tracking: 'DT1' })
    expect(calls).toEqual(['shipment_booking_claim', 'courier'])
  })

  it('never asks the courier when the order is already being booked', async () => {
    const { client: c, calls } = client({ shipment_booking_claim: { message: 'BOOKING_IN_PROGRESS: #1001 is being booked right now; wait for that booking to finish' } })
    const book = vi.fn()
    await expect(withBookingClaim(c, 'o1', 'c1', book)).rejects.toMatchObject({ status: 409, code: 'BOOKING_IN_PROGRESS' })
    await expect(withBookingClaim(client({ shipment_booking_claim: { message: 'ALREADY_BOOKED: #1001 is already booked' } }).client, 'o1', 'c1', book))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_BOOKED' })
    expect(book).not.toHaveBeenCalled()
    expect(calls).toEqual(['shipment_booking_claim'])
  })

  it('releases the order when the courier refuses, and passes the refusal on', async () => {
    const { client: c, calls } = client()
    await expect(withBookingClaim(c, 'o1', 'c1', async () => { throw new Error('Pathao: invalid area') })).rejects.toThrow('Pathao: invalid area')
    expect(calls).toEqual(['shipment_booking_claim', 'shipment_booking_release'])
  })
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { checkAdAccount, spendWindow, syncPlatformAdSpend } from './platform-ads.ts'

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const account = { id: '7c1f0c55-0000-4000-8000-000000000001', name: 'Fullfilio ads', ad_account_id: 'act_123456', app_id: null, is_active: true, timezone: 'Asia/Dhaka', currency: 'USD' }

function fakeAdmin(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = []
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args])
      return { data: answers[fn] ?? null, error: null }
    }),
  } as unknown as SupabaseClient
  return { admin, calls }
}

describe('Fullfilio ad spend', () => {
  it('asks Meta for the whole account per day and records each window', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ data: [{ spend: '10.50', date_start: '2026-10-01' }, { spend: '0', date_start: '2026-10-02' }] }))
    const { admin, calls } = fakeAdmin({ platform_ad_spend_apply: { days: 1, amount: 1281, foreign_amount: 10.5 } })
    const r = await syncPlatformAdSpend(admin, account, { access_token: 'EAA'.padEnd(30, 'x') }, { since: '2026-10-01', until: '2026-10-02' }, fetchFn)
    expect(r).toMatchObject({ ok: true, days: 1, amount: 1281, foreign_amount: 10.5 })
    const url = new URL(fetchFn.mock.calls[0][0])
    expect(url.pathname).toMatch(/\/act_123456\/insights$/)
    expect(url.searchParams.get('level')).toBe('account')
    expect(url.searchParams.get('time_increment')).toBe('1')
    expect(url.toString()).not.toContain('EAA')
    expect(calls[0]).toEqual(['platform_ad_spend_apply', {
      p_id: account.id, p_since: '2026-10-01', p_until: '2026-10-02',
      p_rows: [{ date: '2026-10-01', spend: 10.5 }, { date: '2026-10-02', spend: 0 }],
    }])
    expect(calls[1]).toEqual(['platform_ad_account_record_sync', { p_id: account.id, p_status: 'OK', p_error: null, p_since: '2026-10-01', p_until: '2026-10-02' }])
  })

  it('records an expired token as TOKEN_INVALID without throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ error: { message: 'Error validating access token', code: 190 } }, 400))
    const { admin, calls } = fakeAdmin()
    const r = await syncPlatformAdSpend(admin, account, { access_token: 'EAA'.padEnd(30, 'x') }, { since: '2026-10-01', until: '2026-10-01' }, fetchFn)
    expect(r).toMatchObject({ ok: false, status: 'TOKEN_INVALID' })
    expect(r.error).toMatch(/not valid or has expired/)
    expect(calls.map((c) => c[0])).toEqual(['platform_ad_account_record_sync'])
    expect(calls[0][1]).toMatchObject({ p_status: 'TOKEN_INVALID' })
  })

  it('checks the token belongs to the app and warns without ads_read', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply({ id: 'act_123456', name: 'Fullfilio', currency: 'USD', timezone_name: 'Asia/Dhaka', account_status: 1 }))
      .mockResolvedValueOnce(reply({ data: { is_valid: true, app_id: '111111', scopes: ['pages_show_list'], expires_at: 0 } }))
    const r = await checkAdAccount({ access_token: 'EAA'.padEnd(30, 'x'), app_secret: 'a'.repeat(32) }, '111111', 'act_123456', fetchFn)
    expect(r.account).toMatchObject({ id: 'act_123456', currency: 'USD' })
    expect(r.warnings).toEqual(['The token has no ads_read permission; spend may not sync.'])

    const wrongApp = vi.fn()
      .mockResolvedValueOnce(reply({ id: 'act_123456', name: 'Fullfilio', currency: 'USD' }))
      .mockResolvedValueOnce(reply({ data: { is_valid: true, app_id: '999999', scopes: ['ads_read'] } }))
    await expect(checkAdAccount({ access_token: 'EAA'.padEnd(30, 'x'), app_secret: 'a'.repeat(32) }, '111111', 'act_123456', wrongApp))
      .rejects.toThrow(/issued by app 999999/)
  })

  it('counts the window in the account’s own days', () => {
    expect(spendWindow(3, 'Asia/Dhaka', new Date('2026-10-10T20:00:00Z'))).toEqual({ since: '2026-10-09', until: '2026-10-11' })
  })
})

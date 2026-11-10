import { describe, expect, it } from 'vitest'
import type { ErrorDetail } from '@/services/platform-ops'
import { codePointer, errorHints } from './hints'
import { claudeReport, stepLine } from './report'

const facts = (message: string, category = 'FUNCTION', source = 'orders', more: Record<string, unknown> = {}) => ({ message, category, source, ...more })

describe('likely cause', () => {
  it('reads database errors: missing function, column, grant, a value that was required', () => {
    expect(errorHints(facts('function public.platform_errors(p jsonb) does not exist'))[0].title).toBe('Database function missing: public.platform_errors')
    expect(errorHints(facts('column "order_id" of relation "shopify_abandoned_checkouts" does not exist'))[0].title).toBe('Column missing: order_id')
    expect(errorHints(facts('permission denied for table system_log_samples'))[0].title).toBe('Database permission missing (table system_log_samples)')
    expect(errorHints(facts('null value in column "phone" of relation "customers" violates not-null constraint'))[0].title).toBe('Required value missing: phone (customers)')
    expect(errorHints(facts('duplicate key value violates unique constraint "inbox_channels_one_store_idx"'))[0].title).toBe('Page already connected to another business')
  })

  it('reads outside services: Meta tokens, courier credentials, Worker limits, the network', () => {
    expect(errorHints(facts('Error validating access token: Session has expired', 'META', 'inbox'))[0].title).toBe('Meta token no longer valid')
    expect(errorHints(facts('Pathao answered HTTP 401 Unauthorized', 'COURIER', 'courier'))[0].title).toBe('Courier rejected the business\'s credentials')
    expect(errorHints(facts('Steadfast answered HTTP 502', 'COURIER', 'courier'))[0].title).toBe('Courier service down or slow')
    expect(errorHints(facts('Too many subrequests.'))[0].title).toContain('too many outgoing calls')
    expect(errorHints(facts('TypeError: Failed to fetch', 'FRONTEND', 'admin-app'))[0].title).toContain('Network')
  })

  it('reads browser code bugs, and falls back to where the error happened', () => {
    expect(errorHints(facts("Cannot read properties of undefined (reading 'phone')", 'FRONTEND', 'admin-app'))[0].title).toBe('Code bug: a value was missing')
    expect(errorHints(facts('something odd', 'JOB', 'courier-poll'))[0].title).toBe('A scheduled task failed')
    expect(errorHints(facts('something odd', 'OTHER', 'x'))).toEqual([])
  })

  it('says when a fixed error came back, and when only old tabs still hit it', () => {
    expect(errorHints(facts('x', 'OTHER', 'x', { status: 'NEW', regressed_at: '2026-11-10T06:00:00Z' })).map((h) => h.title)).toEqual(['It came back after being fixed'])
    expect(errorHints(facts('x', 'OTHER', 'x', { status: 'FIXED', old_version_hits: 3 })).map((h) => h.title)).toEqual(['Still seen in tabs not reloaded since the fix'])
  })

  it('points to the code: the function folder, or the admin page', () => {
    expect(codePointer({ category: 'FUNCTION', source: 'inbox' })).toBe('supabase/functions/inbox/ (and supabase/functions/_shared/)')
    expect(codePointer({ category: 'FRONTEND', source: 'admin-app' }, '/admin/orders/3f2c1d4e-1111-4222-8333-444455556666')).toBe('src/pages/admin/orders (page /admin/orders/3f2c1d4e-1111-4222-8333-444455556666)')
  })
})

const detail = (): ErrorDetail => ({
  error: {
    id: 41, level: 'ERROR', category: 'FRONTEND', source: 'admin-app', message: 'orders/save: Something went wrong. Please try again.', status: 'NEW', context: {},
    fingerprint: 'f', occurrences: 3, first_seen_at: '2026-11-09T08:00:00Z', last_seen_at: '2026-11-10T06:12:07Z', resolved_at: null, note: 'Only on phones',
    fixed_in: 'abc1234', fixed_release: '2026-11-09T10:00Z+abc1234', status_changed_at: null, status_by_email: null, regressed_at: '2026-11-10T06:12:07Z', regressions: 1,
    last_release: '2026-11-10T05:00Z+def5678', old_version_hits: 0, old_version_seen_at: null, merchant: { id: 'm1', number: 12, name: 'Atheron' },
  },
  siblings: [{ id: 41, status: 'NEW', occurrences: 3, first_seen_at: '', last_seen_at: '', regressed_at: null, last_release: null, merchant: { id: 'm1', number: 12, name: 'Atheron' } }],
  samples: [{
    id: 9, log_id: 41, at: '2026-11-10T06:12:07Z', message: 'orders/save: Something went wrong. Please try again.', release: '2026-11-10T05:00Z+def5678', old_version: false,
    merchant: { id: 'm1', number: 12, name: 'Atheron' }, user: { id: 'u-1', name: 'Rafi' },
    context: {
      path: '/admin/orders/new', request_id: 'a1b2c3d4e5f6', stack: 'AppError: Something went wrong\n    at save (order-new.js:1:200)',
      trail: [
        { t: 'nav', to: '/admin/orders/new', at: '2026-11-10T06:11:50.000Z' },
        { t: 'click', label: 'Create order', at: '2026-11-10T06:12:06.000Z' },
        { t: 'call', name: 'fn orders/save', status: 500, ms: 312, request_id: 'a1b2c3d4e5f6', at: '2026-11-10T06:12:07.000Z' },
      ],
    },
  }],
  daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, n: i === 29 ? 3 : 0 })),
  linked: [{ id: 40, category: 'FUNCTION', source: 'orders', message: 'null value in column "phone" violates not-null constraint', status: 'NEW', at: '2026-11-10T06:12:07Z', request_id: 'a1b2c3d4e5f6', context: { stack: 'error: null value\n  at insert' } }],
  nearby: [],
  history: [],
  can: { manage: true },
})

describe('Copy for Claude', () => {
  it('puts the error, the likely cause, the steps, the stack and the server side in one text', () => {
    const r = claudeReport(detail())
    expect(r).toContain('Fullfilio error #41: please find the root cause and fix it')
    expect(r).toContain('Status: New · came back 1 time(s)')
    expect(r).toContain('fixed in abc1234')
    expect(r).toContain('Note: Only on phones')
    expect(r).toContain('App version (newest occurrence): 2026-11-10T05:00Z+def5678')
    expect(r).toContain('Start in: src/pages/admin/orders-new (page /admin/orders/new)')
    expect(r).toContain('06:12:06  pressed "Create order"')
    expect(r).toContain('06:12:07  fn orders/save → 500 (312 ms) · request a1b2c3d4e5f6')
    expect(r).toContain('at save (order-new.js:1:200)')
    expect(r).toContain('#40 function · orders: null value in column "phone" violates not-null constraint (request a1b2c3d4e5f6')
    expect(r).toContain('Per day, last 14 days (oldest first): 0 0 0 0 0 0 0 0 0 0 0 0 0 3')
    // The person is named by id only.
    expect(r).not.toContain('Rafi')
  })

  it('writes each kind of step as a readable line', () => {
    expect(stepLine({ t: 'nav', to: '/admin', at: '2026-11-10T06:00:00.000Z' })).toBe('06:00:00  opened /admin')
    expect(stepLine({ t: 'call', name: 'rpc unread', status: 200, ms: 20, x: 4, at: '2026-11-10T06:00:01.000Z' })).toBe('06:00:01  rpc unread → 200 (20 ms) ×4')
    expect(stepLine({ t: 'toast', text: 'Saved twice', at: '2026-11-10T06:00:02.000Z' })).toBe('06:00:02  message shown: "Saved twice"')
  })
})

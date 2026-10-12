import { describe, expect, it } from 'vitest'
import { cronMatches, dueJobs, JOBS, type JobRunner, runDue } from './cron.ts'

const at = (iso: string) => new Date(iso)

describe('cron expressions (UTC)', () => {
  it('matches minutes, steps, ranges, lists and days like cron', () => {
    expect(cronMatches('* * * * *', at('2026-10-12T10:07:00Z'))).toBe(true)
    expect(cronMatches('7 * * * *', at('2026-10-12T10:07:00Z'))).toBe(true)
    expect(cronMatches('7 * * * *', at('2026-10-12T10:08:00Z'))).toBe(false)
    expect(cronMatches('*/5 * * * *', at('2026-10-12T10:15:00Z'))).toBe(true)
    expect(cronMatches('*/5 * * * *', at('2026-10-12T10:16:00Z'))).toBe(false)
    expect(cronMatches('17 */3 * * *', at('2026-10-12T09:17:00Z'))).toBe(true)
    expect(cronMatches('17 */3 * * *', at('2026-10-12T10:17:00Z'))).toBe(false)
    expect(cronMatches('0 9-17 * * 1-5', at('2026-10-12T12:00:00Z'))).toBe(true) // a Monday
    expect(cronMatches('0 9-17 * * 1-5', at('2026-10-11T12:00:00Z'))).toBe(false) // a Sunday
    expect(cronMatches('0 0 1,15 * *', at('2026-10-15T00:00:00Z'))).toBe(true)
    expect(cronMatches('0 0 * * 7', at('2026-10-11T00:00:00Z'))).toBe(true)
    expect(cronMatches('bad', at('2026-10-12T10:07:00Z'))).toBe(false)
  })
})

describe('scheduled jobs', () => {
  it('are the 12 Supabase pg_cron jobs with their schedules', () => {
    expect(Object.fromEntries(JOBS.map((j) => [j.name, j.schedule]))).toEqual({
      'account-removals': '* * * * *', 'ad-platforms-sync': '47 */3 * * *', 'billing-run': '7 * * * *',
      'channel-sync-jobs': '* * * * *', 'channels-sync': '37 * * * *', 'courier-webhook-retry': '*/5 * * * *',
      'expire-unpaid-advance-orders': '*/15 * * * *', 'meta-ads-sync': '17 */3 * * *', 'notifications-dispatch': '* * * * *',
      'payments-reconcile': '*/5 * * * *', 'platform-ops': '*/10 * * * *', 'voicedrive-sweep': '* * * * *',
    })
  })

  it('picks the jobs due this minute', () => {
    expect(dueJobs(at('2026-10-12T10:07:00Z')).map((j) => j.name).sort()).toEqual(
      ['account-removals', 'billing-run', 'channel-sync-jobs', 'notifications-dispatch', 'voicedrive-sweep'])
    expect(dueJobs(at('2026-10-12T09:30:00Z')).map((j) => j.name).sort()).toEqual(
      ['account-removals', 'channel-sync-jobs', 'courier-webhook-retry', 'expire-unpaid-advance-orders', 'notifications-dispatch',
        'payments-reconcile', 'platform-ops', 'voicedrive-sweep'])
  })

  it('calls a function only when there is something to do, and one failure does not stop the rest', async () => {
    const calls: string[] = []
    const failures: string[] = []
    const runner = (pending: boolean): JobRunner => ({
      rpc: async (fn, args) => { calls.push(`rpc ${fn}${args ? ` ${JSON.stringify(args)}` : ''}`); if (fn === 'billing_run') throw new Error('boom'); return pending },
      exists: async (table) => { calls.push(`exists ${table}`); return pending },
      call: async (fn, body, search) => { calls.push(`call ${fn} ${JSON.stringify(body)}${search ? ` ?${search}` : ''}`); return 200 },
    })
    await runDue(at('2026-10-12T10:07:00Z'), runner(false), (job) => failures.push(job))
    expect(calls.filter((c) => c.startsWith('call'))).toEqual([])
    expect(failures).toEqual(['billing-run'])
    expect(calls).toContain('rpc for_each_merchant {"p_job":"pbx_sweep"}')
    calls.length = 0
    await runDue(at('2026-10-12T09:15:00Z'), runner(true), () => undefined)
    expect(calls.filter((c) => c.startsWith('call')).sort()).toEqual([
      'call channels {"action":"process_jobs"}', 'call clerk-auth {"action":"removals"}', 'call notifications-dispatch {}',
      'call payment-webhook {} ?reconcile=1'])
  })
})

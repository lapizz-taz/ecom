// Scheduled jobs on Cloudflare: what pg_cron ran on Supabase. One cron trigger fires
// every minute (wrangler.jsonc); each job keeps its Supabase schedule (UTC) and its
// "only when there is something to do" check. They run only once the database is on
// Cloudflare (DATABASE_BACKEND=cloudflare): until the switch-over Supabase's pg_cron
// runs them, never both.

/** What a job may do: call a database function, look for a row, or call a backend function. */
export interface JobRunner {
  rpc(fn: string, args?: Record<string, unknown>): Promise<unknown>
  exists(table: string, filter: string): Promise<boolean>
  call(fn: string, body: Record<string, unknown>, search?: string): Promise<unknown>
}

export interface CronJob {
  name: string
  /** Five-field cron expression in UTC, as on Supabase. */
  schedule: string
  run: (r: JobRunner) => Promise<unknown>
}

const minutesAgo = (n: number, now: Date) => new Date(now.getTime() - n * 60_000).toISOString()

export const JOBS: CronJob[] = [
  // Database functions (each runs for every merchant where it says so).
  { name: 'billing-run', schedule: '7 * * * *', run: (r) => r.rpc('billing_run') },
  { name: 'platform-ops', schedule: '*/10 * * * *', run: (r) => r.rpc('platform_ops_run') },
  { name: 'courier-webhook-retry', schedule: '*/5 * * * *', run: (r) => r.rpc('for_each_merchant', { p_job: 'retry_courier_webhooks' }) },
  { name: 'expire-unpaid-advance-orders', schedule: '*/15 * * * *', run: (r) => r.rpc('for_each_merchant', { p_job: 'expire_unpaid_advance_orders' }) },
  { name: 'voicedrive-sweep', schedule: '* * * * *', run: (r) => r.rpc('for_each_merchant', { p_job: 'pbx_sweep' }) },
  { name: 'hr-auto-checkout', schedule: '*/5 * * * *', run: (r) => r.rpc('for_each_merchant', { p_job: 'hr_auto_checkout' }) },
  // Backend functions, called as a scheduled caller.
  {
    name: 'account-removals', schedule: '* * * * *',
    run: async (r) => (await r.exists('account_removals', 'status=eq.PENDING')) && r.call('clerk-auth', { action: 'removals' }),
  },
  {
    name: 'channel-sync-jobs', schedule: '* * * * *',
    run: async (r) => (await r.rpc('channel_jobs_due')) === true && r.call('channels', { action: 'process_jobs' }),
  },
  {
    name: 'channels-sync', schedule: '37 * * * *',
    run: async (r) => (await r.rpc('channels_sync_due')) === true && r.call('channels', { action: 'sync' }),
  },
  {
    // Stores that turned on Settings → Advanced → Courier automation; the function checks who is due.
    name: 'courier-status-sync', schedule: '*/15 * * * *',
    run: async (r) => (await r.exists('settings', 'key=eq.courier_sync&value->>auto=eq.true')) && r.call('courier', { action: 'sync_all' }),
  },
  {
    name: 'meta-ads-sync', schedule: '17 */3 * * *',
    run: async (r) => ((await r.exists('settings', 'key=eq.meta_ads&value->>connected=eq.true')) || (await r.exists('meta_ad_accounts', 'id=not.is.null')))
      && r.call('meta-ads', { action: 'sync', days: 3 }),
  },
  {
    name: 'ad-platforms-sync', schedule: '47 */3 * * *',
    run: async (r) => (await r.exists('ad_accounts', 'is_selected=eq.true')) && r.call('ad-platforms', { action: 'sync', days: 3 }),
  },
  {
    name: 'notifications-dispatch', schedule: '* * * * *',
    run: async (r) => ((await r.exists('notification_logs', `status=eq.QUEUED&next_attempt_at=lte.${new Date().toISOString()}`))
      || (await r.exists('notification_logs', `channel=eq.SMS&status=eq.SENT&delivery_status=eq.PENDING&sent_at=lt.${minutesAgo(1, new Date())}`)))
      && r.call('notifications-dispatch', {}),
  },
  {
    // Custom domains still waiting for DNS: checked (and attached) without anyone pressing Check.
    name: 'domains-recheck', schedule: '*/10 * * * *',
    run: async (r) => (await r.exists('store_domains', 'status=in.(PENDING,VERIFYING,MANUAL,ERROR)')) && r.call('domains', { action: 'recheck_all' }),
  },
  {
    name: 'payments-reconcile', schedule: '*/5 * * * *',
    run: async (r) => {
      const now = new Date()
      const pending = await r.exists('payments', `status=eq.PENDING&provider=in.(bkash,paystation)&created_at=lt.${minutesAgo(3, now)}&created_at=gt.${minutesAgo(3 * 24 * 60, now)}`)
      return pending && r.call('payment-webhook', {}, 'reconcile=1')
    },
  },
]

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/')
    const step = stepText ? Number(stepText) : 1
    if (!Number.isInteger(step) || step < 1) return false
    let lo: number
    let hi: number
    if (range === '*') [lo, hi] = [min, max]
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number) as [number, number]
    else [lo, hi] = [Number(range), stepText ? max : Number(range)]
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
    return value >= lo && value <= hi && (value - lo) % step === 0
  })
}

/** Whether a five-field cron expression (UTC) includes this minute. */
export function cronMatches(expression: string, at: Date): boolean {
  const f = expression.trim().split(/\s+/)
  if (f.length !== 5) return false
  const dowField = f[4].replace(/\b7\b/g, '0')
  const domAny = f[2] === '*'
  const dowAny = f[4] === '*'
  const dom = fieldMatches(f[2], at.getUTCDate(), 1, 31)
  const dow = fieldMatches(dowField, at.getUTCDay(), 0, 6)
  // Standard cron: when both day fields are restricted, either may match.
  const day = domAny || dowAny ? dom && dow : dom || dow
  return fieldMatches(f[0], at.getUTCMinutes(), 0, 59) && fieldMatches(f[1], at.getUTCHours(), 0, 23)
    && fieldMatches(f[3], at.getUTCMonth() + 1, 1, 12) && day
}

/** The jobs due at this minute. */
export const dueJobs = (at: Date, jobs: CronJob[] = JOBS) => jobs.filter((j) => cronMatches(j.schedule, at))

/** Runs the due jobs side by side; one failing does not stop the others. */
export async function runDue(at: Date, runner: JobRunner, log: (job: string, error: unknown) => void, jobs: CronJob[] = JOBS): Promise<string[]> {
  const due = dueJobs(at, jobs)
  await Promise.all(due.map((job) => job.run(runner).catch((e) => log(job.name, e))))
  return due.map((j) => j.name)
}

import { env } from './env.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

/**
 * Nudges the notifications-dispatch function so customer messages go out
 * immediately after an order event (a cron job also drains the queue).
 */
export function dispatchNotificationsInBackground(): void {
  const url = env('SUPABASE_URL')
  const secret = env('CRON_SECRET')
  if (!url || !secret || env('NOTIFICATIONS_DISPATCH_INLINE') === 'false') return
  const task = fetch(`${url}/functions/v1/notifications-dispatch`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch((error) => console.error('Could not trigger notification dispatch', error))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task)
}

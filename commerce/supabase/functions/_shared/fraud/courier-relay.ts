// The Worker's side of the courier relay: courier sign-ins and lookups go to the
// courier-relay function on Supabase (see courier-panel.ts → PanelRelay), because
// the couriers' sites refuse requests that come from Cloudflare Workers.
//
// Only the customer's phone travels for a lookup; the relay reads the platform's
// courier logins from Vault itself. A login test sends the login being tested
// (Super Admin typed it), over HTTPS, to our own function.
import type { CourierHistorySummary } from './courier-history.ts'
import type { CourierPanelProviderId, PanelLogin, PanelRelay } from './courier-panel.ts'

type FetchFn = typeof fetch

export interface RelayConfig {
  /** https://<project>.supabase.co/functions/v1/courier-relay */
  url: string
  /** The shared cron secret (x-cron-secret), checked by the relay. */
  cronSecret?: string
  /** The service role key, sent too: the relay accepts either. */
  serviceKey?: string
  fetchFn?: FetchFn
  timeoutMs?: number
}

export function httpPanelRelay(c: RelayConfig): PanelRelay {
  const call = async <T>(body: Record<string, unknown>): Promise<T> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (c.cronSecret) headers['x-cron-secret'] = c.cronSecret
    if (c.serviceKey) headers.Authorization = `Bearer ${c.serviceKey}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), c.timeoutMs ?? 45_000)
    let res: Response
    try {
      res = await (c.fetchFn ?? fetch)(c.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    } catch (error) {
      throw new Error((error as Error).name === 'AbortError' ? 'The courier check took too long' : 'Could not reach the courier check service')
    } finally {
      clearTimeout(timer)
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
    if (!res.ok || !data) {
      const msg = (data?.error as { message?: string } | undefined)?.message
      throw new Error(msg ? `Courier check service: ${msg}` : `Courier check service answered HTTP ${res.status}`)
    }
    return data
  }
  return {
    async lookup(phone: string): Promise<CourierHistorySummary> {
      const r = await call<{ ok: boolean; summary?: CourierHistorySummary; message?: string }>({ action: 'lookup', phone })
      if (!r.ok || !r.summary) throw new Error(r.message || 'The courier check failed')
      return r.summary
    },
    test(provider: CourierPanelProviderId, login: PanelLogin, samplePhone: string) {
      return call<{ ok: boolean; message: string }>({ action: 'test', provider, login, phone: samplePhone })
    },
  }
}

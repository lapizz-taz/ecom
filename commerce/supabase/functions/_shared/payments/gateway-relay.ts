// bKash and PayStation refuse connections from Cloudflare Workers, so on the Worker
// every request to them goes through the courier-relay function on Supabase (the
// same relay the courier sign-ins use), which makes the call and hands back the
// answer unchanged. The providers do not know: they are given a fetch that relays.
//
// The relay only ever calls the gateway hosts below, over HTTPS, without following
// redirects, and only for our own servers (cron secret or service key). Credentials
// in the request travel over HTTPS to our own function and are not logged.

type FetchFn = typeof fetch

/** The only hosts the relay will call. */
export const GATEWAY_HOSTS = new Set([
  'tokenized.pay.bka.sh',
  'tokenized.sandbox.bka.sh',
  'api.paystation.com.bd',
  'sandbox.paystation.com.bd',
])

const MAX_BODY = 64 * 1024
const MAX_ANSWER = 512 * 1024

export function isGatewayUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && GATEWAY_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const buffer = new ArrayBuffer(s.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return buffer
}

export interface GatewayCall {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /** Base64 of the exact request body (empty for none). */
  body: string
}

export interface GatewayAnswer {
  ok: boolean
  status?: number
  content_type?: string | null
  /** Base64 of the gateway's answer. */
  body?: string
  /** Why the gateway could not be reached (ok = false). */
  message?: string
}

export interface GatewayRelayConfig {
  /** https://<project>.supabase.co/functions/v1/courier-relay */
  url: string
  cronSecret?: string
  serviceKey?: string
  fetchFn?: FetchFn
}

/**
 * A fetch for the payment providers: gateway requests go through the relay, and
 * anything else goes straight out. Failing to reach the gateway (or the relay)
 * throws a TypeError, as a direct fetch would, so the providers report it the same way.
 */
export function relayedFetch(c: GatewayRelayConfig, direct: FetchFn): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Only a gateway request is copied: other requests (and their bodies) pass through untouched.
    const target = input instanceof Request ? input.url : String(input)
    if (!isGatewayUrl(target)) return direct(input, init)
    const req = new Request(input, init)
    const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer())
    const call: GatewayCall = {
      url: req.url, method: req.method === 'GET' ? 'GET' : 'POST',
      headers: Object.fromEntries(req.headers.entries()), body: toBase64(body),
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (c.cronSecret) headers['x-cron-secret'] = c.cronSecret
    if (c.serviceKey) headers.Authorization = `Bearer ${c.serviceKey}`
    let res: Response
    try {
      res = await (c.fetchFn ?? direct)(c.url, { method: 'POST', headers, body: JSON.stringify({ action: 'gateway', ...call }), signal: init?.signal ?? req.signal })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new TypeError(`payment relay unreachable: ${(error as Error).message}`)
    }
    const answer = (await res.json().catch(() => null)) as GatewayAnswer | null
    if (!res.ok || !answer) throw new Error(`The payment relay answered HTTP ${res.status}`)
    if (!answer.ok) throw new TypeError(answer.message || 'gateway unreachable')
    return new Response(answer.status === 204 ? null : fromBase64(answer.body ?? ''), {
      status: answer.status ?? 200,
      headers: answer.content_type ? { 'Content-Type': answer.content_type } : {},
    })
  }) as FetchFn
}

/** Request headers passed on to the gateway (the gateways' own auth headers included). */
const PASS = /^(accept|content-type|authorization|x-app-key|username|password|merchantid|token)$/i

/** The relay's side: one call to a gateway host, answered as data. */
export async function callGateway(call: GatewayCall, fetchFn: FetchFn = fetch, timeoutMs = 25_000): Promise<GatewayAnswer> {
  if (!isGatewayUrl(call.url)) return { ok: false, message: 'That address is not a payment gateway' }
  const body = fromBase64(call.body ?? '')
  if (body.byteLength > MAX_BODY) return { ok: false, message: 'The request is too large' }
  const headers = Object.fromEntries(Object.entries(call.headers ?? {}).filter(([k]) => PASS.test(k)))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(call.url, {
      method: call.method, headers, body: call.method === 'GET' ? undefined : body,
      redirect: 'manual', signal: controller.signal,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_ANSWER) return { ok: false, message: 'The gateway answer was too large' }
    return { ok: true, status: res.status, content_type: res.headers.get('content-type'), body: toBase64(bytes) }
  } catch (error) {
    return { ok: false, message: (error as Error).name === 'AbortError' ? 'the gateway did not answer in time' : (error as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

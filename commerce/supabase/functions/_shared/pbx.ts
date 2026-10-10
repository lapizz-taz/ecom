// Cloud PBX helpers. Bangladeshi cloud PBXs (VoiceDrive and most others) run
// on Asterisk / Issabel and post call events with Asterisk-style field names
// (src, dst, uniqueid, disposition, billsec…) or plainer ones (from, to,
// call_id, status, duration…). mapPbxEvent understands both; anything it
// can't place is kept in `raw` so nothing is lost.

export type PbxDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL' | 'UNKNOWN'
export type PbxStatus = 'RINGING' | 'ANSWERED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'UNKNOWN'

export interface PbxEvent {
  call_id: string
  direction: PbxDirection
  from: string | null
  to: string | null
  extension: string | null
  status: PbxStatus
  duration: number | null
  recording_url: string | null
  started_at: string | null
  ended_at: string | null
  raw: Record<string, unknown>
}

export interface PbxSettings {
  enabled?: boolean
  provider?: string
  click_mode?: 'tel' | 'api'
  api_method?: 'GET' | 'POST'
  api_url_template?: string
  api_body_template?: string
  extensions?: Array<{ profile_id: string; extension: string }>
}

const pick = (raw: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const hit = Object.keys(raw).find((k) => k.toLowerCase() === key)
    const v = hit === undefined ? undefined : raw[hit]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

function direction(v: string | null, from: string | null, to: string | null): PbxDirection {
  const d = (v ?? '').toLowerCase()
  if (/^(in|inbound|incoming)$/.test(d)) return 'INBOUND'
  if (/^(out|outbound|outgoing)$/.test(d)) return 'OUTBOUND'
  if (/^(internal|local|ext)$/.test(d)) return 'INTERNAL'
  // Without a direction: a short number on one side is an extension.
  const short = (n: string | null) => !!n && /^\d{2,5}$/.test(n)
  if (short(from) && !short(to) && to) return 'OUTBOUND'
  if (short(to) && !short(from) && from) return 'INBOUND'
  if (short(from) && short(to)) return 'INTERNAL'
  return 'UNKNOWN'
}

function status(v: string | null, duration: number | null): PbxStatus {
  const s = (v ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  if (/^(answer|answered|completed|complete|connected|success|bridged)$/.test(s)) return 'ANSWERED'
  if (/^(no_answer|noanswer|missed|unanswered|cancel|cancelled|canceled|timeout)$/.test(s)) return 'NO_ANSWER'
  if (/^(busy|user_busy)$/.test(s)) return 'BUSY'
  if (/^(failed|failure|congestion|chanunavail|error|rejected)$/.test(s)) return 'FAILED'
  if (/^(ring|ringing|start|started|dial|dialing|new|initiated)$/.test(s)) return 'RINGING'
  if (!s && duration !== null) return duration > 0 ? 'ANSWERED' : 'NO_ANSWER'
  return 'UNKNOWN'
}

function time(v: string | null): string | null {
  if (!v) return null
  if (/^\d{10}(\.\d+)?$/.test(v)) return new Date(Number(v) * 1000).toISOString()
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString()
  // "2026-10-10 14:05:00" without a zone: Asterisk writes server-local (Dhaka) time.
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/.exec(v)
  const d = new Date(local ? `${local[1]}T${local[2].length === 5 ? `${local[2]}:00` : local[2]}+06:00` : v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const cleanNumber = (n: string | null) => (n ? n.replace(/[^\d+*#]/g, '').slice(0, 40) || null : null)

/** Maps one PBX webhook payload to a call event, or null when it has no call id. */
export function mapPbxEvent(raw: Record<string, unknown>): PbxEvent | null {
  const callId = pick(raw, ['call_id', 'callid', 'uniqueid', 'unique_id', 'linkedid', 'call_uuid', 'uuid', 'id'])
  if (!callId) return null
  const from = cleanNumber(pick(raw, ['from', 'caller', 'caller_id', 'callerid', 'callerid_num', 'src', 'source', 'ani']))
  const to = cleanNumber(pick(raw, ['to', 'callee', 'called', 'dst', 'destination', 'dialed', 'dnis', 'did']))
  const durationText = pick(raw, ['duration', 'billsec', 'talk_time', 'call_duration', 'billable_seconds'])
  const duration = durationText !== null && /^\d+(\.\d+)?$/.test(durationText) ? Math.round(Number(durationText)) : null
  const recording = pick(raw, ['recording_url', 'recording', 'record_url', 'recordingfile', 'record_file'])
  return {
    call_id: callId.slice(0, 200),
    direction: direction(pick(raw, ['direction', 'call_direction', 'type', 'call_type']), from, to),
    from,
    to,
    extension: pick(raw, ['extension', 'ext', 'agent', 'agent_extension', 'exten', 'answered_by'])?.slice(0, 20) ?? null,
    status: status(pick(raw, ['status', 'disposition', 'call_status', 'event', 'state', 'hangup_cause']), duration),
    duration,
    recording_url: recording && /^https:\/\//i.test(recording) ? recording.slice(0, 500) : null,
    started_at: time(pick(raw, ['started_at', 'start', 'start_time', 'calldate', 'timestamp', 'time'])),
    ended_at: time(pick(raw, ['ended_at', 'end', 'end_time', 'hangup_time'])),
    raw,
  }
}

/** Body of a webhook: JSON, a form, or the query string of a GET. */
export async function readPbxPayload(req: Request): Promise<Record<string, unknown>> {
  const url = new URL(req.url)
  const fromQuery = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'token'))
  if (req.method === 'GET') return fromQuery
  const text = await req.text()
  if (text.length > 64 * 1024) throw new Error('Payload too large')
  const type = req.headers.get('content-type') ?? ''
  if (!text.trim()) return fromQuery
  if (type.includes('application/x-www-form-urlencoded') || (!type.includes('json') && /^[^{[]/.test(text.trim()) && text.includes('='))) {
    return { ...fromQuery, ...Object.fromEntries(new URLSearchParams(text)) }
  }
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return { ...fromQuery, ...(parsed as Record<string, unknown>) }
}

/** Only public https hosts: no IPs in private ranges, no localhost. */
export function isPublicHttps(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
  }
  if (host.startsWith('[')) return false // no literal IPv6
  return true
}

/**
 * The click-to-call request: the admin's template with {number},
 * {extension} and {secret} filled in. The secret only exists here, on the
 * server.
 */
export function buildClickRequest(settings: PbxSettings, secret: string, number: string, extension: string): { url: string; init: RequestInit } {
  const template = settings.api_url_template?.trim() ?? ''
  if (!template) throw new Error('Add the PBX click-to-call address first')
  const fill = (t: string, encode: boolean) => t.replace(/\{(number|extension|secret)\}/g, (_, k: string) => {
    const v = k === 'number' ? number : k === 'extension' ? extension : secret
    return encode ? encodeURIComponent(v) : v
  })
  const url = fill(template, true)
  if (!isPublicHttps(url)) throw new Error('The PBX address must be a public https:// address')
  const method = settings.api_method === 'POST' ? 'POST' : 'GET'
  const body = method === 'POST' && settings.api_body_template?.trim() ? fill(settings.api_body_template, false) : undefined
  const isJson = !!body && /^\s*[{[]/.test(body)
  return {
    url,
    init: {
      method,
      ...(body ? { body, headers: { 'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded' } } : {}),
      redirect: 'manual',
    },
  }
}

/** Constant-time comparison of two tokens (by their SHA-256). */
export async function sameToken(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  const ua = new Uint8Array(x)
  const ub = new Uint8Array(y)
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i]
  return diff === 0
}

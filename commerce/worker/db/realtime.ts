// Live updates on the Cloudflare database: what Supabase Realtime did for the pages
// (new orders, parcel scans, live lists). The pages keep using supabase-js
// (`supabase.channel(…).on('postgres_changes', …).subscribe()`); its WebSocket reaches
// the Database Durable Object, which speaks the same Phoenix channel protocol.
//
// Writes to the tables Supabase published for live updates are noted per request
// (writer.ts). Once the request has saved them, each subscriber is sent the rows it
// may read: every row is read again as that subscriber, through row security, so
// nobody receives a row they could not select. Deleted rows are not sent (row
// security cannot be checked on a row that is gone); no page listens for them.
import type { Context } from './context.ts'
import { mustTable } from './writer.ts'

/** Supabase's supabase_realtime publication. */
export const LIVE_TABLES: ReadonlySet<string> = new Set(['orders', 'production_orders', 'inventory', 'finance_transactions', 'checkout_leads', 'parcel_scans'])

export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE'

export interface Change {
  table: string
  type: ChangeType
  /** The primary key, column by column. */
  key: Record<string, unknown>
}

/** Remembers a write to a live table (the first kind per row wins: an insert then an update is an insert). */
export function noteChange(ctx: Context, table: string, type: ChangeType, row: Record<string, unknown>): void {
  if (!LIVE_TABLES.has(table) || type === 'DELETE') return
  const key = Object.fromEntries(mustTable(table).pk.map((c) => [c, row[c]]))
  const id = `${table}:${JSON.stringify(key)}`
  if (ctx.changes.some((c) => `${c.table}:${JSON.stringify(c.key)}` === id)) return
  ctx.changes.push({ table, type, key })
}

// --- The Phoenix channel protocol (realtime-js) -----------------------------------

export interface Message {
  joinRef: string | null
  ref: string | null
  topic: string
  event: string
  payload: Record<string, unknown>
}

/** vsn 2.0.0: [join_ref, ref, topic, event, payload]; 1.0.0: an object. */
export function decode(raw: string, vsn: string): Message | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (vsn.startsWith('2') && Array.isArray(v) && v.length === 5) {
      const [joinRef, ref, topic, event, payload] = v as [string | null, string | null, string, string, Record<string, unknown>]
      return { joinRef, ref, topic, event, payload: payload ?? {} }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { join_ref?: string; ref?: string; topic: string; event: string; payload?: Record<string, unknown> }
      return { joinRef: o.join_ref ?? null, ref: o.ref ?? null, topic: o.topic, event: o.event, payload: o.payload ?? {} }
    }
  } catch {
    // not a message
  }
  return null
}

export function encode(m: Message, vsn: string): string {
  return vsn.startsWith('2')
    ? JSON.stringify([m.joinRef, m.ref, m.topic, m.event, m.payload])
    : JSON.stringify({ join_ref: m.joinRef, ref: m.ref, topic: m.topic, event: m.event, payload: m.payload })
}

/** One postgres_changes binding of a joined channel: [topic, id, event, table, filter]. */
export type Sub = [string, number, string, string, string | null]

/** What a socket keeps across Durable Object hibernation (kept small: 2 KB at most). */
export interface SocketState {
  vsn: string
  /** The verified access token's person, session and expiry; null for a visitor. */
  uid: string | null
  sid: string | null
  exp: number
  subs: Sub[]
  next: number
}

export type VerifyToken = (token: string) => Promise<{ uid: string; sid: string; exp: number } | null>

const reply = (m: Message, status: 'ok' | 'error', response: Record<string, unknown> = {}): Message =>
  ({ joinRef: m.joinRef, ref: m.ref, topic: m.topic, event: 'phx_reply', payload: { status, response } })

async function useToken(state: SocketState, token: unknown, verify: VerifyToken): Promise<boolean> {
  if (typeof token !== 'string' || !token) return true
  const who = await verify(token)
  if (!who) return false
  state.uid = who.uid
  state.sid = who.sid
  state.exp = who.exp
  return true
}

/** Handles one client message; returns the replies to send. */
export async function handle(state: SocketState, m: Message, verify: VerifyToken): Promise<Message[]> {
  if (m.topic === 'phoenix' && m.event === 'heartbeat') return [reply(m, 'ok')]
  if (m.event === 'phx_join') {
    if (!(await useToken(state, m.payload.access_token, verify))) return [reply(m, 'error', { reason: 'Invalid token' })]
    const config = (m.payload.config ?? {}) as { postgres_changes?: Array<{ event?: string; schema?: string; table?: string; filter?: string }> }
    state.subs = state.subs.filter((s) => s[0] !== m.topic)
    const bindings = (config.postgres_changes ?? []).map((b) => {
      const id = ++state.next
      if (b.schema === 'public' && b.table && LIVE_TABLES.has(b.table) && state.subs.length < 24) {
        state.subs.push([m.topic, id, String(b.event ?? '*'), b.table, b.filter || null])
      }
      return { id, event: b.event, schema: b.schema, table: b.table, ...(b.filter !== undefined ? { filter: b.filter } : {}) }
    })
    return [reply(m, 'ok', { postgres_changes: bindings })]
  }
  if (m.event === 'access_token') {
    await useToken(state, m.payload.access_token, verify)
    return []
  }
  if (m.event === 'phx_leave') {
    state.subs = state.subs.filter((s) => s[0] !== m.topic)
    return [reply(m, 'ok')]
  }
  return []
}

/** Reads a row as a subscriber (through row security); null when it may not see it. */
export type ReadAs = (state: SocketState, table: string, search: string) => Record<string, unknown> | null

/** The messages for one socket about saved changes: only rows it may read, one per matching channel. */
export function deliveries(state: SocketState, changes: Change[], readAs: ReadAs, now = Date.now()): Message[] {
  if (state.uid && state.exp * 1000 < now) return []
  const out: Message[] = []
  const commitTimestamp = new Date(now).toISOString()
  for (const change of changes) {
    const subs = state.subs.filter((s) => s[3] === change.table && (s[2] === '*' || s[2].toUpperCase() === change.type))
    if (!subs.length) continue
    const byTopic = new Map<string, Sub[]>()
    for (const s of subs) byTopic.set(s[0], [...(byTopic.get(s[0]) ?? []), s])
    for (const [topic, list] of byTopic) {
      for (const filter of new Set(list.map((s) => s[4]))) {
        const keyFilter = Object.entries(change.key).map(([c, v]) => `${c}=eq.${encodeURIComponent(String(v))}`).join('&')
        const row = readAs(state, change.table, `select=*&${keyFilter}${filter ? `&${filter}` : ''}`)
        if (!row) continue
        out.push({
          joinRef: null, ref: null, topic, event: 'postgres_changes',
          payload: {
            ids: list.filter((s) => s[4] === filter).map((s) => s[1]),
            data: { schema: 'public', table: change.table, commit_timestamp: commitTimestamp, type: change.type, columns: [], record: row, old_record: change.type === 'UPDATE' ? change.key : {}, errors: null },
          },
        })
      }
    }
  }
  return out
}

// --- the per-visitor cap on live connections (database.ts) ---

const MAX_SOCKETS_PER_IP = 20
/** IPv6 visitors count per /48 network: one host can hold a whole /64 (or more), not one address. */
const MAX_SOCKETS_PER_V6_NETWORK = 50

/** Whose connection this is, for the per-visitor cap: an IPv4 address, or an IPv6 /48 network. */
export function socketOwner(ip: string | null): { key: string; max: number } {
  const a = (ip ?? '').trim().toLowerCase()
  if (!a.includes(':')) return { key: a.slice(0, 64) || 'unknown', max: MAX_SOCKETS_PER_IP }
  const [head, tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const full = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  const net = full.slice(0, 3).map((h) => (h || '0').replace(/^0+(?=.)/, '')).join(':')
  return /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2}$/.test(net) ? { key: `${net}::/48`, max: MAX_SOCKETS_PER_V6_NETWORK } : { key: 'unknown', max: MAX_SOCKETS_PER_IP }
}

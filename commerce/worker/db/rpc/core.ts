// Sign-in, permissions and store context: the functions every page relies on.
import { createHash } from 'node:crypto'
import { raise } from '../errors.ts'
import { Q } from '../q.ts'
import type { Values } from '../writer.ts'
import type { RpcImpl } from './index.ts'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const md5 = (text: string) => createHash('md5').update(text).digest('hex')

/** public._log_system_event: one row per distinct problem, counting repeats until resolved. */
export function logSystemEvent(q: Q, level: string, category: string, source: string, message: string, context: Values = {}): number {
  const fingerprint = md5(`${category}|${source}|${message.replace(/[0-9]+/g, '#').slice(0, 200)}`)
  const merchant = q.ctx.merchantId()
  const open = q.one<{ id: number; level: string; occurrences: number }>(
    `SELECT id, level, occurrences FROM system_logs WHERE merchant_id IS ? AND fingerprint = ? AND resolved_at IS NULL`, [merchant, fingerprint])
  if (open) {
    q.update('system_logs', {
      occurrences: open.occurrences + 1, last_seen_at: q.now, context,
      level: level.toUpperCase() === 'ERROR' ? 'ERROR' : open.level,
    }, { keys: [[open.id]] })
    return open.id
  }
  const [key] = q.insert('system_logs', {
    level: level.toUpperCase(), category: category.toUpperCase(), source: source.slice(0, 80), message: message.slice(0, 2000), context, fingerprint,
  })
  return Number(key[0])
}

/** public._platform_support_session_info */
function supportSessionInfo(q: Q): Values | null {
  const id = q.ctx.supportSessionId()
  if (!id) return null
  const s = q.one<Values>(
    `SELECT s.id, s.mode, s.reason, s.started_at, s.expires_at, s.merchant_id, s.ticket_id, ps.email, ps.full_name
       FROM support_sessions s JOIN platform_staff ps ON ps.user_id = s.staff_user_id WHERE s.id = ?`, [id])
  if (!s) return null
  const ticket = s.ticket_id ? q.one<Values>('SELECT id, number FROM support_tickets WHERE id = ?', [s.ticket_id as string]) : null
  return { id: s.id, mode: s.mode, reason: s.reason, started_at: s.started_at, expires_at: s.expires_at, merchant_id: s.merchant_id, ticket, email: s.email, full_name: s.full_name }
}

const merchantSummary = (q: Q, id: unknown) =>
  q.one<Values>('SELECT id, number, name, status FROM merchants WHERE id = ?', [id as string])

export const core: Record<string, RpcImpl> = {
  current_merchant_id: ({ ctx }) => ctx.merchantId(),
  current_role_code: ({ ctx }) => ctx.roleCode(),
  has_permission: ({ ctx, args }) => ctx.hasPermission(String(args.p_code)),
  is_staff: ({ ctx }) => ctx.isStaff(),
  is_platform_staff: ({ ctx }) => ctx.isPlatformStaff(),
  merchant_access_mode: ({ ctx, args }) => ctx.accessMode((args.p_merchant as string | undefined) ?? ctx.merchantId()),

  get_setting: ({ env, args }) => new Q(env).setting(String(args.p_key)),

  // Sign-in accounts (service role only: no grants for the API roles).
  find_auth_user_by_clerk: ({ sql, args }) =>
    sql.all('SELECT id FROM users WHERE clerk_user_id = ? ORDER BY created_at LIMIT 1', [String(args.p_clerk_id)])[0]?.id ?? null,
  find_auth_user_id: ({ sql, args }) =>
    sql.all('SELECT id FROM users WHERE email = ? LIMIT 1', [String(args.p_email).trim().toLowerCase()])[0]?.id ?? null,

  get_my_access: ({ env, ctx }) => {
    const q = new Q(env)
    const support = supportSessionInfo(q)
    if (support) {
      const { email, full_name, merchant_id, ...session } = support
      return {
        user_id: ctx.uid,
        merchant_id,
        access_mode: ctx.accessMode(merchant_id as string),
        merchant: merchantSummary(q, merchant_id),
        email, full_name,
        role: 'SUPPORT_VIEW',
        role_name: 'Platform support (view only)',
        device_blocked: false,
        device: { required: false, id: null, status: null },
        idle_logout_minutes: 0,
        pbx_click_to_call: false,
        support_session: session,
        permissions: q.raw("SELECT code FROM permissions WHERE code LIKE '%.view' ORDER BY code").map((r) => r.code),
      }
    }
    if (!ctx.uid) return null
    const p = q.one<Values>('SELECT * FROM profiles WHERE id = ? AND is_active = 1', [ctx.uid], 'profiles')
    if (!p) return null
    const r = q.one<Values>('SELECT * FROM roles WHERE id = ?', [p.role_id as string], 'roles')!
    const ok = ctx.deviceOk(String(p.id), String(r.code))
    const setting = (key: string) => {
      const v = q.value<string>('SELECT value FROM settings WHERE key = ? AND merchant_id = ?', [key, p.merchant_id as string])
      return v ? (JSON.parse(v) as Record<string, unknown>) : null
    }
    const required = setting('device_approval')?.enabled === true
    const device = ctx.identity.sessionId
      ? q.one<Values>(`SELECT d.id, d.status FROM staff_device_sessions ds JOIN staff_devices d ON d.id = ds.device_id
          WHERE ds.session_id = ? AND d.profile_id = ?`, [ctx.identity.sessionId, p.id as string])
      : null
    const pbx = setting('pbx')
    const extensions = Array.isArray(pbx?.extensions) ? (pbx!.extensions as Array<{ profile_id?: string }>) : []
    const idle = Number(setting('advanced')?.idle_logout_minutes)
    return {
      user_id: p.id,
      merchant_id: p.merchant_id,
      access_mode: ctx.accessMode(p.merchant_id as string),
      merchant: merchantSummary(q, p.merchant_id),
      email: p.email,
      full_name: p.full_name,
      role: r.code,
      role_name: r.name,
      device_blocked: !ok,
      device: { required: required && r.code !== 'OWNER', id: device?.id ?? null, status: device?.status ?? null },
      idle_logout_minutes: Number.isInteger(idle) ? idle : 0,
      pbx_click_to_call: Boolean(pbx?.enabled === true && pbx?.click_mode === 'api' && extensions.some((e) => e.profile_id === p.id)),
      permissions: !ok ? []
        : r.code === 'OWNER' ? q.raw('SELECT code FROM permissions ORDER BY code').map((x) => x.code)
          : q.raw(`SELECT pm.code FROM role_permissions rp JOIN permissions pm ON pm.id = rp.permission_id
              WHERE rp.role_id = ? ORDER BY pm.code`, [r.id as string]).map((x) => x.code),
    }
  },

  device_register: ({ env, ctx, args }) => {
    const q = new Q(env)
    const uid = ctx.uid
    if (!uid || !q.exists('SELECT 1 FROM profiles WHERE id = ? AND is_active = 1', [uid])) raise('PERMISSION_DENIED: staff only', '42501')
    if (ctx.supportSessionId()) return null
    const token = args.p_token as string | null
    if (!token || token.length < 32 || token.length > 200) raise('VALIDATION: invalid device token', '22023')
    const label = typeof args.p_label === 'string' && args.p_label.trim() ? args.p_label.trim().slice(0, 80) : null
    const cfg = q.setting('device_approval')
    const hash = sha256(token!)
    const ua = ctx.identity.userAgent?.slice(0, 300) ?? null
    const ip = ctx.identity.ip?.split(',')[0].trim().slice(0, 60) || null
    const existing = q.one<Values>('SELECT * FROM staff_devices WHERE profile_id = ? AND token_hash = ?', [uid!, hash], 'staff_devices')
    let dev: Values
    if (!existing) {
      const count = Number(q.value('SELECT count(*) FROM staff_devices WHERE profile_id = ?', [uid!]))
      if (count >= 50) raise('VALIDATION: too many devices on this account — ask an admin to clean up the list', '22023')
      const owner = ctx.roleCode() === 'OWNER'
      const first = (count === 0 && cfg.auto_approve_first !== false) || owner
      dev = q.insertOne('staff_devices', {
        profile_id: uid, token_hash: hash, label, user_agent: ua, ip,
        status: first ? 'APPROVED' : 'PENDING',
        decided_at: first ? q.now : null,
        note: first ? (owner ? 'Owner — approved automatically' : 'First device — approved automatically') : null,
      })
      if (dev.status === 'PENDING' && cfg.enabled === true) {
        const who = q.one<Values>('SELECT full_name, email FROM profiles WHERE id = ?', [uid!])
        const name = (typeof who?.full_name === 'string' && who.full_name.trim()) || String(who?.email ?? '')
        logSystemEvent(q, 'INFO', 'AUTH', 'device-approval',
          `${name} signed in from a new device (${dev.label ?? 'unknown browser'}) — waiting for approval`, { device_id: dev.id, user_id: uid })
      }
    } else {
      q.update('staff_devices', { last_seen_at: q.now, user_agent: ua ?? existing.user_agent, ip: ip ?? existing.ip, label: label ?? existing.label }, { keys: [[existing.id as string]] })
      dev = q.byKey('staff_devices', [existing.id as string])!
    }
    const session = ctx.identity.sessionId
    if (session) {
      q.insert('staff_device_sessions', { session_id: session, device_id: dev.id }, { onConflict: ['session_id'], resolution: 'merge' })
    }
    ctx.reset()
    return { id: dev.id, status: dev.status, required: cfg.enabled === true }
  },
}

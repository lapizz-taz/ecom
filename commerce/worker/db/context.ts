// Who is asking, and for which store: the TypeScript form of the Postgres helpers
// auth.uid(), current_merchant_id(), has_permission(), is_staff(), is_platform_staff(),
// _support_session_id(), _support_read_only(), current_role_code(), _device_ok() and
// merchant_access_mode(). Each answer is worked out once per request.
import type { Change } from './realtime.ts'
import { raise } from './errors.ts'
import type { Sql } from './sql.ts'

export type Role = 'anon' | 'authenticated' | 'service_role'

export interface Identity {
  role: Role
  /** users.id of the signed-in person (the Supabase account id, kept as is). */
  uid: string | null
  /** The sign-in session as a uuid (device approval binds devices to it). */
  sessionId: string | null
  email?: string | null
  /** The x-merchant-id header: the store a visitor or a staff member is looking at. */
  merchantHeader?: string | null
  /** app.merchant_id: a trusted server caller acting for one store. */
  merchantSetting?: string | null
  /** The browser's request details some functions record (device sign-ins). */
  userAgent?: string | null
  ip?: string | null
  /** The database owner with no JWT (migrations, cron, the SQL editor): no request claims at all. */
  system?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AccessMode = 'FULL' | 'READ_ONLY' | 'BLOCKED'

export class Context {
  /** Fixed for the whole request, like Postgres' now() inside a transaction. */
  readonly now: string
  /** Transaction-local switches (Postgres set_config(…, true)), e.g. store_order_import. */
  readonly flags = new Map<string, string>()
  /** Rows this request wrote to tables with live updates (realtime.ts), sent once saved. */
  readonly changes: Change[] = []
  private memo = new Map<string, unknown>()

  constructor(readonly sql: Sql, readonly identity: Identity, now = new Date()) {
    this.now = now.toISOString()
  }

  /** The HRM work gate: the migrated public._hr_gate, run by the engine (pg/engine.ts sets it). */
  static hrGate: ((ctx: Context, code: string) => string | null) | null = null

  private once<T>(key: string, fn: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, fn())
    return this.memo.get(key) as T
  }

  /** Other configuration settings (Postgres set_config / current_setting). */
  readonly settings = new Map<string, string>()

  /** Forget cached answers (after a write that changes them, e.g. a new profile). */
  reset(): void {
    this.memo.clear()
  }

  hasClaims(): boolean {
    return !this.identity.system
  }

  /** request.jwt.claims as Postgres functions read them (auth.jwt()). */
  claims(): Record<string, unknown> | null {
    if (this.identity.system) return null
    const id = this.identity
    const c: Record<string, unknown> = { role: id.role }
    if (id.role !== 'anon' && id.uid) c.sub = id.uid
    if (id.email) c.email = id.email
    if (id.sessionId) c.session_id = id.sessionId
    return c
  }

  /** current_setting(name): null when never set. */
  getSetting(name: string): string | null {
    const id = this.identity
    switch (name) {
      case 'request.jwt.claims': {
        const c = this.claims()
        return c ? JSON.stringify(c) : this.settings.get(name) ?? null
      }
      case 'request.jwt.claim.sub': return id.uid ?? ''
      case 'request.jwt.claim.role': return this.claims()?.role as string ?? ''
      case 'request.headers': {
        const h: Record<string, string> = {}
        if (id.merchantHeader) h['x-merchant-id'] = id.merchantHeader
        if (id.userAgent) h['user-agent'] = id.userAgent
        if (id.ip) h['x-forwarded-for'] = id.ip
        return JSON.stringify(h)
      }
      case 'app.merchant_id': return id.merchantSetting ?? this.settings.get(name) ?? null
      case 'role': return id.role
      default:
        if (name.startsWith('app.') && this.flags.has(name.slice(4))) return this.flags.get(name.slice(4))!
        return this.settings.get(name) ?? null
    }
  }

  /** set_config(name, value, true): changes who the request acts as when it names those settings. */
  setSetting(name: string, value: string): void {
    const id = this.identity
    this.settings.set(name, value)
    switch (name) {
      case 'app.merchant_id':
        id.merchantSetting = value || null
        break
      case 'request.jwt.claims': {
        const c = value ? (JSON.parse(value) as Record<string, unknown>) : null
        if (!c) {
          id.system = true
          id.role = 'service_role'
        } else {
          id.system = false
          id.role = (c.role === 'authenticated' || c.role === 'anon' ? c.role : 'service_role') as Role
          id.uid = typeof c.sub === 'string' ? c.sub : null
          id.email = typeof c.email === 'string' ? c.email : null
          id.sessionId = typeof c.session_id === 'string' ? c.session_id : null
        }
        break
      }
      case 'request.headers': {
        const h = value ? (JSON.parse(value) as Record<string, string>) : {}
        id.merchantHeader = h['x-merchant-id'] ?? null
        id.userAgent = h['user-agent'] ?? null
        id.ip = h['x-forwarded-for'] ?? null
        break
      }
      case 'app.store_reset':
      case 'app.erasure_request': {
        // The permanent-record triggers (SQLite) let a running store reset or an approved
        // erasure through only while its switch is on for that store.
        const flag = name === 'app.store_reset' ? 'store_reset' : 'erasure'
        this.flags.set(name.slice(4), value)
        this.sql.run('DELETE FROM _flags WHERE name = ?', [flag])
        if (value) {
          this.sql.run(name === 'app.store_reset'
            ? "INSERT OR IGNORE INTO _flags (name, value) SELECT 'store_reset', merchant_id FROM store_resets WHERE id = ? AND status = 'RUNNING'"
            : "INSERT OR IGNORE INTO _flags (name, value) SELECT 'erasure', merchant_id FROM merchant_deletion_requests WHERE id = ? AND status = 'APPROVED'", [value])
        }
        break
      }
      default:
        if (name.startsWith('app.')) this.flags.set(name.slice(4), value)
    }
    this.reset()
  }

  get role(): Role {
    return this.identity.role
  }

  get uid(): string | null {
    return this.identity.role === 'anon' ? null : this.identity.uid
  }

  /** is_system_context(): the service role (server code with the service key). */
  isSystem(): boolean {
    return this.identity.role === 'service_role'
  }

  isPlatformStaff(): boolean {
    return this.once('platform_staff', () => this.role === 'authenticated' && this.uid !== null &&
      this.sql.all('SELECT 1 FROM platform_staff WHERE user_id = ? AND is_active = 1', [this.uid]).length > 0)
  }

  supportSessionId(): string | null {
    return this.once('support_session', () => {
      if (this.role !== 'authenticated' || !this.uid) return null
      const row = this.sql.all(
        `SELECT s.id FROM support_sessions s
           JOIN platform_staff ps ON ps.user_id = s.staff_user_id AND ps.is_active = 1
          WHERE s.staff_user_id = ? AND s.ended_at IS NULL AND s.expires_at > ?
          ORDER BY s.started_at DESC LIMIT 1`, [this.uid, this.now])[0]
      return (row?.id as string | undefined) ?? null
    })
  }

  merchantId(): string | null {
    return this.once('merchant', () => {
      const role = this.role
      const setting = this.identity.merchantSetting?.trim() || null
      if (setting && (role === 'service_role' || (role === 'authenticated' && this.isPlatformStaff()))) {
        if (!UUID.test(setting)) raise('INVALID_MERCHANT_CONTEXT: app.merchant_id is not a merchant id', '22023')
        return setting.toLowerCase()
      }
      if (role === 'authenticated' && this.uid) {
        const support = this.supportSessionId()
        if (support) {
          const s = this.sql.all('SELECT merchant_id FROM support_sessions WHERE id = ?', [support])[0]
          if (s?.merchant_id) return s.merchant_id as string
        }
        const p = this.sql.all('SELECT merchant_id FROM profiles WHERE id = ?', [this.uid])[0]
        if (p?.merchant_id) return p.merchant_id as string
      }
      const header = this.identity.merchantHeader?.trim()
      if (header && UUID.test(header)) {
        const m = this.sql.all("SELECT id FROM merchants WHERE id = ? AND status <> 'CLOSED'", [header.toLowerCase()])[0]
        return (m?.id as string | undefined) ?? null
      }
      return null
    })
  }

  /** The signed-in person's role code in the current store (OWNER, ADMIN, …). */
  roleCode(): string | null {
    return this.once('role_code', () => {
      if (!this.uid) return null
      const r = this.sql.all(
        `SELECT r.code FROM profiles p JOIN roles r ON r.id = p.role_id
          WHERE p.id = ? AND p.is_active = 1 AND p.merchant_id = ?`, [this.uid, this.merchantId()])[0]
      return (r?.code as string | undefined) ?? null
    })
  }

  /** Device approval: on when the store requires it, except for the owner. */
  deviceOk(profileId: string, roleCode: string): boolean {
    if (roleCode === 'OWNER') return true
    return this.once(`device:${profileId}`, () => {
      const s = this.sql.all(
        `SELECT s.value FROM settings s JOIN profiles p ON p.merchant_id = s.merchant_id
          WHERE p.id = ? AND s.key = 'device_approval'`, [profileId])[0]
      const enabled = s ? (JSON.parse(String(s.value)) as { enabled?: unknown }).enabled === true : false
      if (!enabled) return true
      if (!this.identity.sessionId) return false
      return this.sql.all(
        `SELECT 1 FROM staff_device_sessions ds JOIN staff_devices d ON d.id = ds.device_id
          WHERE ds.session_id = ? AND d.profile_id = ? AND d.status = 'APPROVED'`, [this.identity.sessionId, profileId]).length > 0
    })
  }

  accessMode(merchant: string | null = this.merchantId()): AccessMode {
    return this.once(`access:${merchant}`, () => {
      if (!merchant) return 'BLOCKED'
      const rulesRow = this.sql.all("SELECT value FROM platform_settings WHERE key = 'access_rules'")[0]
      const rules = (rulesRow ? JSON.parse(String(rulesRow.value)) : {}) as Record<string, AccessMode | undefined>
      const m = this.sql.all('SELECT status, onboarding FROM merchants WHERE id = ?', [merchant])[0]
      const status = m?.status as string | undefined
      if (!status || status === 'CLOSED') return 'BLOCKED'
      // A new business waiting for its first payment or for the team to activate it.
      const activation = m.onboarding ? (JSON.parse(String(m.onboarding)) as { activation?: string }).activation : undefined
      if (activation === 'awaiting_payment' || activation === 'awaiting_whatsapp') return 'BLOCKED'
      const a = status === 'SUSPENDED' ? rules.MERCHANT_SUSPENDED ?? 'BLOCKED' : status === 'ONBOARDING' ? rules.MERCHANT_ONBOARDING ?? 'FULL' : 'FULL'
      // The current subscription; when none, the last one that ended.
      const s = this.sql.all(
        `SELECT id, status, grace_until, intro_until, current_period_end FROM subscriptions WHERE merchant_id = ?
          ORDER BY (ended_at IS NULL) DESC, ended_at IS NULL, ended_at DESC, created_at DESC LIMIT 1`, [merchant])[0]
      const key = !s ? 'NO_SUBSCRIPTION'
        // The new-business offer ended and the payment to continue is not made.
        : s.status === 'PAST_DUE' && s.intro_until != null && (s.current_period_end == null || String(s.current_period_end) <= String(s.intro_until)) ? 'TRIAL_ENDED'
        : s.status === 'PAST_DUE' && s.grace_until && String(s.grace_until) < this.now ? 'PAST_DUE_AFTER_GRACE'
          : String(s.status)
      const b = rules[key] ?? (key === 'TRIAL_ENDED' ? 'BLOCKED' : 'FULL')
      return [a, b].includes('BLOCKED') ? 'BLOCKED' : [a, b].includes('READ_ONLY') ? 'READ_ONLY' : 'FULL'
    })
  }

  hasPermission(code: string): boolean {
    return this.once(`perm:${code}`, () => {
      const merchant = this.merchantId()
      let own = false
      if (this.uid && merchant) {
        const p = this.sql.all(
          `SELECT p.id, r.id AS role_id, r.code FROM profiles p JOIN roles r ON r.id = p.role_id
            WHERE p.id = ? AND p.merchant_id = ? AND p.is_active = 1`, [this.uid, merchant])[0]
        if (p && this.deviceOk(String(p.id), String(p.code))) {
          own = p.code === 'OWNER' || this.sql.all(
            `SELECT 1 FROM role_permissions rp JOIN permissions pm ON pm.id = rp.permission_id
              WHERE rp.role_id = ? AND pm.code = ?`, [p.role_id as string, code]).length > 0
        }
        if (own) {
          const mode = this.accessMode()
          own = mode === 'FULL' || (mode === 'READ_ONLY' && (code.endsWith('.view') || code.endsWith('.export')))
        }
        // As in Postgres: not checked in (or on a break) while the store requires it, no changes.
        if (own && Context.hrGate) own = Context.hrGate(this, code) === null
      }
      if (own) return true
      const support = this.supportSessionId()
      if (!support) return false
      const s = this.sql.all('SELECT merchant_id, mode, permissions FROM support_sessions WHERE id = ?', [support])[0]
      if (!s || s.merchant_id !== merchant) return false
      if (code.endsWith('.view')) return true
      return s.mode === 'ASSIST' && (JSON.parse(String(s.permissions ?? '[]')) as string[]).includes(code)
    })
  }

  isStaff(): boolean {
    return this.once('is_staff', () => {
      const merchant = this.merchantId()
      if (this.uid && merchant) {
        const p = this.sql.all(
          `SELECT p.id, r.code FROM profiles p JOIN roles r ON r.id = p.role_id
            WHERE p.id = ? AND p.merchant_id = ? AND p.is_active = 1`, [this.uid, merchant])[0]
        if (p && this.deviceOk(String(p.id), String(p.code)) && this.accessMode() !== 'BLOCKED') return true
      }
      const support = this.supportSessionId()
      if (!support) return false
      return this.sql.all('SELECT 1 FROM support_sessions WHERE id = ? AND merchant_id = ?', [support, merchant]).length > 0
    })
  }

  /** A platform staff member viewing a store in read-only support mode. */
  supportReadOnly(): boolean {
    return this.once('support_read_only', () => {
      const support = this.supportSessionId()
      if (!support) return false
      return this.sql.all("SELECT 1 FROM support_sessions WHERE id = ? AND mode = 'VIEW'", [support]).length > 0
    })
  }

  requirePermission(code: string): void {
    if (this.isSystem() || this.hasPermission(code)) return
    raise(`PERMISSION_DENIED: ${code} is required`, '42501')
  }
}

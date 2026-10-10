// VoiceDrive PBX client. Procedure names follow the module's API
// (pbx.getMyWebRtcCredentials, pbx.startManualPbxCall …); each maps to a
// permission-checked database function or the voicedrive edge function.
// Several reads on page load go in one request through pbx.batch().
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}

// ------------------------------------------------------------------ types
export type LineProblem = 'NOT_ENABLED' | 'NO_NUMBER' | 'BRIDGE_NOT_READY' | 'NO_PACKAGE' | 'MAINTENANCE' | 'NOT_FOUND'
export type CallStatus = 'REQUESTED' | 'RINGING' | 'ANSWERED' | 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELLED' | 'REJECTED'
export type CallOutcome = 'CONFIRMED' | 'CALL_BACK' | 'NOT_REACHABLE' | 'WRONG_NUMBER' | 'CANCEL_REQUEST' | 'RESOLVED' | 'OTHER'
export type CallKind = 'MANUAL' | 'APPROVED_ORDER' | 'WEB_ORDER' | 'CALLBACK' | 'INBOUND'

export interface Limits {
  active: boolean
  packageCode: string | null
  packageName: string | null
  agents: number
  channels: number
  extraAgents?: number
  extraChannels?: number
  startsAt?: string
  expiresAt: string | null
}

export interface Maintenance { state: 'none' | 'scheduled' | 'active'; startsAt: string | null; until: string | null; message?: string | null }

export interface Overview {
  business: { id: string; code: number; name: string; did: string | null; callerId: string | null; pbxEnabled: boolean; bridgeReady: boolean; maxCallMinutes: number; isPrimary: boolean }
  lineStatus: 'ACTIVE' | 'INACTIVE'
  lineProblems: LineProblem[]
  limits: Limits
  balanceTk: number
  agentsUsed: number
  channelsInUse: number
  maintenance: Maintenance
  me: { agentId: string; extension: string; sipUsername: string; active: boolean; seated: boolean } | null
  canManage: boolean
  isSuperAdmin: boolean
  gateway: { lastSeenAt: string | null; version: string | null; online: boolean }
}

export interface Package { id: string; code: string; name: string; monthlyPriceTk: number | null; agentLimit: number | null; concurrentChannels: number | null; isCustom: boolean }
export interface PackageList {
  packages: Package[]
  extraAgentTk: number
  extraChannelTk: number
  ratePerMinTk: number
  vatPercent: number
  effectivePerMinTk: number
  minTopupTk: number
  maxTopupTk: number
}

export interface CallRecord {
  id: string
  createdAt: string
  status: CallStatus
  outcome: CallOutcome | null
  outcomeNote: string | null
  direction: 'INBOUND' | 'OUTBOUND'
  kind: CallKind
  orderId: string | null
  orderNumber: string | null
  customerPhone: string | null
  normalizedCustomerPhone: string | null
  callerId: string | null
  did: string | null
  agentExtension: string | null
  agentName: string | null
  startedAt: string | null
  answeredAt: string | null
  endedAt: string | null
  billedSeconds: number | null
  costTk: number | null
  vatTk: number | null
  chargedTk: number | null
  maxSeconds: number | null
  rejectReason: string | null
  hangupCause: string | null
  callbackOf: string | null
  calledBack: boolean
}
export type CallRequest = CallRecord & { dial: string; expiresInSeconds: number }

export interface WebRtcCredentials {
  sipUri: string
  aor: string
  authorizationUsername: string
  password: string
  wssUrl: string
  iceServers: RTCIceServer[]
  extension: string
  displayName: string
  expiresAt: string
  ttlSeconds: number
}

export interface Registration {
  hasExtension: boolean
  extension?: string
  sipUsername?: string
  registered: boolean
  registrationState?: string | null
  status?: 'AVAILABLE' | 'AWAY' | 'OFFLINE'
  lastHeartbeatAt?: string | null
  credentialExpiresAt?: string | null
}

export interface Eligibility { eligible: boolean; reasons: string[]; extension?: string; ringGroupId?: string | null }

export interface CallerContext {
  phone: string
  known: boolean
  name: string | null
  customer: { id: string; name: string; district: string | null; totalOrders: number; deliveredOrders: number; cancelledOrders: number; returnedOrders: number; totalSpent: number; lastOrderAt: string | null; notes: string | null } | null
  orders: Array<{ id: string; orderNumber: string; status: string; totalAmount: number; paymentStatus: string; createdAt: string }>
  previousCalls: number
}

export interface CallerOrderDetail {
  id: string
  orderNumber: string
  status: string
  paymentMethod: string
  paymentStatus: string
  totalAmount: number
  amountPaid: number
  codAmount: number
  customerName: string
  shippingAddress: string
  shippingDistrict: string
  createdAt: string
  confirmedAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  customerNote: string | null
  items: Array<{ name: string; variant: string | null; quantity: number; lineTotal: number; imageUrl: string | null }>
  shipment: { courier: string; status: string; trackingNumber: string | null; trackingUrl: string | null } | null
}

export interface CourierRating {
  phone: string
  checked: boolean
  checkedAt?: string
  successRate?: number | null
  riskLevel?: string | null
  totalParcels?: number
  delivered?: number
  cancelled?: number
  returned?: number
}

export interface Agent {
  id: string
  profileId: string
  name: string
  email: string
  extension: string
  sipUsername: string
  ringGroupId: string | null
  inboundEnabled: boolean
  active: boolean
  seated: boolean
  online: boolean
  status: 'AVAILABLE' | 'AWAY' | 'OFFLINE'
  lastSeenAt: string | null
  onCall: boolean
}
export interface AgentList { agents: Agent[]; staff: Array<{ profileId: string; name: string; email: string }>; seats: number }

export interface RingGroup { id: string; name: string; strategy: 'RING_ALL' | 'LONGEST_IDLE'; ringSeconds: number; isDefault: boolean; active: boolean; agents: number }

export interface BillingHistory {
  ledger: Array<{ id: string; kind: 'TOPUP' | 'CALL_CHARGE' | 'ADJUSTMENT'; amountTk: number; balanceAfterTk: number; note: string | null; callId: string | null; createdAt: string }>
  payments: Array<{ id: string; type: 'PACKAGE' | 'TOPUP'; amountTk: number; status: string; trxId: string | null; reference: string; createdAt: string; completedAt: string | null; package: string | null; failureReason: string | null }>
  subscriptions: Array<{ id: string; package: string; agents: number; channels: number; startsAt: string; expiresAt: string; status: string; source: string; amountTk: number }>
}

export interface Reports {
  totals: { calls: number; outbound: number; inbound: number; answered: number; missed: number; talkSeconds: number; billedSeconds: number; chargedTk: number }
  byDay: Array<{ day: string; calls: number; answered: number; missed: number; chargedTk: number }>
  byAgent: Array<{ agentId: string | null; name: string; extension: string | null; calls: number; outbound: number; inbound: number; answered: number; talkSeconds: number; chargedTk: number }>
  recent: CallRecord[]
}

export interface OrderCallState { lastStatus: CallStatus; lastOutcome: CallOutcome | null; lastAt: string; attempts: number; answered: number; live: boolean }
export interface CallStateAvailability { lineActive: boolean; lineProblems: LineProblem[]; canCall: boolean; hasExtension: boolean }

export interface AdminBusiness {
  id: string
  code: number
  name: string
  isPrimary: boolean
  did: string | null
  callerId: string | null
  trunkHost: string | null
  trunkPort: number
  trunkTransport: 'udp' | 'tcp' | 'tls'
  trunkUser: string | null
  trunkRegister: boolean
  trunkSecretSet: boolean
  dialFormat: 'LOCAL' | 'E164' | 'E164_NO_PLUS'
  maxCallMinutes: number
  pbxEnabled: boolean
  bridgeReady: boolean
  bridgeReadyAt: string | null
  limits: Limits
  balanceTk: number
  agents: number
  members: number
  lineProblems: LineProblem[]
}
export interface AdminOverview {
  businesses: AdminBusiness[]
  gateway: { lastSeenAt: string | null; version: string | null; online: boolean; detail: { trunks?: Array<{ name: string; state: string }>; softphonesOnline?: number; activeCalls?: number } }
  settings: { sipDomain: string | null; wssUrl: string | null; stunUrls: string[]; turnUrls: string[]; turnTtlSeconds: number; credentialTtlSeconds: number; ratePerMinTk: number; vatPercent: number; minTopupTk: number; maintenance: { starts_at: string | null; until: string | null; message: string | null } }
  secrets: { gatewayToken: { hint: string; at: string } | null; turnSecret: { hint: string; at: string } | null }
  packages: Package[]
  staff: Array<{ profileId: string; name: string; email: string; businessId: string | null }>
}

// ------------------------------------------------------------------ batch
const BATCHABLE = {
  overview: null as unknown as Overview,
  maintenanceStatus: null as unknown as Maintenance,
  packages: null as unknown as PackageList,
  getInboundPhoneEligibility: null as unknown as Eligibility,
  getMyBrowserPhoneRegistration: null as unknown as Registration,
  getMyActiveInboundBrowserCall: null as unknown as CallRecord | null,
  getMyOutgoingCallRequestState: null as unknown as CallRecord | null,
  getRecentMissedInboundCalls: null as unknown as { items: CallRecord[] },
  getOrderCallStateAvailability: null as unknown as CallStateAvailability,
  listAgents: null as unknown as AgentList,
  listRingGroups: null as unknown as RingGroup[],
  billingHistory: null as unknown as BillingHistory,
}
export type BatchKey = keyof typeof BATCHABLE
export type BatchResult<K extends BatchKey> = { [P in K]: { result?: (typeof BATCHABLE)[P]; error?: { code: string; message: string } } }

/** Runs several read procedures in one request; each key gets its result or its own error. */
export function batch<K extends BatchKey>(calls: Partial<Record<K, Record<string, unknown>>>): Promise<BatchResult<K>> {
  return rpc<BatchResult<K>>('pbx_batch', { p_calls: calls })
}

// ------------------------------------------------------------------ procedures
export const pbx = {
  // credentials / softphone
  getMyWebRtcCredentials: () => invokeFunction<WebRtcCredentials>('voicedrive', { action: 'getMyWebRtcCredentials', userAgent: navigator.userAgent }),
  getMyBrowserPhoneRegistration: () => rpc<Registration>('pbx_get_my_browser_phone_registration'),

  // presence
  setInboundPhonePresence: (p: { status: 'AVAILABLE' | 'AWAY'; registered: boolean; registrationState?: string }) =>
    rpc<Eligibility & { status: string }>('pbx_set_inbound_phone_presence', { p_status: p.status, p_registered: p.registered, p_registration_state: p.registrationState ?? null, p_user_agent: navigator.userAgent.slice(0, 300) }),
  clearInboundPhonePresence: () => rpc<void>('pbx_clear_inbound_phone_presence'),
  getInboundPhoneEligibility: () => rpc<Eligibility>('pbx_get_inbound_phone_eligibility'),

  // outbound
  startManualPbxCall: (phone: string) => rpc<CallRequest>('pbx_start_manual_call', { p_phone: phone, p_callback_of: null }),
  startCallback: (missedCallId: string, phone?: string) => rpc<CallRequest>('pbx_start_manual_call', { p_phone: phone ?? null, p_callback_of: missedCallId }),
  startApprovedOrderCall: (orderId: string) => rpc<CallRequest>('pbx_start_approved_order_call', { p_order_id: orderId }),
  startWebOrderCall: (orderId: string) => rpc<CallRequest>('pbx_start_web_order_call', { p_order_id: orderId }),
  endWebOrderCall: (callId: string, outcome?: CallOutcome | null, note?: string) => rpc<CallRecord>('pbx_end_call', { p_call_id: callId, p_outcome: outcome ?? null, p_note: note ?? null }),
  cancelWebOrderCall: (callId: string) => rpc<CallRecord>('pbx_cancel_call', { p_call_id: callId }),
  getManualCallState: (callId: string) => rpc<CallRecord>('pbx_get_call_state', { p_call_id: callId }),
  getApprovedOrderCallState: (callId: string) => rpc<CallRecord>('pbx_get_call_state', { p_call_id: callId }),
  getWebOrderCallState: (callId: string) => rpc<CallRecord>('pbx_get_call_state', { p_call_id: callId }),
  getMyOutgoingCallRequestState: () => rpc<CallRecord | null>('pbx_get_my_outgoing_call_request_state'),

  // inbound
  getMyActiveInboundBrowserCall: () => rpc<CallRecord | null>('pbx_get_my_active_inbound_call'),
  resolveInboundCallerContext: (phone: string) => rpc<CallerContext>('pbx_resolve_inbound_caller_context', { p_phone: phone }),
  getInboundCallerOrderDetail: (phone: string) => rpc<CallerOrderDetail | null>('pbx_get_inbound_caller_order_detail', { p_phone: phone }),
  resolveInboundCallerCourierRating: (phone: string) => rpc<CourierRating>('pbx_resolve_inbound_caller_courier_rating', { p_phone: phone }),
  getRecentMissedInboundCalls: (limit = 50) => rpc<{ items: CallRecord[] }>('pbx_get_recent_missed_inbound_calls', { p_limit: limit }),
  /** My calls and the business's missed calls of the last 7 days (the phone bar's list). */
  getMyRecentCalls: (limit = 30) => rpc<{ items: CallRecord[] }>('pbx_get_my_recent_calls', { p_limit: limit }),

  // telemetry (never used for billing)
  recordCallAttemptTrace: (callId: string | null, event: string, detail: Record<string, unknown> = {}) =>
    rpc<void>('pbx_record_call_attempt_trace', { p_call_id: callId, p_event: event, p_detail: detail }),
  reportCallQuality: (callId: string | null, stats: Record<string, unknown>) => rpc<void>('pbx_report_call_quality', { p_call_id: callId, p_stats: stats }),

  // overview / business admin
  overview: (businessId?: string) => rpc<Overview>('pbx_overview', { p_business_id: businessId ?? null }),
  packages: () => rpc<PackageList>('pbx_packages_list'),
  listAgents: (businessId?: string) => rpc<AgentList>('pbx_list_agents', { p_business_id: businessId ?? null }),
  saveAgent: (p: { id?: string; profile_id?: string; extension?: string; ring_group_id?: string | null; inbound_enabled?: boolean; active?: boolean; business_id?: string }) =>
    rpc<unknown>('pbx_save_agent', { p }),
  removeAgent: (agentId: string) => rpc<void>('pbx_remove_agent', { p_agent_id: agentId }),
  listRingGroups: (businessId?: string) => rpc<RingGroup[]>('pbx_list_ring_groups', { p_business_id: businessId ?? null }),
  saveRingGroup: (p: { id?: string; name?: string; strategy?: RingGroup['strategy']; ring_seconds?: number; active?: boolean; business_id?: string }) =>
    rpc<unknown>('pbx_save_ring_group', { p }),
  setBusinessSettings: (p: { max_call_minutes: number; business_id?: string }) => rpc<{ maxCallMinutes: number }>('pbx_set_business_settings', { p }),
  billingHistory: (businessId?: string) => rpc<BillingHistory>('pbx_billing_history', { p_business_id: businessId ?? null, p_limit: 100 }),
  reports: (from: string, to: string, businessId?: string) => rpc<Reports>('pbx_reports', { p_from: from, p_to: to, p_business_id: businessId ?? null }),
  bkashStart: (p: { type: 'PACKAGE' | 'TOPUP'; package_id?: string; extra_agents?: number; extra_channels?: number; months?: number; amount_tk?: number; business_id?: string }) =>
    invokeFunction<{ reference: string; amountTk: number; redirectUrl: string }>('voicedrive', { action: 'bkashStart', ...p }),
}

/** Call state for order list views (separate group, like pbxCallState). */
export const pbxCallState = {
  getOrderCallStates: (orderIds: string[]) => rpc<Record<string, OrderCallState>>('pbx_get_order_call_states', { p_order_ids: orderIds }),
  getWebOrderCallStates: (orderIds: string[]) => rpc<Record<string, OrderCallState>>('pbx_get_order_call_states', { p_order_ids: orderIds }),
  getOrderCallStateAvailability: () => rpc<CallStateAvailability>('pbx_get_order_call_state_availability'),
}

export const pbxMaintenance = {
  status: () => rpc<Maintenance>('pbx_maintenance_status'),
}

/** Super Admin only (checked in the database and the edge function). */
export const pbxSuperAdmin = {
  overview: () => rpc<AdminOverview>('pbx_admin_list_businesses'),
  saveBusiness: (p: { id?: string; name: string }) => rpc<{ id: string }>('pbx_admin_save_business', { p }),
  provisionBusinessDid: (p: { business_id: string; did: string; caller_id?: string; trunk_host: string; trunk_port?: number; trunk_transport?: string; trunk_user?: string; trunk_register?: boolean; dial_format?: string; pbx_enabled?: boolean }) =>
    rpc<{ id: string; bridgeReady: boolean }>('pbx_provision_business_did', { p }),
  saveTrunkSecret: (businessId: string, password: string) => invokeFunction<{ ok: true }>('voicedrive', { action: 'saveTrunkSecret', business_id: businessId, password }),
  setPbxBridgeReady: (businessId: string, ready: boolean) => rpc<{ bridgeReady: boolean }>('pbx_set_pbx_bridge_ready', { p_business_id: businessId, p_ready: ready }),
  setMember: (profileId: string, businessId: string | null) => rpc<void>('pbx_admin_set_member', { p_profile_id: profileId, p_business_id: businessId }),
  grantPackage: (p: { business_id: string; package_id: string; months: number; extra_agents?: number; extra_channels?: number; agents?: number; channels?: number; amount_tk?: number; note?: string }) =>
    rpc<unknown>('pbx_admin_grant_package', { p }),
  adjustBalance: (businessId: string, amount: number, note: string) => rpc<{ balanceTk: number }>('pbx_admin_adjust_balance', { p_business_id: businessId, p_amount: amount, p_note: note }),
  saveSettings: (p: Record<string, unknown>) => rpc<unknown>('pbx_admin_save_settings', { p }),
  saveTurnSecret: (secret: string) => invokeFunction<{ ok: true }>('voicedrive', { action: 'saveTurnSecret', secret }),
  rotateGatewayToken: () => invokeFunction<{ token: string }>('voicedrive', { action: 'rotateGatewayToken' }),
}

// ------------------------------------------------------------------ labels
export const LINE_PROBLEM: Record<LineProblem, string> = {
  NOT_ENABLED: 'PBX is not switched on for this business (Super Admin)',
  NO_NUMBER: 'No phone number (DID) or SIP trunk yet (Super Admin)',
  BRIDGE_NOT_READY: 'The PBX bridge is not confirmed ready (Super Admin)',
  NO_PACKAGE: 'No active package — buy one under Package & Recharge',
  MAINTENANCE: 'VoiceDrive is under maintenance',
  NOT_FOUND: 'Business not found',
}

export const REJECT_REASON: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Outgoing balance is too low — recharge with bKash',
  CHANNEL_LIMIT: 'All call channels are busy',
  NO_SEAT: 'No free agent seat',
  NUMBER_MISMATCH: 'The number dialled was not the one requested',
  REQUEST_EXPIRED: 'The call request expired — try again',
  NO_REQUEST: 'The call was not requested from the app',
  REQUEST_USED: 'This call request was already used',
  NOT_ENABLED: 'PBX is switched off',
  BRIDGE_NOT_READY: 'The PBX bridge is not ready',
  NO_PACKAGE: 'No active package',
  MAINTENANCE: 'VoiceDrive is under maintenance',
  REPLACED: 'Replaced by a newer call',
  CANCELLED_BY_AGENT: 'Cancelled',
  UNKNOWN_NUMBER: 'Unknown business number',
}

export const CALL_STATUS: Record<CallStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  REQUESTED: { label: 'Dialling', variant: 'info' },
  RINGING: { label: 'Ringing', variant: 'info' },
  ANSWERED: { label: 'In call', variant: 'success' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  NO_ANSWER: { label: 'No answer', variant: 'warning' },
  BUSY: { label: 'Busy', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'danger' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
  REJECTED: { label: 'Not connected', variant: 'danger' },
}

export const OUTCOMES: Array<{ value: CallOutcome; label: string }> = [
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'CALL_BACK', label: 'Call back later' },
  { value: 'NOT_REACHABLE', label: 'Not reachable' },
  { value: 'WRONG_NUMBER', label: 'Wrong number' },
  { value: 'CANCEL_REQUEST', label: 'Wants to cancel' },
  { value: 'RESOLVED', label: 'Question answered' },
  { value: 'OTHER', label: 'Other' },
]

export const durationLabel = (s: number | null | undefined) =>
  s === null || s === undefined ? '—' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`

// The browser phone: SIP.js over WSS to the VoiceDrive gateway.
//
// Credentials are fetched from the server each time the phone starts and are
// short-lived; the phone renews them (re-registering) before they expire,
// never while a call is up. Nothing here decides what a call costs: the
// gateway times calls and the server charges them.
import { Invitation, Inviter, Registerer, RegistererState, type Session, SessionState, UserAgent } from 'sip.js'
import { pbx, type CallRequest, type WebRtcCredentials } from '@/services/voicedrive'

export type PhoneStatus = 'off' | 'starting' | 'ready' | 'reconnecting' | 'error'
export type Availability = 'AVAILABLE' | 'AWAY'

export interface PhoneCall {
  direction: 'in' | 'out'
  callId: string | null
  number: string
  orderId: string | null
  state: 'dialing' | 'ringing' | 'incoming' | 'active' | 'ended'
  startedAt: number
  answeredAt: number | null
  endedAt: number | null
  muted: boolean
  endReason: string | null
}

export interface PhoneState {
  status: PhoneStatus
  availability: Availability
  extension: string | null
  error: string | null
  call: PhoneCall | null
  credentialExpiresAt: string | null
}

const HEARTBEAT_MS = 20_000
const RENEW_BEFORE_MS = 120_000

function trace(callId: string | null, event: string, detail: Record<string, unknown> = {}) {
  pbx.recordCallAttemptTrace(callId, event, detail).catch((error: unknown) => console.warn('VoiceDrive trace not sent', error))
}

export class Softphone {
  private state: PhoneState = { status: 'off', availability: 'AVAILABLE', extension: null, error: null, call: null, credentialExpiresAt: null }
  private readonly listeners = new Set<() => void>()
  private ua: UserAgent | null = null
  private registerer: Registerer | null = null
  private session: Session | null = null
  private creds: WebRtcCredentials | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private ringer: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null
  private readonly audio: HTMLAudioElement
  private stopping = false

  constructor() {
    this.audio = document.createElement('audio')
    this.audio.autoplay = true
    this.audio.setAttribute('aria-hidden', 'true')
    document.body.appendChild(this.audio)
  }

  // ------------------------------------------------------------ store
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getState = () => this.state
  private set(patch: Partial<PhoneState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }
  private setCall(patch: Partial<PhoneCall> | null) {
    this.set({ call: patch === null ? null : { ...(this.state.call as PhoneCall), ...patch } })
  }

  // ------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'ready') return
    this.stopping = false
    remember(true)
    this.set({ status: 'starting', error: null })
    try {
      // Ask for the microphone up front so a call doesn't fail on the permission prompt.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
    } catch {
      this.set({ status: 'error', error: 'Microphone blocked — allow it in the browser to use the phone' })
      trace(null, 'mic_denied')
      return
    }
    try {
      await this.connect()
    } catch (error) {
      this.set({ status: 'error', error: (error as Error).message })
      trace(null, 'start_failed', { message: (error as Error).message })
    }
  }

  private async connect(): Promise<void> {
    const creds = await pbx.getMyWebRtcCredentials()
    this.creds = creds
    const ua = new UserAgent({
      uri: UserAgent.makeURI(creds.sipUri),
      displayName: creds.displayName,
      authorizationUsername: creds.authorizationUsername,
      authorizationPassword: creds.password,
      transportOptions: { server: creds.wssUrl, connectionTimeout: 10 },
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: creds.iceServers } },
      logLevel: 'error',
      userAgentString: 'VoiceDrive Web',
      delegate: {
        onInvite: (inv) => this.onInvite(inv),
        onDisconnect: (error) => {
          if (this.stopping) return
          trace(this.state.call?.callId ?? null, 'transport_lost', { message: error?.message })
          this.set({ status: 'reconnecting' })
          void this.reconnect()
        },
      },
    })
    this.ua = ua
    await ua.start()
    const reg = new Registerer(ua, { expires: 120 })
    this.registerer = reg
    reg.stateChange.addListener((s) => {
      trace(null, `registration_${s.toLowerCase()}`)
      if (s === RegistererState.Registered) {
        this.set({ status: 'ready', extension: creds.extension, credentialExpiresAt: creds.expiresAt, error: null })
        void this.beat()
      } else if (s === RegistererState.Unregistered && !this.stopping) {
        this.set({ status: 'reconnecting' })
      }
    })
    await reg.register({
      requestDelegate: {
        onReject: (response) => {
          this.set({ status: 'error', error: `The gateway refused the phone (${response.message.statusCode} ${response.message.reasonPhrase})` })
          trace(null, 'registration_rejected', { code: response.message.statusCode })
        },
      },
    })
    if (!this.heartbeat) this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
    this.scheduleRenew(creds)
  }

  /** New credentials before the old ones expire; never in the middle of a call. */
  private scheduleRenew(creds: WebRtcCredentials) {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    const ms = Math.max(30_000, new Date(creds.expiresAt).getTime() - Date.now() - RENEW_BEFORE_MS)
    this.renewTimer = setTimeout(() => void this.renew(), ms)
  }

  private async renew() {
    if (this.stopping) return
    if (this.state.call && this.state.call.state !== 'ended') {
      this.renewTimer = setTimeout(() => void this.renew(), 30_000)
      return
    }
    trace(null, 'credential_renew')
    await this.teardown(false)
    try {
      await this.connect()
    } catch (error) {
      this.set({ status: 'error', error: (error as Error).message })
    }
  }

  private async reconnect() {
    await this.teardown(false)
    for (const wait of [1_000, 3_000, 10_000, 30_000]) {
      if (this.stopping) return
      await new Promise((r) => setTimeout(r, wait))
      try {
        await this.connect()
        return
      } catch (error) {
        this.set({ status: 'reconnecting', error: (error as Error).message })
      }
    }
    this.set({ status: 'error', error: 'Could not reach the phone gateway. Check the internet connection and start the phone again.' })
  }

  async stop(): Promise<void> {
    this.stopping = true
    remember(false)
    await this.hangup().catch(() => undefined)
    await this.teardown(true)
    pbx.clearInboundPhonePresence().catch(() => undefined)
    this.set({ status: 'off', extension: null, credentialExpiresAt: null })
  }

  private async teardown(final: boolean) {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    if (final && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    try { await this.registerer?.unregister() } catch { /* already gone */ }
    try { await this.ua?.stop() } catch { /* already stopped */ }
    this.registerer = null
    this.ua = null
  }

  async setAvailability(a: Availability) {
    this.set({ availability: a })
    await this.beat()
  }

  private async beat() {
    if (this.state.status === 'off') return
    try {
      await pbx.setInboundPhonePresence({ status: this.state.availability, registered: this.state.status === 'ready', registrationState: this.registerer?.state })
    } catch (error) {
      console.warn('VoiceDrive presence not sent', error)
    }
  }

  // ------------------------------------------------------------ calls
  async dial(request: CallRequest, orderId: string | null = null): Promise<void> {
    if (!this.ua || this.state.status !== 'ready') throw new Error('Start the phone first (My Setup or the phone button)')
    if (this.state.call && this.state.call.state !== 'ended') throw new Error('Finish the current call first')
    const domain = (this.creds?.sipUri ?? '').split('@')[1]
    const target = UserAgent.makeURI(`sip:${request.dial}@${domain}`)
    if (!target) throw new Error('Not a valid number')
    const inv = new Inviter(this.ua, target, {
      extraHeaders: [`X-VD-Call-Id: ${request.id}`],
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    })
    this.set({ call: { direction: 'out', callId: request.id, number: request.dial, orderId, state: 'dialing', startedAt: Date.now(), answeredAt: null, endedAt: null, muted: false, endReason: null } })
    this.track(inv)
    trace(request.id, 'invite_sent', { number: request.dial })
    await inv.invite({
      requestDelegate: {
        onProgress: () => this.setCall({ state: 'ringing' }),
        onReject: (r) => this.setCall({ endReason: `${r.message.statusCode} ${r.message.reasonPhrase}` }),
      },
    })
  }

  private onInvite(inv: Invitation) {
    const callId = inv.request.getHeader('X-VD-Call-Id') ?? null
    const number = inv.remoteIdentity.uri.user ?? inv.remoteIdentity.displayName ?? 'Unknown'
    if (this.state.call && this.state.call.state !== 'ended') {
      void inv.reject({ statusCode: 486 })
      trace(callId, 'invite_busy_here')
      return
    }
    this.set({ call: { direction: 'in', callId, number, orderId: null, state: 'incoming', startedAt: Date.now(), answeredAt: null, endedAt: null, muted: false, endReason: null } })
    this.track(inv)
    this.ring(true)
    trace(callId, 'invite_received', { number })
  }

  async answer() {
    const s = this.session
    if (!(s instanceof Invitation) || s.state !== SessionState.Initial) return
    this.ring(false)
    await s.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } })
  }

  async decline() {
    const s = this.session
    if (!(s instanceof Invitation) || s.state !== SessionState.Initial) return
    this.ring(false)
    await s.reject({ statusCode: 486 })
  }

  async hangup() {
    const s = this.session
    if (!s) return
    this.ring(false)
    if (s.state === SessionState.Established) await s.bye()
    else if (s instanceof Inviter && (s.state === SessionState.Initial || s.state === SessionState.Establishing)) await s.cancel()
    else if (s instanceof Invitation && s.state === SessionState.Initial) await s.reject({ statusCode: 486 })
  }

  mute(on: boolean) {
    const pc = this.peer()
    pc?.getSenders().forEach((sender) => { if (sender.track) sender.track.enabled = !on })
    this.setCall({ muted: on })
  }

  sendDtmf(tone: string) {
    if (!/^[0-9*#]$/.test(tone)) return
    const sdh = this.session?.sessionDescriptionHandler as unknown as { sendDtmf?: (t: string) => boolean } | undefined
    sdh?.sendDtmf?.(tone)
  }

  /** Clears an ended call from the screen. */
  dismiss() { if (this.state.call?.state === 'ended') this.set({ call: null }) }

  private peer(): RTCPeerConnection | null {
    return (this.session?.sessionDescriptionHandler as unknown as { peerConnection?: RTCPeerConnection } | undefined)?.peerConnection ?? null
  }

  private track(s: Session) {
    this.session = s
    s.stateChange.addListener((st) => {
      const callId = this.state.call?.callId ?? null
      if (st === SessionState.Established) {
        this.ring(false)
        this.setCall({ state: 'active', answeredAt: Date.now() })
        const pc = this.peer()
        if (pc) {
          this.audio.srcObject = new MediaStream(pc.getReceivers().map((r) => r.track).filter(Boolean))
          void this.audio.play().catch(() => undefined)
          pc.addEventListener('iceconnectionstatechange', () => trace(callId, `ice_${pc.iceConnectionState}`))
        }
        trace(callId, 'established')
      }
      if (st === SessionState.Terminated) {
        this.ring(false)
        void this.quality(callId)
        this.audio.srcObject = null
        this.setCall({ state: 'ended', endedAt: Date.now() })
        if (this.session === s) this.session = null
        trace(callId, 'terminated')
      }
    })
  }

  /** A short quality summary for support (jitter, loss, round trip). */
  private async quality(callId: string | null) {
    const pc = this.peer()
    if (!pc) return
    try {
      const out: Record<string, number> = {}
      ;(await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') Object.assign(out, { packetsReceived: r.packetsReceived ?? 0, packetsLost: r.packetsLost ?? 0, jitter: r.jitter ?? 0 })
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out.packetsSent = r.packetsSent ?? 0
        if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) out.rtt = r.currentRoundTripTime
      })
      await pbx.reportCallQuality(callId, out)
    } catch (error) {
      console.warn('VoiceDrive call quality not sent', error)
    }
  }

  /** A gentle two-tone ring while an incoming call waits. */
  private ring(on: boolean) {
    if (!on) {
      if (this.ringer) { clearInterval(this.ringer.timer); void this.ringer.ctx.close().catch(() => undefined); this.ringer = null }
      return
    }
    if (this.ringer) return
    try {
      const ctx = new AudioContext()
      const beep = () => {
        for (const [f, t] of [[440, 0], [480, 0.4]] as const) {
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.frequency.value = f
          g.gain.value = 0.06
          o.connect(g).connect(ctx.destination)
          o.start(ctx.currentTime + t)
          o.stop(ctx.currentTime + t + 0.35)
        }
      }
      beep()
      this.ringer = { ctx, timer: setInterval(beep, 2_500) }
    } catch {
      this.ringer = null
    }
  }
}

let instance: Softphone | null = null
/** One phone per browser tab. */
export function softphone(): Softphone {
  instance ??= new Softphone()
  return instance
}

// The phone stays on across page reloads in this browser until the agent turns it off.
const ON_KEY = 'vd.phone-on'
function remember(on: boolean) {
  try { if (on) localStorage.setItem(ON_KEY, '1'); else localStorage.removeItem(ON_KEY) } catch { /* storage blocked */ }
}

/** True when the agent left the phone on and the microphone is already allowed (no prompt on page load). */
export async function shouldResume(): Promise<boolean> {
  try {
    if (localStorage.getItem(ON_KEY) !== '1') return false
    const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return perm.state === 'granted'
  } catch {
    return false
  }
}

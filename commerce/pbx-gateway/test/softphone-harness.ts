// Test-only softphone for the gateway e2e: the same SIP.js calls the admin app makes.
import { Inviter, Registerer, type Session, SessionState, UserAgent } from 'sip.js'

interface Creds { sipUri: string; authorizationUsername: string; password: string; wssUrl: string; iceServers: RTCIceServer[] }
const events: string[] = []
let ua: UserAgent
let session: Session | undefined
const media = { constraints: { audio: true, video: false } }

function attach(s: Session, tag: string) {
  session = s
  s.stateChange.addListener((st) => {
    events.push(`${tag}:${st}`)
    if (st === SessionState.Established) {
      const pc = (s.sessionDescriptionHandler as unknown as { peerConnection: RTCPeerConnection }).peerConnection
      const audio = new Audio()
      audio.srcObject = new MediaStream(pc.getReceivers().map((r) => r.track))
      void audio.play().catch(() => undefined)
    }
  })
}

const w = window as unknown as Record<string, unknown>
w.vdStart = async (c: Creds) => {
  ua = new UserAgent({
    uri: UserAgent.makeURI(c.sipUri),
    authorizationUsername: c.authorizationUsername,
    authorizationPassword: c.password,
    transportOptions: { server: c.wssUrl },
    sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: c.iceServers } },
    logLevel: 'warn',
    delegate: {
      onInvite: (inv) => {
        events.push(`invite:${inv.request.getHeader('X-VD-Call-Id') ?? ''}`)
        attach(inv, 'in')
        void inv.accept({ sessionDescriptionHandlerOptions: media })
      },
    },
  })
  await ua.start()
  const reg = new Registerer(ua, { expires: 120 })
  reg.stateChange.addListener((s) => events.push(`reg:${s}`))
  await reg.register()
}
w.vdCall = async (number: string, domain: string, callId: string) => {
  const inv = new Inviter(ua, UserAgent.makeURI(`sip:${number}@${domain}`)!, { extraHeaders: [`X-VD-Call-Id: ${callId}`], sessionDescriptionHandlerOptions: media })
  attach(inv, 'out')
  await inv.invite()
}
w.vdHangup = async () => {
  if (!session) return
  if (session.state === SessionState.Established) await session.bye()
}
w.vdStats = async () => {
  const pc = (session?.sessionDescriptionHandler as unknown as { peerConnection?: RTCPeerConnection })?.peerConnection
  if (!pc) return null
  let received = 0
  let sent = 0
  ;(await pc.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') received += r.packetsReceived ?? 0
    if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.packetsSent ?? 0
  })
  return { received, sent }
}
w.vdEvents = () => events

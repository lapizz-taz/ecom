// Renders each business's IPTSP trunk as PJSIP config for Asterisk.
import type { Trunk } from './api.ts'

const safeHost = (h: string) => /^[A-Za-z0-9.-]{1,253}$/.test(h)
const safeToken = (v: string) => /^[A-Za-z0-9._@+-]{1,120}$/.test(v)
/** Config values can't hold newlines; ';' starts a comment unless escaped. */
const confValue = (v: string) => {
  if (/[\r\n]/.test(v)) throw new Error('newline in a config value')
  return v.replace(/;/g, '\;')
}

export function renderTrunks(trunks: Trunk[]): string {
  const out: string[] = ['; Written by the VoiceDrive controller. Do not edit: changes are overwritten.']
  for (const t of trunks) {
    if (!t.enabled || !safeHost(t.host) || !Number.isInteger(t.code) || !t.password) continue
    if (t.user && !safeToken(t.user)) continue
    if (!/^0[0-9]{9,12}$/.test(t.did)) continue
    const name = `vdtrunk-${t.code}`
    const transport = t.transport === 'tcp' ? 'transport-tcp' : 'transport-udp'
    const uri = `sip:${t.host}:${t.port}${t.transport === 'tcp' ? ';transport=tcp' : ''}`
    out.push(
      '',
      `[${name}]`,
      'type = endpoint',
      `transport = ${transport}`,
      'context = vd-trunk-in',
      'disallow = all',
      'allow = alaw,ulaw',
      `outbound_auth = ${name}-auth`,
      `aors = ${name}`,
      ...(t.user ? [`from_user = ${t.user}`] : []),
      `from_domain = ${t.host}`,
      `set_var = VD_BUSINESS=${t.code}`,
      'direct_media = no',
      'rtp_symmetric = yes',
      'force_rport = yes',
      'rewrite_contact = yes',
      'dtmf_mode = rfc4733',
      // No endpoint callerid here: on inbound calls it would replace the customer's
      // number. The outgoing caller ID is set per call (CALLERID(num) = business DID).
      'send_pai = yes',
      'trust_id_inbound = no',
      'trust_id_outbound = yes',
      '',
      `[${name}-auth]`,
      'type = auth',
      'auth_type = digest',
      `username = ${t.user ?? t.did}`,
      `password = ${confValue(t.password)}`,
      '',
      `[${name}]`,
      'type = aor',
      `contact = ${uri}`,
      'qualify_frequency = 60',
      '',
      `[${name}-identify]`,
      'type = identify',
      `endpoint = ${name}`,
      `match = ${t.host}`,
    )
    if (t.register) {
      out.push(
        '',
        `[${name}-reg]`,
        'type = registration',
        `transport = ${transport}`,
        `outbound_auth = ${name}-auth`,
        `server_uri = ${uri}`,
        `client_uri = sip:${t.user ?? t.did}@${t.host}`,
        `contact_user = ${t.did}`,
        'retry_interval = 60',
        'forbidden_retry_interval = 300',
        'expiration = 600',
        'line = yes',
        `endpoint = ${name}`,
      )
    }
  }
  return out.join('\n') + '\n'
}

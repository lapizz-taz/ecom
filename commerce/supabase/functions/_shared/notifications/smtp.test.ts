import { describe, expect, it } from 'vitest'
import { buildMessage, encodeHeader, sendSmtp, SmtpError, smtpHostProblem, type SmtpSocket, type SocketConnector } from './smtp.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A pretend mail server: answers each command, records what it was sent. */
function fakeServer(opts: { auth?: 'PLAIN' | 'LOGIN'; starttls?: boolean; password?: string; rejectRcpt?: boolean } = {}) {
  const seen: string[] = []
  let message = ''
  let tlsUpgraded = false
  let inData = false
  let queue: string[] = ['220 mail.example.com ESMTP ready']
  let waiting: ((v: Uint8Array | null) => void) | null = null
  let authStep = 0
  const push = (line: string) => {
    queue.push(line)
    if (waiting) {
      const w = waiting
      waiting = null
      w(enc.encode(`${queue.join('\r\n')}\r\n`))
      queue = []
    }
  }
  const onLine = (line: string) => {
    if (inData) {
      if (line === '.') {
        inData = false
        push('250 2.0.0 OK queued as 12345')
      } else {
        message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`
      }
      return
    }
    seen.push(line)
    const cmd = line.split(' ')[0].toUpperCase()
    if (authStep === 1) { authStep = 2; return push('334 UGFzc3dvcmQ6') }
    if (authStep === 2) {
      authStep = 0
      return push(dec.decode(Uint8Array.from(atob(line), (c) => c.charCodeAt(0))) === (opts.password ?? 'app-pass') ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted')
    }
    if (cmd === 'EHLO') {
      const caps = [`250-mail.example.com at your service`, ...(opts.starttls && !tlsUpgraded ? ['250-STARTTLS'] : []), `250-AUTH ${opts.auth ?? 'PLAIN'}`, '250 SMTPUTF8']
      return caps.forEach(push)
    }
    if (cmd === 'STARTTLS') return push('220 2.0.0 Ready to start TLS')
    if (cmd === 'AUTH' && line.toUpperCase().startsWith('AUTH PLAIN')) {
      const [, user, pass] = dec.decode(Uint8Array.from(atob(line.split(' ')[2]), (c) => c.charCodeAt(0))).split('\0')
      return push(user === 'shop@example.com' && pass === (opts.password ?? 'app-pass') ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted')
    }
    if (cmd === 'AUTH') { authStep = 1; return push('334 VXNlcm5hbWU6') }
    if (cmd === 'MAIL') return push('250 2.1.0 OK')
    if (cmd === 'RCPT') return push(opts.rejectRcpt ? '550 5.1.1 No such user' : '250 2.1.5 OK')
    if (cmd === 'DATA') { inData = true; return push('354 Go ahead') }
    if (cmd === 'QUIT') return push('221 2.0.0 Bye')
    push('502 5.5.1 Unrecognized command')
  }
  let partial = ''
  const socket = (): SmtpSocket => ({
    read: () => new Promise((resolve) => {
      if (queue.length) {
        const out = enc.encode(`${queue.join('\r\n')}\r\n`)
        queue = []
        resolve(out)
      } else waiting = resolve
    }),
    async write(bytes) {
      partial += dec.decode(bytes)
      let i: number
      while ((i = partial.indexOf('\r\n')) >= 0) {
        onLine(partial.slice(0, i))
        partial = partial.slice(i + 2)
      }
    },
    async startTls() { tlsUpgraded = true; return socket() },
    close() {},
  })
  const connections: Array<{ host: string; port: number; tls: boolean }> = []
  const connector: SocketConnector = async (host, port, tls) => { connections.push({ host, port, tls }); return socket() }
  return { connector, seen, connections, message: () => message, upgraded: () => tlsUpgraded }
}

const mail = {
  from: { name: 'Isolation', email: 'shop@example.com' }, to: 'rahim@example.com', replyTo: 'help@example.com',
  subject: 'অর্ডার ORD-1042 confirmed', html: '<h1>Hi Rahim</h1><p>.dot line</p>', text: 'Hi Rahim\n.dot line',
}
const decodeParts = (raw: string) => [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)]
  .map((m) => dec.decode(Uint8Array.from(atob(m[1].replace(/\r\n/g, '')), (c) => c.charCodeAt(0))))

describe('SMTP', () => {
  it('sends over SSL with AUTH PLAIN: sender, recipient and both parts arrive', async () => {
    const s = fakeServer()
    const r = await sendSmtp({ host: 'smtp.example.com', port: 465, security: 'ssl', username: 'shop@example.com', password: 'app-pass' }, mail, s.connector)
    expect(r.response).toContain('queued')
    expect(s.connections).toEqual([{ host: 'smtp.example.com', port: 465, tls: true }])
    expect(s.seen).toEqual(expect.arrayContaining(['MAIL FROM:<shop@example.com>', 'RCPT TO:<rahim@example.com>', 'DATA', 'QUIT']))
    const raw = s.message()
    expect(raw).toContain('From: "Isolation" <shop@example.com>')
    expect(raw).toContain('To: <rahim@example.com>')
    expect(raw).toContain('Reply-To: <help@example.com>')
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/)
    expect(decodeParts(raw)).toEqual(['Hi Rahim\n.dot line', '<h1>Hi Rahim</h1><p>.dot line</p>'])
  })

  it('upgrades with STARTTLS on 587 and signs in with AUTH LOGIN', async () => {
    const s = fakeServer({ starttls: true, auth: 'LOGIN' })
    await sendSmtp({ host: 'smtp.example.com', port: 587, security: 'starttls', username: 'shop@example.com', password: 'app-pass' }, mail, s.connector)
    expect(s.connections[0].tls).toBe(false)
    expect(s.upgraded()).toBe(true)
    expect(s.seen.filter((l) => l.startsWith('EHLO'))).toHaveLength(2)
    expect(s.seen).toContain('AUTH LOGIN')
  })

  it('explains a refused password and a refused address, and marks them as not worth retrying', async () => {
    const bad = fakeServer({ password: 'other' })
    const err = await sendSmtp({ host: 'smtp.gmail.com', port: 465, security: 'ssl', username: 'shop@example.com', password: 'wrong' }, mail, bad.connector).catch((e) => e)
    expect(err).toBeInstanceOf(SmtpError)
    expect(err.message).toMatch(/app password/)
    expect(err.permanent).toBe(true)
    const rcpt = await sendSmtp({ host: 'smtp.gmail.com', port: 465, security: 'ssl', username: 'shop@example.com', password: 'app-pass' }, mail, fakeServer({ rejectRcpt: true }).connector).catch((e) => e)
    expect(rcpt.message).toMatch(/customer's email address was refused/)
  })

  it('refuses internal hosts and odd ports before connecting', () => {
    expect(smtpHostProblem('smtp.gmail.com', 465)).toBeNull()
    expect(smtpHostProblem('localhost', 465)).not.toBeNull()
    expect(smtpHostProblem('10.0.0.5', 465)).toMatch(/internal/)
    expect(smtpHostProblem('mail.internal', 465)).toMatch(/internal/)
    expect(smtpHostProblem('smtp.gmail.com', 22)).toMatch(/ports/)
  })

  it('keeps headers to one line each and encodes non-English text', () => {
    const raw = buildMessage({ ...mail, from: { name: 'Shop\r\nBcc: evil@x.com', email: 'shop@example.com' }, subject: 'Hi\r\nBcc: evil@x.com' }, new Date('2026-10-23T05:00:00Z'), '00000000-0000-4000-8000-000000000000')
    const headers = raw.split('\r\n\r\n')[0]
    expect(headers).not.toMatch(/^Bcc:/m)
    expect(headers).toContain('Subject: Hi Bcc: evil@x.com')
    expect(headers).toContain('Date: Fri, 23 Oct 2026 05:00:00 +0000')
    expect(headers).toContain('Message-ID: <00000000-0000-4000-8000-000000000000@example.com>')
    const long = encodeHeader('আপনার অর্ডার নিশ্চিত হয়েছে, ধন্যবাদ আমাদের সাথে কেনাকাটা করার জন্য')
    expect(long.split('\r\n ').every((w) => w.length <= 76)).toBe(true)
    expect(() => buildMessage({ ...mail, to: 'not-an-email' })).toThrow(/not valid/)
  })

  it('adds the unsubscribe headers, and never a header that would break a line', () => {
    const raw = buildMessage({ ...mail, headers: {
      'List-Unsubscribe': '<https://shop.example/unsubscribe/m/t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Evil': 'a\r\nBcc: evil@x.com', 'Bad Name': 'x',
    } })
    const headers = raw.split('\r\n\r\n')[0]
    expect(headers).toContain('List-Unsubscribe: <https://shop.example/unsubscribe/m/t>')
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
    expect(headers).not.toMatch(/^Bcc:|X-Evil|Bad Name/m)
  })
})

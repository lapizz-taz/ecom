// Sends an email through the seller's own mailbox (Gmail, Google Workspace, Zoho, Outlook, their
// hosting email …) over SMTP: TLS from the start (port 465) or STARTTLS (port 587). Needs no
// email API: only the mailbox's server, username and (app) password.
//
// The socket comes from the runtime: Deno's TLS sockets on Supabase Edge Functions (which block
// ports 25 and 587, so 465 there), Cloudflare's sockets on the Worker (worker/index.ts registers
// them with useSocketConnector). The message is multipart (plain text + HTML, UTF-8, base64), and
// every header value is cleaned so a customer's name cannot add headers.

export type SmtpSecurity = 'ssl' | 'starttls'

export interface SmtpConfig {
  host: string
  port: number
  security: SmtpSecurity
  username: string
  password: string
}

export interface MailMessage {
  from: { name: string; email: string }
  to: string
  replyTo?: string | null
  subject: string
  html: string
  text: string
}

/** A byte stream the SMTP client talks over. */
export interface SmtpSocket {
  read(): Promise<Uint8Array | null>
  write(bytes: Uint8Array): Promise<void>
  /** Upgrades the plain connection to TLS (STARTTLS) and returns the TLS socket. */
  startTls(host: string): Promise<SmtpSocket>
  close(): void
}

export type SocketConnector = (host: string, port: number, tls: boolean) => Promise<SmtpSocket>

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number, readonly permanent = false) {
    super(message)
    this.name = 'SmtpError'
  }
}

export const SMTP_PORTS = [465, 587, 2465, 2525, 2587] as const
const TIMEOUT_MS = 20_000
const enc = new TextEncoder()
const dec = new TextDecoder()

// ------------------------------------------------------------------ sockets
let workerConnector: SocketConnector | null = null

/** The Worker passes Cloudflare's connect() here (it cannot be imported where Deno also runs this file). */
export function useSocketConnector(c: SocketConnector | null) {
  workerConnector = c
}

type DenoConn = { read(p: Uint8Array): Promise<number | null>; write(p: Uint8Array): Promise<number>; close(): void }
type DenoNet = {
  connect(o: { hostname: string; port: number }): Promise<DenoConn>
  connectTls(o: { hostname: string; port: number; caCerts?: string[] }): Promise<DenoConn>
  startTls(c: DenoConn, o: { hostname: string; caCerts?: string[] }): Promise<DenoConn>
}

/** Deno's TCP/TLS sockets (Supabase Edge Functions, local tests). caCerts: a test server's own certificate. */
export function denoConnector(caCerts?: string[]): SocketConnector {
  const deno = (globalThis as { Deno?: DenoNet }).Deno
  if (!deno?.connectTls) throw new SmtpError('This server cannot open email connections.')
  const wrap = (conn: DenoConn): SmtpSocket => ({
    async read() {
      const buf = new Uint8Array(16 * 1024)
      const n = await conn.read(buf)
      return n === null ? null : buf.subarray(0, n)
    },
    async write(bytes) {
      let off = 0
      while (off < bytes.length) off += await conn.write(bytes.subarray(off))
    },
    async startTls(host) {
      if (!deno.startTls) throw new SmtpError('STARTTLS is not available here: use port 465 (SSL).')
      return wrap(await deno.startTls(conn, { hostname: host, caCerts }))
    },
    close() {
      try { conn.close() } catch { /* already closed */ }
    },
  })
  return async (host, port, tls) => wrap(tls ? await deno.connectTls({ hostname: host, port, caCerts }) : await deno.connect({ hostname: host, port }))
}

/** Cloudflare Workers' connect() from 'cloudflare:sockets', as a connector. */
export function cloudflareConnector(connect: (addr: { hostname: string; port: number }, o: { secureTransport: 'on' | 'starttls'; allowHalfOpen: boolean }) => {
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; startTls(): unknown; close(): Promise<void>
}): SocketConnector {
  type CfSocket = ReturnType<typeof connect>
  const wrap = (s: CfSocket): SmtpSocket => {
    const reader = s.readable.getReader()
    const writer = s.writable.getWriter()
    return {
      async read() {
        const r = await reader.read()
        return r.done ? null : r.value
      },
      write: (bytes) => writer.write(bytes),
      async startTls() {
        reader.releaseLock()
        writer.releaseLock()
        return wrap(s.startTls() as CfSocket)
      },
      close() {
        void s.close().catch(() => undefined)
      },
    }
  }
  return async (host, port, tls) => wrap(connect({ hostname: host, port }, { secureTransport: tls ? 'on' : 'starttls', allowHalfOpen: false }))
}

function defaultConnector(): SocketConnector {
  return workerConnector ?? denoConnector()
}

// ------------------------------------------------------------------ checks
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localdomain|metadata\.google\.internal)$/i
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** A mail server name a seller may connect to: a public host name, a known port. */
export function smtpHostProblem(host: string, port: number): string | null {
  const h = host.trim().toLowerCase()
  if (!/^[a-z0-9.-]{3,253}$/.test(h) || !h.includes('.') || h.startsWith('.') || h.endsWith('.')) return 'Enter the mail server name, like smtp.gmail.com.'
  if (PRIVATE_HOST.test(h) || IPV4.test(h)) return 'Enter the mail server by its name (like smtp.gmail.com), not an internal address.'
  if (!SMTP_PORTS.includes(port as (typeof SMTP_PORTS)[number])) return `Use one of the email ports: ${SMTP_PORTS.join(', ')}.`
  return null
}

export const isEmail = (s: string) => /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[a-z]{2,}$/i.test(s.trim())

// ------------------------------------------------------------------ message
const clean = (s: string) => s.replace(/[\r\n\t\0]+/g, ' ').trim()

/** RFC 2047 encoded words for non-ASCII header text, folded so no line is too long. */
export function encodeHeader(text: string): string {
  const s = clean(text)
  if (/^[\x20-\x7e]*$/.test(s)) return s
  const words: string[] = []
  let chunk = ''
  for (const ch of s) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(enc.encode(w))}?=`).join('\r\n ')
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, (m) => `${m}\r\n`)

function address(name: string, email: string): string {
  const n = clean(name).replace(/["\\]/g, '')
  if (!n) return `<${email}>`
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `${encodeHeader(n)} <${email}>`
}

/** The whole message as sent after DATA (without the final "."). */
export function buildMessage(m: MailMessage, now = new Date(), id = crypto.randomUUID()): string {
  if (!isEmail(m.from.email) || !isEmail(m.to)) throw new SmtpError('The sender or the customer\'s email address is not valid.', undefined, true)
  if (m.replyTo && !isEmail(m.replyTo)) throw new SmtpError('The reply-to address is not valid.', undefined, true)
  const boundary = `ff-${id.replace(/-/g, '')}`
  const domain = m.from.email.split('@')[1]
  const headers = [
    `From: ${address(m.from.name, m.from.email)}`,
    `To: <${m.to.trim()}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo.trim()}>`] : []),
    `Subject: ${encodeHeader(m.subject || '(no subject)')}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64(enc.encode(body)))}`
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', m.text)}${part('text/html', m.html)}--${boundary}--\r\n`
}

// ------------------------------------------------------------------ protocol
class Lines {
  private buf = ''
  constructor(private sock: SmtpSocket) {}
  use(sock: SmtpSocket) {
    this.sock = sock
    this.buf = ''
  }

  /** One reply: its code and text (the lines of a multi-line reply joined). */
  async reply(): Promise<{ code: number; text: string; lines: string[] }> {
    const lines: string[] = []
    for (;;) {
      const line = await this.line()
      lines.push(line.slice(4))
      if (!/^\d{3}[ -]/.test(line) && !/^\d{3}$/.test(line)) throw new SmtpError(`The mail server answered something unexpected: ${line.slice(0, 120)}`)
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), text: lines.join(' ').trim(), lines }
      if (lines.length > 100) throw new SmtpError('The mail server sent too long an answer.')
    }
  }

  private async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n')
      if (i >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 2)
        return line
      }
      if (this.buf.length > 64 * 1024) throw new SmtpError('The mail server sent too long an answer.')
      const chunk = await withTimeout(this.sock.read(), 'The mail server stopped answering.')
      if (chunk === null) throw new SmtpError('The mail server closed the connection.')
      this.buf += dec.decode(chunk, { stream: true })
    }
  }
}

function withTimeout<T>(p: Promise<T>, message: string, ms = TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, reject) => { t = setTimeout(() => reject(new SmtpError(message)), ms) })]).finally(() => clearTimeout(t))
}

/** What a mail server's refusal means for the seller. */
function explain(step: string, code: number, text: string): SmtpError {
  const t = text.slice(0, 300)
  if (step === 'AUTH' && (code === 535 || code === 534 || code === 530)) {
    return new SmtpError(`The mailbox did not accept the username or password (${code}). Gmail, Yahoo and Zoho need an app password, not your normal password: ${t}`, code, true)
  }
  if (step === 'RCPT' && code >= 550 && code < 560) return new SmtpError(`The customer's email address was refused (${code}): ${t}`, code, true)
  if (step === 'MAIL' && code >= 550) return new SmtpError(`The mailbox refused to send from this address (${code}). Use the mailbox's own address as the sender: ${t}`, code, true)
  return new SmtpError(`The mail server refused ${step} (${code}): ${t}`, code, code >= 500)
}

export interface SendResult { messageId: string; response: string }

/** Connects, signs in, sends one message and says goodbye. */
export async function sendSmtp(cfg: SmtpConfig, m: MailMessage, connector: SocketConnector = defaultConnector()): Promise<SendResult> {
  const problem = smtpHostProblem(cfg.host, cfg.port)
  if (problem) throw new SmtpError(problem, undefined, true)
  const id = crypto.randomUUID()
  const data = buildMessage(m, new Date(), id)
  const host = cfg.host.trim().toLowerCase()
  let sock: SmtpSocket
  try {
    sock = await withTimeout(connector(host, cfg.port, cfg.security === 'ssl'), `Could not reach ${host}:${cfg.port} in time.`)
  } catch (e) {
    if (e instanceof SmtpError) throw e
    const hint = cfg.port === 587 || cfg.port === 25 ? ' This server may not allow that port: try port 465 with SSL.' : ''
    throw new SmtpError(`Could not connect to ${host}:${cfg.port} (${(e as Error).message}).${hint}`)
  }
  const io = new Lines(sock)
  const send = (line: string) => withTimeout(sock.write(enc.encode(`${line}\r\n`)), 'The mail server stopped answering.')
  const expect = async (step: string, ok: number[]) => {
    const r = await io.reply()
    if (!ok.includes(r.code)) throw explain(step, r.code, r.text)
    return r
  }
  try {
    await expect('greeting', [220])
    await send('EHLO fullfilio.com')
    let ehlo = await expect('EHLO', [250])
    if (cfg.security === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError('This mail server does not offer STARTTLS on this port: try port 465 with SSL.', undefined, true)
      await send('STARTTLS')
      await expect('STARTTLS', [220])
      sock = await withTimeout(sock.startTls(host), 'The secure connection could not be set up.')
      io.use(sock)
      await send('EHLO fullfilio.com')
      ehlo = await expect('EHLO', [250])
    }
    const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? ''
    if (auth.includes('PLAIN')) {
      await send(`AUTH PLAIN ${base64(enc.encode(`\0${cfg.username}\0${cfg.password}`))}`)
      await expect('AUTH', [235])
    } else {
      await send('AUTH LOGIN')
      await expect('AUTH', [334])
      await send(base64(enc.encode(cfg.username)))
      await expect('AUTH', [334])
      await send(base64(enc.encode(cfg.password)))
      await expect('AUTH', [235])
    }
    await send(`MAIL FROM:<${m.from.email.trim()}>`)
    await expect('MAIL', [250])
    await send(`RCPT TO:<${m.to.trim()}>`)
    await expect('RCPT', [250, 251])
    await send('DATA')
    await expect('DATA', [354])
    // Lines starting with "." are doubled (none do in base64, but headers are the seller's).
    const body = data.replace(/\r\n\./g, '\r\n..')
    await withTimeout(sock.write(enc.encode(`${body}.\r\n`)), 'The mail server stopped answering.')
    const done = await expect('DATA', [250])
    await send('QUIT').catch(() => undefined)
    return { messageId: id, response: done.text.slice(0, 200) }
  } finally {
    sock.close()
  }
}

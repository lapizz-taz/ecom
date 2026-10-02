import { afterEach, describe, expect, it, vi } from 'vitest'
import { functionName, logEvent, parseDsn, scrub, scrubText, sentryEnvelope } from './monitoring.ts'

describe('monitoring', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('redacts anything that looks like a credential', () => {
    expect(scrub({ phone: '017', api_key: 'abc', nested: { Authorization: 'Bearer x', ok: 1 }, list: [{ secret_key: 's' }] }))
      .toEqual({ phone: '017', api_key: '[redacted]', nested: { Authorization: '[redacted]', ok: 1 }, list: [{ secret_key: '[redacted]' }] })
  })

  it('masks keys inside text such as URLs', () => {
    expect(scrubText('error sending request for url (http://h/fatch.php?api_key=abc123&term=0171): refused'))
      .toBe('error sending request for url (http://h/fatch.php?api_key=[redacted]&term=0171): refused')
    expect(scrubText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y')).toBe('Authorization: Bearer [redacted]')
    expect(scrub({ message: 'GET /x?access_token=EAAB123 failed' })).toEqual({ message: 'GET /x?access_token=[redacted] failed' })
  })

  it('parses a Sentry DSN and builds an envelope', () => {
    expect(parseDsn('https://abc123@o1.ingest.sentry.io/456')).toEqual({ host: 'o1.ingest.sentry.io', projectId: '456', key: 'abc123', protocol: 'https:' })
    expect(parseDsn('not a dsn')).toBeNull()
    const [header, item, body] = sentryEnvelope({ level: 'ERROR', category: 'COURIER', source: 'courier', message: 'Pathao: HTTP 500', context: { token: 't' }, error: new Error('boom') }).split('\n')
    expect(JSON.parse(header)).toHaveProperty('event_id')
    expect(JSON.parse(item)).toEqual({ type: 'event' })
    const event = JSON.parse(body)
    expect(event).toMatchObject({ level: 'error', tags: { category: 'COURIER' }, message: { formatted: 'Pathao: HTTP 500' } })
    expect(event.extra.token).toBe('[redacted]')
  })

  it('writes to the system log and Sentry without throwing', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://db.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service')
    vi.stubEnv('SENTRY_DSN', 'https://k@sentry.example/9')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}'))
    await logEvent({ level: 'ERROR', category: 'SMS', source: 'notifications-dispatch', message: 'Gateway down', context: { password: 'p' } }, fetchFn)
    const urls = fetchFn.mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('https://db.example/rest/v1/rpc/log_system_event')
    expect(urls).toContain('https://sentry.example/api/9/envelope/')
    const logBody = JSON.parse(fetchFn.mock.calls.find((c) => String(c[0]).includes('log_system_event'))![1].body)
    expect(logBody).toMatchObject({ p_level: 'ERROR', p_category: 'SMS', p_context: { password: '[redacted]' } })

    const failing = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(logEvent({ level: 'WARN', category: 'META', source: 'meta', message: 'x' }, failing)).resolves.toBeUndefined()
  })

  it('names the function from the request URL', () => {
    expect(functionName(new Request('https://x.supabase.co/functions/v1/courier-webhook?p=pathao'))).toBe('courier-webhook')
  })
})

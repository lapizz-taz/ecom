import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BulkSmsBdProvider, cleanSmsCredentials, deliveryFromText, HttpSmsGateway, smsCredentialHint, SmsError, SmsNetBdProvider,
  smsProviderFromCredentials, SslWirelessProvider,
} from './sms/providers.ts'

const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const message = { to: '8801711000000', body: 'Order ISO-1 is on the way & paid', senderId: 'SHOP', clientRef: '0b7c2f7e-1d2a-4c55-9f00-6a1b2c3d4e5f' }

afterEach(() => vi.unstubAllEnvs())

describe('Alpha SMS (sms.net.bd)', () => {
  it('posts the message as a form and keeps the request id for delivery reports', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ error: 0, msg: 'Request successfully submitted', data: { request_id: 4521 } }))
    const sent = await new SmsNetBdProvider('KEY', undefined, fetchFn).send(message)
    expect(sent).toMatchObject({ messageId: '4521', delivery: 'PENDING', cost: null })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.sms.net.bd/sendsms')
    expect(init.method).toBe('POST')
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      api_key: 'KEY', msg: 'Order ISO-1 is on the way & paid', to: '8801711000000', sender_id: 'SHOP',
    })
  })

  it('treats a bad number as permanent and low balance as worth retrying', async () => {
    const bad = new SmsNetBdProvider('KEY', undefined, vi.fn().mockResolvedValue(reply({ error: 416, msg: 'No valid number found' })))
    await expect(bad.send(message)).rejects.toMatchObject({ message: 'sms.net.bd: No valid number found', permanent: true })
    const broke = new SmsNetBdProvider('KEY', undefined, vi.fn().mockResolvedValue(reply({ error: 417, msg: 'Insufficient balance' })))
    await expect(broke.send(message)).rejects.toMatchObject({ permanent: false })
  })

  it('reads the balance and the delivery report with its charge', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply({ error: 0, msg: 'Success', data: { balance: '512.75' } }))
      .mockResolvedValueOnce(reply({ error: 0, msg: 'Success', data: {
        request_id: 4521, request_status: 'Complete', request_charge: '0.2500',
        recipients: [{ number: '8801711000000', charge: '0.2500', status: 'Delivered' }] } }))
    const provider = new SmsNetBdProvider('KEY', 'https://mock.example/', fetchFn)
    expect(await provider.balance()).toBe(512.75)
    expect(await provider.report('4521')).toMatchObject({ status: 'DELIVERED', cost: 0.25 })
    expect(fetchFn.mock.calls[0][0]).toBe('https://mock.example/user/balance/?api_key=KEY')
    expect(fetchFn.mock.calls[1][0]).toBe('https://mock.example/report/request/4521/?api_key=KEY')
  })

  it('reports an unreadable reply instead of guessing', async () => {
    const provider = new SmsNetBdProvider('KEY', undefined, vi.fn().mockResolvedValue(reply('<html>Bad gateway</html>', 502)))
    await expect(provider.send(message)).rejects.toThrow(/unexpected reply \(HTTP 502\)/)
  })
})

describe('BulkSMSBD', () => {
  it('sends with the sender ID and treats 202 as submitted', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ response_code: 202, message_id: 99, success_message: 'SMS Submitted Successfully' }))
    const sent = await new BulkSmsBdProvider('KEY', undefined, fetchFn).send(message)
    expect(sent).toMatchObject({ messageId: '99', delivery: 'UNKNOWN' })
    const url = new URL(fetchFn.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://bulksmsbd.net/api/smsapi')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api_key: 'KEY', type: 'text', number: '8801711000000', senderid: 'SHOP', message: 'Order ISO-1 is on the way & paid',
    })
  })

  it('explains error codes and only retries the temporary ones', async () => {
    const send = (code: number) => new BulkSmsBdProvider('KEY', undefined, vi.fn().mockResolvedValue(reply({ response_code: code, error_message: 'x' }))).send(message)
    await expect(send(1001)).rejects.toMatchObject({ message: 'BulkSMSBD: Invalid number (1001)', permanent: true })
    await expect(send(1007)).rejects.toMatchObject({ message: 'BulkSMSBD: Not enough SMS balance (1007)', permanent: false })
    await expect(send(1032)).rejects.toMatchObject({ permanent: true })
  })

  it('needs a sender ID', async () => {
    const fetchFn = vi.fn()
    await expect(new BulkSmsBdProvider('KEY', undefined, fetchFn).send({ ...message, senderId: null })).rejects.toMatchObject({ permanent: true })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('SSL Wireless', () => {
  it('sends JSON with a unique csms_id and keeps the reference id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({
      status: 'SUCCESS', status_code: 200, error_message: '',
      smsinfo: [{ sms_status: 'SUCCESS', status_message: 'Success', msisdn: '8801711000000', reference_id: 'REF-1' }],
    }))
    const sent = await new SslWirelessProvider('TOKEN', 'SID', undefined, fetchFn).send(message)
    expect(sent.messageId).toBe('REF-1')
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      api_token: 'TOKEN', sid: 'SID', msisdn: '8801711000000', sms: message.body, csms_id: '0b7c2f7e1d2a4c559f00',
    })
  })

  it('surfaces the gateway reason', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ status: 'FAILED', status_code: 4001, error_message: 'Unauthorized IP' }))
    await expect(new SslWirelessProvider('TOKEN', 'SID', undefined, fetchFn).send(message)).rejects.toThrow('SSL Wireless: Unauthorized IP')
  })
})

describe('other HTTP gateways', () => {
  it('fills the URL template with encoded values', () => {
    const gateway = new HttpSmsGateway({ urlTemplate: 'https://sms.example/send?k={key}&to={to}&from={sender}&msg={message}', apiKey: 'K&1' })
    expect(gateway.buildUrl(message))
      .toBe('https://sms.example/send?k=K%261&to=8801711000000&from=SHOP&msg=Order%20ISO-1%20is%20on%20the%20way%20%26%20paid')
  })

  it('posts the parameters as a form and checks the success pattern', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('STATUS: QUEUED'))
    const gateway = new HttpSmsGateway({ urlTemplate: 'https://sms.example/send?to={to}&msg={message}', method: 'POST', successPattern: 'OK' }, fetchFn)
    await expect(gateway.send(message)).rejects.toThrow(/did not accept/)
    expect(fetchFn.mock.calls[0][0]).toBe('https://sms.example/send')
    expect(Object.fromEntries(fetchFn.mock.calls[0][1].body as URLSearchParams)).toEqual({ to: '8801711000000', msg: message.body })
  })
})

describe('connecting', () => {
  it('keeps only known fields and shows a masked hint', () => {
    const creds = cleanSmsCredentials('smsnetbd', { api_key: ' abcd1234 ', extra: 'x', base_url: '' })
    expect(creds).toEqual({ api_key: 'abcd1234' })
    expect(smsCredentialHint('smsnetbd', creds)).toBe('••••1234')
    expect(smsCredentialHint('http', { url_template: 'https://sms.example/send?to={to}&msg={message}' })).toBe('sms.example')
  })

  it('refuses missing fields, plain http addresses and templates without {to} or {message}', () => {
    expect(() => smsProviderFromCredentials('sslwireless', { api_token: 'T' })).toThrow('Enter sid')
    expect(() => smsProviderFromCredentials('smsnetbd', { api_key: 'K', base_url: 'http://sms.example' })).toThrow(SmsError)
    expect(() => smsProviderFromCredentials('http', { url_template: 'https://sms.example/send?to={to}' })).toThrow(/\{message\}/)
    vi.stubEnv('ALLOW_INSECURE_GATEWAY_URL', 'true')
    expect(smsProviderFromCredentials('smsnetbd', { api_key: 'K', base_url: 'http://127.0.0.1:8789' }).code).toBe('smsnetbd')
  })

  it('reads delivery words the way gateways use them', () => {
    expect(deliveryFromText('Delivered')).toBe('DELIVERED')
    expect(deliveryFromText('UNDELIVERED')).toBe('FAILED')
    expect(deliveryFromText('Failed')).toBe('FAILED')
    expect(deliveryFromText('Sent')).toBe('PENDING')
    expect(deliveryFromText(undefined)).toBe('PENDING')
  })
})

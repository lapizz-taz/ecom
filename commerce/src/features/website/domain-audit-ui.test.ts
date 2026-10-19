// Audit of the custom-domain popup and the root-domain proxy helpers: virtual domains in many
// states, rendered to text, checked for contradictions (each one a bug the audit found, now fixed).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DomainDetail, DomainList } from '@/features/website/domain-status'
import type { DomainDiagnosis, DnsRecord, StoreDomain } from '@/services/website'
import { diagnose, inspectWww, proxyTarget } from '../../../supabase/functions/_shared/domain-check'
import { fromRootProxy } from '../../../worker/router'

// --- fixtures ---------------------------------------------------------------------------

const IP = '203.0.113.10'
const IP6 = '2001:db8::10'
const TARGET = 'stores.fullfilio.com'
const PROXY_RECORDS: DnsRecord[] = [
  { type: 'A', name: '@', value: IP, why: 'Points your domain at the store' },
  { type: 'A', name: 'www', value: IP, why: 'So www opens the store too' },
]
const CNAME_RECORDS: DnsRecord[] = [{ type: 'CNAME', name: 'www', value: TARGET, why: 'Points this subdomain at the store' }]

const regions = (ok: number) => ['na', 'sa', 'eu', 'af', 'as', 'oc'].map((code, i) => ({ code, name: code.toUpperCase(), ok: i < ok, answers: [] }))
type Issue = DomainDiagnosis['issues'][number]
const issue = (code: string, severity: Issue['severity'], title = code): Issue => ({ code, severity, title, detail: `${code} detail` })

function diag(p: Partial<DomainDiagnosis> = {}): DomainDiagnosis {
  return {
    checked_at: '2026-10-19T10:00:00Z', kind: 'apex', pointed: true, live_everywhere: true,
    records: [{ type: 'A', name: '@', value: IP, ok: true }], regions: regions(6),
    resolvers: [{ name: 'Google', ok: true, answers: [IP] }],
    tls: { ok: true, detail: 'TLS certificate provisioned for secure connections', served_by_store: true, status: 200 },
    issues: [], dns_host: { provider: 'Hostinger', nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'], mixed: false },
    ...p,
  }
}
function dom(p: Partial<StoreDomain> = {}): StoreDomain {
  return {
    id: 'd1', domain: 'shop.com', status: 'ACTIVE', records: PROXY_RECORDS, detail: null,
    created_at: '2026-10-19T09:00:00Z', checked_at: '2026-10-19T10:00:00Z', is_primary: true, diagnostics: diag(), ...p,
  }
}
const noop = () => undefined
/** The popup as plain text (tags dropped, entities decoded). */
function popup(d: StoreDomain, extra: { onUseWww?: () => Promise<unknown> } = {}): string {
  const html = renderToStaticMarkup(createElement(DomainDetail, {
    d, primary: 'shop.com', canEdit: true, checking: false, inDialog: true,
    onCheck: noop, onRemove: noop, onBack: noop, onMakePrimary: async () => undefined, ...extra,
  }))
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
}
const chip = (d: StoreDomain) => renderToStaticMarkup(createElement(DomainList, { domains: [d], onOpen: noop })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

// --- the popup ----------------------------------------------------------------------------

describe('domain popup: states that are right', () => {
  it('proxy root live with no issues: Connected, no records to add, no www offer', () => {
    const t = popup(dom())
    expect(t).toContain('Connected')
    expect(t).toContain('DNS records are pointing to Fullfilio')
    expect(t).not.toContain('Add at your domain provider')
    expect(t).not.toContain('Or use www.')
    expect(t).not.toContain('We keep checking')
  })

  it('proxy root live, www missing: warn chip, the www row is red and the records to add show', () => {
    const d = dom({ diagnostics: diag({
      records: [{ type: 'A', name: '@', value: IP, ok: true }, { type: 'A', name: 'www', value: '—', ok: false, note: `Not found yet — add an A record for www pointing to ${IP}` }],
      issues: [issue('WWW_SETUP', 'warning', 'www.shop.com is not set up yet')],
    }) })
    expect(chip(d)).toContain('Connected · issue')
    const t = popup(d)
    expect(t).toContain('Your domain is connected, but we recommend you review the following')
    expect(t).toContain('Add at your domain provider')
    expect(t).not.toContain('Or use www.')
  })

  it('a new proxy root with no records: red, says what to add, A-record tip for the DNS company', () => {
    const d = dom({ status: 'VERIFYING', is_primary: true, detail: 'No DNS records found', diagnostics: diag({
      pointed: false, live_everywhere: false, records: [], regions: regions(0), resolvers: [{ name: 'Google', ok: false, answers: [] }],
      tls: { ok: false, detail: 'The domain did not answer over HTTPS yet', served_by_store: null, status: null },
      issues: [issue('NO_RECORDS', 'error', 'No DNS records found')],
    }) })
    const t = popup(d)
    expect(t).toContain('DNS records are not pointing to Fullfilio yet')
    expect(t).toContain('Fix the following to connect your domain')
    expect(t).toContain('For @ use an A record with the address below')
    expect(t).not.toContain('The root (@) cannot connect at Hostinger')
    expect(t).toContain('Add at your domain provider')
  })
})

describe('domain popup: no contradictions', () => {
  it('an error that blocks the domain (TXT missing, DNS pointed) is never called "connected"', () => {
    const d = dom({ domain: 'www.shop.com', status: 'VERIFYING', records: CNAME_RECORDS, diagnostics: diag({
      kind: 'subdomain', records: [{ type: 'CNAME', name: 'www', value: TARGET, ok: true }],
      issues: [issue('TXT_MISSING', 'error', 'Verification record missing')],
    }) })
    expect(chip(d)).toContain('Not connected')
    // Band and chip: "Not connected"; the issues box: "Your domain is connected, but…".
    expect(popup(d)).not.toContain('Your domain is connected')
  })

  it('a live domain (ACTIVE) is not told to "fix the following to connect"', () => {
    // Cloudflare path: hosting active and the store answers, resolvers still on the old nameservers.
    const d = dom({ domain: 'www.shop.com', status: 'ACTIVE', records: CNAME_RECORDS, diagnostics: diag({
      kind: 'subdomain', pointed: false,
      records: [{ type: 'CNAME', name: 'www', value: 'old.example.net', ok: false, note: 'From your old DNS (Hostinger), which no longer counts' }],
      issues: [issue('NS_SWITCHING', 'error', 'Your DNS moved to Cloudflare — add the records there')],
    }) })
    expect(chip(d)).toContain('Connected · issue')
    const t = popup(d)
    expect(t).not.toContain('not pointing to Fullfilio yet')
    expect(t).not.toContain('Fix the following to connect your domain')
  })

  it('a DNS checker outage (CHECK_FAILED) is not shown as "Not connected"', () => {
    const d = dom({ status: 'VERIFYING', diagnostics: diag({ pointed: false, records: [], issues: [issue('CHECK_FAILED', 'error', 'Could not check DNS right now')] }) })
    expect(chip(d)).not.toContain('Not connected')
  })

  it('a subdomain is never given root-only advice (GoDaddy: "delete the A record for @")', () => {
    const d = dom({ domain: 'www.shop.com', status: 'VERIFYING', records: CNAME_RECORDS, diagnostics: diag({
      kind: 'subdomain', pointed: false, records: [], issues: [issue('NO_RECORDS', 'error')],
      dns_host: { provider: 'GoDaddy', nameservers: ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'], mixed: false },
    }) })
    expect(popup(d)).not.toContain('delete the A record for @')
  })

  it('DNS right, certificate pending: HTTPS row does not say "once DNS points at the store"', () => {
    const d = dom({ status: 'VERIFYING', diagnostics: diag({
      tls: { ok: false, detail: 'The certificate is not ready yet (it is issued once DNS points at the store)', served_by_store: null, status: null },
      issues: [issue('TLS_PENDING', 'info', 'Certificate on the way')],
    }) })
    const t = popup(d)
    expect(t).toContain('DNS is right · finishing HTTPS')
    expect(t).not.toContain('issued once DNS points at the store')
  })
})

// --- the diagnosis behind it (fake DNS, no network) ---------------------------------------

type Zone = Record<string, Partial<Record<'A' | 'AAAA' | 'CNAME' | 'NS' | 'CAA' | 'TXT', string[]>>>
const CODE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 } as const
function fakeFetch(zone: Zone, https: 'store' | 'other' | 'down' = 'store', dohDown = false): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'rdap.org') return new Response('{}', { status: 404 })
    if (url.pathname === '/') {
      if (https === 'down') throw new Error('invalid peer certificate')
      return new Response('ok', { headers: https === 'store' ? { 'x-fullfilio': 'store' } : { server: 'other' } })
    }
    if (dohDown) throw new Error('timeout')
    const name = url.searchParams.get('name') ?? ''
    const type = url.searchParams.get('type') as keyof typeof CODE
    const rec = zone[name] ?? {}
    const answer: Array<{ name: string; type: number; data: string }> = []
    if (rec.CNAME && ['A', 'AAAA', 'CNAME'].includes(type)) {
      answer.push(...rec.CNAME.map((d) => ({ name, type: CODE.CNAME, data: `${d}.` })))
      if (type !== 'CNAME') answer.push(...(zone[rec.CNAME[0]]?.[type] ?? []).map((d) => ({ name: rec.CNAME![0], type: CODE[type], data: d })))
    } else if (rec[type]) answer.push(...rec[type]!.map((d) => ({ name, type: CODE[type], data: d })))
    return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { 'content-type': 'application/dns-json' } })
  }) as typeof fetch
}

describe('root-domain diagnosis', () => {
  const proxy = proxyTarget(IP, TARGET)

  it('a correct proxy root is pointed and live with no issues', async () => {
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch({ 'shop.com': { A: [IP] } }) })
    expect(d.pointed).toBe(true)
    expect(d.issues).toEqual([])
  })

  it('a correct AAAA on the proxy is not labelled "Cloudflare proxy"', async () => {
    const d = await diagnose('shop.com', { target: proxyTarget(IP, TARGET, IP6), fetcher: fakeFetch({ 'shop.com': { A: [IP], AAAA: [IP6] } }) })
    const row = d.records.find((r) => r.type === 'AAAA')
    expect(row?.ok).toBe(true)
    expect(row?.note).not.toBe('Cloudflare proxy')
  })

  it('orange cloud in front of the proxy is not reported as "should be <our IP>" / WRONG_TARGET', async () => {
    // The merchant's A @ is our IP but proxied: public DNS shows Cloudflare's addresses.
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch({ 'shop.com': { A: ['104.21.7.111', '172.67.130.48'], NS: ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } }, 'other') })
    expect(d.issues.map((i) => i.code)).toContain('ORANGE_CLOUD')
    expect(d.issues.map((i) => i.code)).not.toContain('WRONG_TARGET')
    expect(d.records[0].note).not.toBe(`Should be ${IP}`)
  })

  it('a DNS-checker outage marks a store that answers over HTTPS as not pointed (inspectRoot then leaves ACTIVE)', async () => {
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch({}, 'store', true) })
    expect(d.tls.served_by_store).toBe(true)
    expect(d.pointed).toBe(false)
    expect(d.issues.map((i) => i.code)).toContain('CHECK_FAILED')
  })

  it('www CNAME to stores.fullfilio.com (what the separate www.shop.com row asks for) is flagged WWW_SETUP on the root', async () => {
    const zone: Zone = { 'www.shop.com': { CNAME: [TARGET] }, [TARGET]: { A: ['104.21.7.111'] } }
    const www = await inspectWww('shop.com', proxy, fakeFetch(zone))
    expect(www?.issue?.code).toBe('WWW_SETUP')
    expect(www?.records[0]).toMatchObject({ type: 'CNAME', ok: false })
  })
})

// --- the Worker side of the proxy ---------------------------------------------------------

describe('fromRootProxy', () => {
  const SECRET = 'x'.repeat(64)
  const via = (host: string, secret = SECRET) => fromRootProxy(new Request(`https://${TARGET}/p?q=1`, {
    headers: { 'x-fullfilio-proxy': secret, 'x-fullfilio-host': host, 'x-fullfilio-client-ip': '198.51.100.7' },
  }), SECRET)

  it('puts a trusted visit back on the visitor host and IP, and drops the proxy headers', () => {
    const r = via('Shop.com:443')
    expect(new URL(r.url).host).toBe('shop.com')
    expect(new URL(r.url).search).toBe('?q=1')
    expect(r.headers.get('cf-connecting-ip')).toBe('198.51.100.7')
    expect(r.headers.has('x-fullfilio-proxy')).toBe(false)
  })

  it('ignores the headers without the secret', () => {
    const r = via('shop.com', 'y'.repeat(64))
    expect(new URL(r.url).host).toBe(TARGET)
    expect(r.headers.has('cf-connecting-ip')).toBe(false)
  })

  it('keeps a trailing-dot visit (shop.com.) on the visitor host', () => {
    expect(new URL(via('shop.com.').url).host).toBe('shop.com')
  })

  it('never takes the platform\'s own host from the proxy (Caddy forwards the Host header, not the SNI)', () => {
    expect(new URL(via('fullfilio.com').url).host).toBe(TARGET)
  })
})

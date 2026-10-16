import { describe, expect, it } from 'vitest'
import { apexOf, cloudflareTarget, diagnose, dnsHostOf, proxyTarget, domainKind, hostLabel, isCloudflare, isVercelA, isVercelCname, oldHostOf, REGIONS } from './domain-check.ts'

type Zone = Record<string, Partial<Record<'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'TXT', string[]>>>
const CODE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 } as const

/** A fake fetch: DNS-over-HTTPS answers from `zone`, HTTPS from `https`. */
function fakeFetch(zone: Zone, https: { ok: boolean; vercel?: boolean } = { ok: true, vercel: true }, bySubnet: Record<string, Zone> = {}) {
  return (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/') {
      if (!https.ok) throw new Error('invalid peer certificate: UnknownIssuer')
      return new Response('ok', { status: 200, headers: https.vercel ? { server: 'Vercel', 'x-vercel-id': 'bom1::x' } : { server: 'nginx' } })
    }
    const name = url.searchParams.get('name')!
    const type = url.searchParams.get('type') as keyof typeof CODE
    const z = bySubnet[url.searchParams.get('edns_client_subnet') ?? ''] ?? zone
    const rec = z[name] ?? {}
    const answer: Array<{ name: string; type: number; data: string }> = []
    if (rec.CNAME && (type === 'A' || type === 'CNAME' || type === 'AAAA')) answer.push(...rec.CNAME.map((d) => ({ name, type: CODE.CNAME, data: d + '.' })))
    if (type === 'A' && rec.CNAME) answer.push({ name, type: CODE.A, data: '76.76.21.98' })
    if (rec[type] && !(type === 'CNAME')) answer.push(...rec[type]!.map((d) => ({ name, type: CODE[type], data: d })))
    return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { 'content-type': 'application/dns-json' } })
  }) as typeof fetch
}

describe('domain check', () => {
  it('knows apex names, labels and the hosting addresses', () => {
    expect(domainKind('shop.com')).toBe('apex')
    expect(domainKind('shop.com.bd')).toBe('apex')
    expect(domainKind('www.shop.com')).toBe('subdomain')
    expect(apexOf('www.shop.com.bd')).toBe('shop.com.bd')
    expect(hostLabel('www.shop.com')).toBe('www')
    expect(hostLabel('shop.com')).toBe('@')
    expect(isVercelA('76.76.21.21')).toBe(true)
    expect(isVercelA('1.2.3.4')).toBe(false)
    expect(isVercelCname('cname.vercel-dns.com')).toBe(true)
    expect(isVercelCname('abc123.vercel-dns-017.com')).toBe(true)
    expect(isCloudflare('104.21.7.111')).toBe(true)
    expect(isCloudflare('172.67.130.48')).toBe(true)
    expect(isCloudflare('2606:4700:3032::ac43:8230')).toBe(true)
    expect(isCloudflare('76.76.21.21')).toBe(false)
  })

  it('a correctly pointed apex is live everywhere with no issues', async () => {
    const d = await diagnose('shop.com', { fetcher: fakeFetch({ 'shop.com': { A: ['76.76.21.21'] } }) })
    expect(d.pointed).toBe(true)
    expect(d.live_everywhere).toBe(true)
    expect(d.records).toEqual([{ type: 'A', name: '@', value: '76.76.21.21', ok: true, note: undefined }])
    expect(d.regions.every((r) => r.ok)).toBe(true)
    expect(d.tls).toMatchObject({ ok: true, served_by_store: true })
    expect(d.issues).toEqual([])
  })

  it('a www CNAME shows one CNAME row, not the target addresses', async () => {
    const d = await diagnose('www.shop.com', { fetcher: fakeFetch({ 'www.shop.com': { CNAME: ['cname.vercel-dns.com'] } }) })
    expect(d.records.map((r) => [r.type, r.name, r.value, r.ok])).toEqual([['CNAME', 'www', 'cname.vercel-dns.com', true]])
    expect(d.live_everywhere).toBe(true)
  })

  it('flags a Cloudflare proxy as a warning when the store still opens through it', async () => {
    const d = await diagnose('shop.com', { fetcher: fakeFetch({ 'shop.com': { A: ['104.21.7.111', '172.67.130.48'], AAAA: ['2606:4700:3032::ac43:8230'] } }) })
    expect(d.pointed).toBe(true)
    expect(d.records.every((r) => r.ok)).toBe(true)
    expect(d.issues.map((i) => [i.code, i.severity])).toEqual([['CLOUDFLARE_PROXY', 'warning']])
  })

  it('a Cloudflare proxy that does not reach the store is an error', async () => {
    const d = await diagnose('shop.com', { fetcher: fakeFetch({ 'shop.com': { A: ['104.21.7.111'] } }, { ok: true, vercel: false }) })
    expect(d.pointed).toBe(false)
    expect(d.issues.map((i) => i.code)).toEqual(['WRONG_TARGET', 'CLOUDFLARE_PROXY'])
    expect(d.issues.find((i) => i.code === 'CLOUDFLARE_PROXY')?.severity).toBe('error')
  })

  it('finds extra A records, IPv6 records and a CAA record that blocks the certificate', async () => {
    const d = await diagnose('shop.com', { fetcher: fakeFetch({ 'shop.com': { A: ['76.76.21.21', '93.184.216.34'], AAAA: ['2001:db8::1'], CAA: ['0 issue "digicert.com"'] } }) })
    expect(d.records.map((r) => r.ok)).toEqual([true, false, false])
    expect(d.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EXTRA_A', 'AAAA', 'CAA']))
  })

  it('reports nothing set up, and regions still on the old records', async () => {
    const none = await diagnose('shop.com', { fetcher: fakeFetch({}, { ok: false }) })
    expect(none.pointed).toBe(false)
    expect(none.issues[0].code).toBe('NO_RECORDS')
    expect(none.tls.ok).toBe(false)

    const old: Zone = { 'shop.com': { A: ['93.184.216.34'] } }
    const spreading = await diagnose('shop.com', { fetcher: fakeFetch({ 'shop.com': { A: ['76.76.21.21'] } }, { ok: true, vercel: true }, { '81.2.69.0/24': old, '1.120.0.0/24': old }) })
    expect(spreading.live_everywhere).toBe(false)
    expect(spreading.regions.filter((r) => !r.ok).map((r) => r.name)).toEqual(['Europe', 'Australia'])
    expect(spreading.issues.map((i) => i.code)).toEqual(['PROPAGATING'])
  })

  it('says the check failed when no resolver answers', async () => {
    const down = (async () => { throw new Error('network down') }) as typeof fetch
    const d = await diagnose('shop.com', { fetcher: down })
    expect(d.issues.map((i) => i.code)).toEqual(['CHECK_FAILED'])
    expect(d.pointed).toBe(false)
  })
})

describe('domain check on Cloudflare (Cloudflare for SaaS)', () => {
  const target = cloudflareTarget('stores.fullfilio.example')
  /** HTTPS answered by our site (it carries X-Fullfilio) or by someone else. */
  function cfFetch(zone: Zone, ours = true) {
    const dns = fakeFetch(zone)
    return (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/') return new Response('ok', { headers: ours ? { server: 'cloudflare', 'x-fullfilio': 'store' } : { server: 'cloudflare' } })
      return dns(input, init)
    }) as typeof fetch
  }

  it('a subdomain with a CNAME to our target is pointed and live', async () => {
    const d = await diagnose('www.shop.com', { target, fetcher: cfFetch({ 'www.shop.com': { CNAME: ['stores.fullfilio.example'] } }) })
    expect(d.pointed).toBe(true)
    expect(d.records[0]).toMatchObject({ type: 'CNAME', value: 'stores.fullfilio.example', ok: true })
    expect(d.tls.served_by_store).toBe(true)
    expect(d.issues.map((i) => i.code)).toEqual([])
  })

  it('an apex on CNAME flattening (Cloudflare addresses) counts once our store answers', async () => {
    const zone: Zone = { 'shop.com': { A: ['104.21.7.111'], AAAA: ['2606:4700:3032::ac43:8230'] } }
    const ours = await diagnose('shop.com', { target, fetcher: cfFetch(zone) })
    expect(ours.pointed).toBe(true)
    expect(ours.records.every((r) => r.ok)).toBe(true)
    expect(ours.issues.map((i) => i.code)).not.toContain('CLOUDFLARE_PROXY')

    const someoneElse = await diagnose('shop.com', { target, fetcher: cfFetch(zone, false) })
    expect(someoneElse.pointed).toBe(false)
    expect(someoneElse.issues[0]).toMatchObject({ code: 'WRONG_TARGET' })
    expect(someoneElse.issues[0].detail).toContain('stores.fullfilio.example')
  })

  it('tells an apex with no records to use a CNAME/ALIAS (or www), and a wrong CNAME to change it', async () => {
    const none = await diagnose('shop.com', { target, fetcher: cfFetch({}, false) })
    expect(none.issues[0].code).toBe('NO_RECORDS')
    expect(none.issues[0].detail).toMatch(/ALIAS.*www\.shop\.com/)
    const wrong = await diagnose('www.shop.com', { target, fetcher: cfFetch({ 'www.shop.com': { CNAME: ['cname.vercel-dns.com'] } }, false) })
    expect(wrong.records[0]).toMatchObject({ ok: false, note: 'Should be stores.fullfilio.example' })
    expect(wrong.issues[0].code).toBe('WRONG_TARGET')
  })

  it('accepts a CAA record for Google Trust Services as well as Let\'s Encrypt', async () => {
    const d = await diagnose('www.shop.com', { target, fetcher: cfFetch({ 'www.shop.com': { CNAME: ['stores.fullfilio.example'], CAA: ['0 issue "pki.goog"'] } }) })
    expect(d.issues.map((i) => i.code)).not.toContain('CAA')
  })

  it('an ALIAS at the root (answers with our target\'s own addresses) is pointed, and the provider is named', async () => {
    const zone: Zone = {
      'stores.fullfilio.example': { A: ['104.21.50.1', '172.67.1.2'] },
      'shop.com': { A: ['104.21.50.1', '172.67.1.2'], NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] },
    }
    const d = await diagnose('shop.com', { target, fetcher: cfFetch(zone) })
    expect(d.pointed).toBe(true)
    expect(d.records.every((r) => r.ok && r.note === 'Points to Fullfilio (ALIAS / flattening)')).toBe(true)
    expect(d.regions.every((r) => r.ok)).toBe(true)
    expect(d.dns_host).toEqual({ provider: 'Cloudflare', nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], mixed: false })
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('nameservers from two companies are an error (the old site keeps coming back)', async () => {
    const zone: Zone = { 'www.shop.com': { CNAME: ['stores.fullfilio.example'] }, 'shop.com': { NS: ['ns1.dns-parking.com', 'ns1.shopify.com'] } }
    const d = await diagnose('www.shop.com', { target, fetcher: cfFetch(zone) })
    expect(d.dns_host).toMatchObject({ provider: null, mixed: true })
    expect(d.issues[0]).toMatchObject({ code: 'NS_MIXED', severity: 'error' })
  })

  it('an A record still on Shopify says to delete it; one only some resolvers remember is a warning', async () => {
    const left = await diagnose('shop.com', { target, fetcher: cfFetch({ 'shop.com': { A: ['23.227.38.65'] } }, false) })
    expect(left.records[0]).toMatchObject({ ok: false, note: 'Still points to Shopify — delete this record' })
    expect(left.issues.find((i) => i.code === 'OLD_HOST')).toMatchObject({ severity: 'error' })

    const zone: Zone = { 'stores.fullfilio.example': { A: ['104.21.50.1'] }, 'shop.com': { A: ['104.21.50.1'] } }
    const cached = await diagnose('shop.com', { target, fetcher: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      // One region still gets the old address.
      if (url.searchParams.get('edns_client_subnet') === REGIONS[0].subnet && url.searchParams.get('type') === 'A') return Response.json({ Status: 0, Answer: [{ name: 'shop.com', type: 1, data: '23.227.38.65' }] })
      return cfFetch(zone)(input, init)
    }) as typeof fetch })
    expect(cached.pointed).toBe(true)
    expect(cached.issues.find((i) => i.code === 'OLD_HOST')).toMatchObject({ severity: 'warning', title: 'Some visitors still reach Shopify' })
    expect(cached.regions[0].ok).toBe(false)
  })

  it('checks the verification TXT record the hosting asked for', async () => {
    const expect_ = [{ type: 'TXT' as const, name: '_cf-custom-hostname.shop.com', value: 'abc-123' }]
    const zone: Zone = { 'www.shop.com': { CNAME: ['stores.fullfilio.example'] } }
    const missing = await diagnose('www.shop.com', { target, expect: expect_, fetcher: cfFetch(zone) })
    expect(missing.records.find((r) => r.type === 'TXT')).toMatchObject({ name: '_cf-custom-hostname', ok: false })
    expect(missing.issues.map((i) => i.code)).toContain('TXT_MISSING')
    zone['_cf-custom-hostname.shop.com'] = { TXT: ['"abc-123"'] }
    const found = await diagnose('www.shop.com', { target, expect: expect_, fetcher: cfFetch(zone) })
    expect(found.records.find((r) => r.type === 'TXT')).toMatchObject({ ok: true, note: 'Found' })
    expect(found.issues.map((i) => i.code)).not.toContain('TXT_MISSING')
    // Added again: the hosting asks for a new code while the old one is still in DNS.
    const again = await diagnose('www.shop.com', { target, expect: [{ ...expect_[0], value: 'new-456' }], fetcher: cfFetch(zone) })
    expect(again.records.find((r) => r.type === 'TXT')).toMatchObject({ ok: false, note: 'Has an old value (abc-123) — change it to this one' })
    expect(again.issues.find((i) => i.code === 'TXT_MISSING')?.title).toBe('Verification record has an old value')
  })

  it('names DNS companies and old website builders', () => {
    expect(dnsHostOf('ns1.dns-parking.com')).toBe('Hostinger')
    expect(dnsHostOf('dns1.registrar-servers.com.')).toBe('Namecheap')
    expect(dnsHostOf('ada.ns.cloudflare.com')).toBe('Cloudflare')
    expect(dnsHostOf('ns1.example.net')).toBeNull()
    expect(oldHostOf('23.227.38.65')).toBe('Shopify')
    expect(oldHostOf('8.8.8.8')).toBeNull()
  })
})

describe('scheduled domain re-check', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const mins = (n: number) => new Date(now - n * 60_000).toISOString()
  it('re-checks a waiting domain every 10 minutes, hourly after 3 days, and never a live one', async () => {
    const { dueForRecheck } = await import('../domains/handler.ts')
    expect(dueForRecheck({ status: 'VERIFYING', checked_at: mins(10), created_at: mins(60) }, now)).toBe(true)
    expect(dueForRecheck({ status: 'VERIFYING', checked_at: mins(3), created_at: mins(60) }, now)).toBe(false)
    expect(dueForRecheck({ status: 'ERROR', checked_at: null, created_at: mins(5) }, now)).toBe(true)
    expect(dueForRecheck({ status: 'VERIFYING', checked_at: mins(20), created_at: mins(5 * 24 * 60) }, now)).toBe(false)
    expect(dueForRecheck({ status: 'VERIFYING', checked_at: mins(60), created_at: mins(5 * 24 * 60) }, now)).toBe(true)
    expect(dueForRecheck({ status: 'ACTIVE', checked_at: null, created_at: null }, now)).toBe(false)
    const stale = { issues: [{ code: 'NO_RECORDS', severity: 'error' as const, title: '', detail: '' }] } as never
    expect(dueForRecheck({ status: 'ACTIVE', checked_at: mins(10), created_at: mins(60), diagnostics: stale }, now)).toBe(true)
    expect(dueForRecheck({ status: 'REMOVED', checked_at: null, created_at: null }, now)).toBe(false)
  })
})

describe('root domain needs Cloudflare DNS', () => {
  it('flags a root on Hostinger or Namecheap, not on Cloudflare DNS and not a subdomain', async () => {
    const target = cloudflareTarget('stores.fullfilio.example')
    const zone: Zone = {
      'stores.fullfilio.example': { A: ['104.21.50.1'] },
      'shop.com': { A: ['104.21.50.1'], NS: ['ns1.dns-parking.com', 'ns2.dns-parking.com'] },
      'www.shop.com': { CNAME: ['stores.fullfilio.example'] },
    }
    const f = fakeFetch(zone)
    const root = await diagnose('shop.com', { target, fetcher: f })
    expect(root.issues[0]).toMatchObject({ code: 'NEEDS_CLOUDFLARE', severity: 'error', title: 'Main domain works only with Cloudflare DNS' })
    expect(root.issues[0].detail).toMatch(/on Hostinger now.*www\.shop\.com/)
    expect((await diagnose('www.shop.com', { target, fetcher: f })).issues.map((i) => i.code)).not.toContain('NEEDS_CLOUDFLARE')
    zone['shop.com'].NS = ['dns1.registrar-servers.com']
    expect((await diagnose('shop.com', { target, fetcher: f })).issues.map((i) => i.code)).toContain('NEEDS_CLOUDFLARE')
    zone['shop.com'].NS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']
    expect((await diagnose('shop.com', { target, fetcher: f })).issues.map((i) => i.code)).not.toContain('NEEDS_CLOUDFLARE')
  })
})

describe('root domain through our proxy (any DNS company)', () => {
  const target = proxyTarget('198.51.100.20', 'stores.fullfilio.example')
  const ours = (zone: Zone) => {
    const dns = fakeFetch(zone)
    return (async (input: string | URL, init?: RequestInit) => new URL(String(input)).pathname === '/'
      ? new Response('ok', { headers: { 'x-fullfilio': 'store' } }) : dns(input, init)) as typeof fetch
  }

  it('an A record to the proxy on Hostinger is live, with no "use www"', async () => {
    const d = await diagnose('shop.com', { target, fetcher: ours({ 'shop.com': { A: ['198.51.100.20'], NS: ['ns1.dns-parking.com', 'ns2.dns-parking.com'] } }) })
    expect(d.pointed).toBe(true)
    expect(d.live_everywhere).toBe(true)
    expect(d.tls.served_by_store).toBe(true)
    expect(d.issues).toEqual([])
  })

  it('an old ALIAS or A record says to set the A record to the proxy', async () => {
    // Cloudflare answers the old ALIAS with a 403 page, not the store.
    const d = await diagnose('shop.com', { target, fetcher: fakeFetch({ 'shop.com': { A: ['104.21.50.1'] } }, { ok: true, vercel: false }) })
    expect(d.pointed).toBe(false)
    expect(d.records[0]).toMatchObject({ ok: false, note: 'Should be 198.51.100.20' })
    expect(d.issues.find((i) => i.code === 'WRONG_TARGET')?.detail).toContain('198.51.100.20')
  })
})

describe('root domain on Cloudflare DNS', () => {
  it('connects through the CNAME: no TXT asked for, no issues', async () => {
    const target = cloudflareTarget('stores.fullfilio.example')
    const zone: Zone = {
      'stores.fullfilio.example': { A: ['104.21.50.1', '172.67.1.2'] },
      'shop.com': { A: ['104.21.50.1', '172.67.1.2'], NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] },
    }
    const dns = fakeFetch(zone)
    const fetcher = (async (input: string | URL, init?: RequestInit) => new URL(String(input)).pathname === '/'
      ? new Response('ok', { headers: { 'x-fullfilio': 'store' } }) : dns(input, init)) as typeof fetch
    const d = await diagnose('shop.com', { target, fetcher, expect: [{ type: 'TXT', name: '_cf-custom-hostname.shop.com', value: 'abc' }] })
    expect(d.pointed).toBe(true)
    expect(d.records.some((r) => r.type === 'TXT')).toBe(false)
    expect(d.issues).toEqual([])
  })
})

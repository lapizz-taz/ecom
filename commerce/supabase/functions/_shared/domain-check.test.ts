import { describe, expect, it } from 'vitest'
import { apexOf, cloudflareTarget, diagnose, domainKind, hostLabel, isCloudflare, isVercelA, isVercelCname } from './domain-check.ts'

type Zone = Record<string, Partial<Record<'A' | 'AAAA' | 'CNAME' | 'CAA', string[]>>>
const CODE = { A: 1, CNAME: 5, AAAA: 28, CAA: 257 } as const

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
})

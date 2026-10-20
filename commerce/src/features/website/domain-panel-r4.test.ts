// Round 4 of the custom-domain audit: the PANEL. Does the domain list, the status popup and the
// remove dialog say where each domain really stands? Fixtures mirror what the domains function
// saves (supabase/functions/domains/handler.ts + _shared/domain-check.ts, exact texts); a few are
// re-derived below from the real diagnose()/baseRecords()/dueForRecheck() with faked DNS, so the
// states are reachable. Each test asserts the CORRECT behaviour: it.fails marks a defect on the
// current code (the comment above it says what should happen), the plain tests are coverage.
// Rendered with renderToStaticMarkup (no DOM); the phone/desktop layout was checked separately in
// Chromium at 390×844 and 1280×800 with the same fixtures.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DomainDetail, DomainList } from '@/features/website/domain-status'
import type { DnsRecord, DomainDiagnosis, StoreDomain } from '@/services/website'
import { diagnose, proxyTarget, VERCEL_TARGET, cloudflareTarget } from '../../../supabase/functions/_shared/domain-check'
import { baseRecords, dueForRecheck, ownershipRecord } from '../../../supabase/functions/domains/handler'

// A Radix portal renders nothing on the server: render dialogs in place so the remove dialog can be read.
vi.mock('radix-ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('radix-ui')>()
  return { ...real, Dialog: { ...real.Dialog, Portal: ({ children }: { children?: unknown }) => children } }
})

// <fixtures> — plain data with type imports only (the visual harness reuses this block as is).
export const IP = '144.24.232.70'
export const TARGET = 'stores.fullfilio.com'
export const CODE = '7f3c9a1e5b2d4c6f8a0b1c2d3e4f5a6b'
const OLD_CODE = '0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const VERCEL_A = '76.76.21.21'
const PARKING = '2.57.91.10' // Hostinger's parking page
const CF_EDGE = ['104.21.7.111', '172.67.130.48']
const STRAY_V6 = '2a02:4780:13:1234::1'
const NOW = '2026-10-20T08:00:00Z'
const WAITING_TXT = 'Waiting for the TXT record below (it proves the domain is yours)'
const LIVE = 'Live — the store opens on this domain with HTTPS'
export const LONG_SUB = 'bestellungundlieferservicefuerallekundeninbayern'
export const LONG_IDN = `${LONG_SUB}.xn--mnchner-feinkost-gnb.de` // 76 chars, IDN apex
export const LONG_APEX = 'meinlieblingsblumenladenundgeschenkeshopinmuenchenschwabing.de' // 62 chars, one unbroken label

type Diag = DomainDiagnosis
type Issue = Diag['issues'][number]
type Found = Diag['records'][number]

const NS = {
  Hostinger: { provider: 'Hostinger', nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'], mixed: false },
  Cloudflare: { provider: 'Cloudflare', nameservers: ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com'], mixed: false },
  Porkbun: { provider: 'Porkbun', nameservers: ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com', 'maceio.ns.porkbun.com', 'salvador.ns.porkbun.com'], mixed: false },
  GoDaddy: { provider: 'GoDaddy', nameservers: ['ns51.domaincontrol.com', 'ns52.domaincontrol.com'], mixed: false },
  Vercel: { provider: 'Vercel', nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'], mixed: false },
  Mixed: { provider: null, nameservers: ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com', 'ns1.dns-parking.com', 'ns2.dns-parking.com'], mixed: true },
}
const REGION_NAMES = [['na', 'North America'], ['sa', 'South America'], ['eu', 'Europe'], ['af', 'Africa'], ['as', 'Asia'], ['oc', 'Australia']] as const
const regions = (ok: number, seen: string[] = [IP], other: string[] = []) =>
  REGION_NAMES.map(([code, name], i) => ({ code, name, ok: i < ok, answers: i < ok ? seen : other }))
const resolvers = (ok: boolean, seen: string[] = [IP]) => ['Google', 'Cloudflare', 'AdGuard'].map((name) => ({ name, ok, answers: seen }))

/** The HTTPS probe results diagnose() writes (domain-check.ts, `tls`). */
export const TLS = {
  ok: { ok: true, detail: 'TLS certificate provisioned for secure connections', served_by_store: true, status: 200 },
  certWait: { ok: false, detail: 'The certificate is not ready yet (it is issued once DNS points at the store)', served_by_store: null, status: null },
  noAnswer: { ok: false, detail: 'The domain did not answer over HTTPS yet', served_by_store: null, status: null },
  other: { ok: true, detail: 'HTTPS works, but another server answered (not the store)', served_by_store: false, status: 200 },
  down502: { ok: true, detail: 'The store did not answer just now (HTTP 502)', served_by_store: null, status: 502 },
} satisfies Record<string, Diag['tls']>

// The records to add (mirrors handler.baseRecords / ownershipRecord; checked against them below).
const apexRecords = (d: string): DnsRecord[] => [
  { type: 'A', name: '@', value: IP, why: 'Points your domain at the store (delete any other A, AAAA or ALIAS record for @)' },
  { type: 'A', name: 'www', value: IP, why: `So www.${d} opens the store too (visitors are sent on to ${d}); delete any other www record` },
]
const wwwRecords: DnsRecord[] = [{ type: 'A', name: 'www', value: IP, why: 'Points www at the store (delete any other A, AAAA or CNAME record for www)' }]
const cnameRecord = (sub: string): DnsRecord => ({ type: 'CNAME', name: sub, value: TARGET, why: 'Points this subdomain at the store' })
const txtRecord = (name: string): DnsRecord => ({ type: 'TXT', name, value: `fullfilio-verify=${CODE}`, why: 'Proves the domain is yours (only needed until the domain is live)' })

// Rows of "Records found".
const row = (type: string, name: string, value: string, ok: boolean, note?: string): Found => (note ? { type, name, value, ok, note } : { type, name, value, ok })
const A_ROOT = row('A', '@', IP, true)
const A_WWW = row('A', 'www', IP, true)
const txtRow = (name: string, note = 'Not found yet — add it at your domain provider') => row('TXT', name, `fullfilio-verify=${CODE}`, false, note)
const OLD_DNS = 'From your old DNS (Hostinger), which no longer counts'

// Issues, with the texts domain-check.ts / handler.ts write.
const issue = (code: string, severity: Issue['severity'], title: string, detail: string): Issue => ({ code, severity, title, detail })
const TXT_MISSING = (name: string) => issue('TXT_MISSING', 'error', 'Verification record missing',
  `Add the TXT record ${name} shown below at your domain provider. It proves the domain is yours; the store cannot go live without it. A record added just now can take up to an hour to be seen.`)
const TLS_PENDING = issue('TLS_PENDING', 'info', 'Certificate on the way', 'DNS is correct. The HTTPS certificate is usually ready within a few minutes.')
const UNCONFIRMED = issue('UNCONFIRMED', 'warning', 'The last check could not confirm the store',
  'Visitors still reach the store. One check did not get a clear answer (a timeout, or a DNS checker not answering); it runs again within minutes by itself.')
const CHECK_FAILED = issue('CHECK_FAILED', 'error', 'Could not check DNS right now', 'The DNS resolvers did not answer. Try again in a minute.')
const WWW_MISSING = (d: string) => issue('WWW_SETUP', 'warning', `www.${d} is not set up yet`,
  `Add an A record for www pointing to ${IP}, so visitors who type www.${d} reach the store (they are sent on to ${d}).`)
const STORE_DOWN = (d: string) => issue('STORE_DOWN', 'warning', 'The store did not answer just now',
  `https://${d} reached the store's server, which answered with an error (HTTP 502). This usually clears by itself; we keep checking.`)
const NS_SWITCHING = issue('NS_SWITCHING', 'error', 'Your DNS moved to Cloudflare — add the records there',
  'shop.com now uses Cloudflare (ana.ns.cloudflare.com, bob.ns.cloudflare.com), but DNS servers still answer from your old DNS (Hostinger) for up to 48 hours, so the records seen here are the old ones, not Cloudflare\'s. Add the records below at Cloudflare: that is where your DNS is now. We keep checking by ourselves and see them once DNS servers catch up. Setting the same records at Hostinger too lets those visitors reach the store meanwhile.')

const diag = (p: Partial<Diag> = {}): Diag => ({
  checked_at: NOW, kind: 'apex', pointed: true, live_everywhere: true, records: [A_ROOT, A_WWW], regions: regions(6),
  resolvers: resolvers(true), tls: TLS.ok, issues: [], dns_host: NS.Hostinger, ...p,
})
const dom = (p: Partial<StoreDomain> & Pick<StoreDomain, 'domain' | 'status' | 'records'>): StoreDomain => ({
  id: p.domain, detail: null, created_at: '2026-10-20T07:40:00Z', checked_at: NOW, is_primary: true, diagnostics: null, verified_at: null, ...p,
})
const proven = '2026-10-18T09:00:00Z'

export const FIX = {
  // Just added; the add call failed before its first check (row still PENDING).
  fresh: dom({ domain: 'shop.com', status: 'PENDING', records: [...apexRecords('shop.com'), txtRecord('_fullfilio')], checked_at: null }),
  // First check after adding (own.fresh: the TXT is not looked up yet), A records already right, Hostinger.
  waitingTxt: dom({ domain: 'shop.com', status: 'VERIFYING', detail: WAITING_TXT, records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ tls: TLS.certWait }) }),
  txtMissing: dom({ domain: 'shop.com', status: 'VERIFYING', detail: 'Verification record missing', records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ tls: TLS.certWait, records: [A_ROOT, txtRow('_fullfilio'), A_WWW], issues: [TXT_MISSING('_fullfilio')] }) }),
  txtWrongName: dom({ domain: 'shop.com', status: 'VERIFYING', detail: 'Verification record has the wrong name', records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ tls: TLS.certWait, records: [A_ROOT, txtRow('_fullfilio', 'Found at _fullfilio.shop.com.shop.com: enter only the name shown here'), A_WWW],
      issues: [issue('TXT_MISSING', 'error', 'Verification record has the wrong name', 'It was found at _fullfilio.shop.com.shop.com: your DNS company adds shop.com to the name by itself. Edit the record and enter only _fullfilio as its name.')] }) }),
  txtOldValue: dom({ domain: 'shop.com', status: 'VERIFYING', detail: 'Verification record has an old value', records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ tls: TLS.certWait, records: [A_ROOT, txtRow('_fullfilio', `Has another value (fullfilio-verify=${OLD_CODE}) — change it to this one`), A_WWW],
      issues: [issue('TXT_MISSING', 'error', 'Verification record has an old value', `The TXT record _fullfilio holds fullfilio-verify=${OLD_CODE}, not the value shown below. Edit the record and paste the value shown below.`)] }) }),
  // Proven, but @ and www still on Hostinger's parking page.
  aWrong: dom({ domain: 'shop.com', status: 'VERIFYING', verified_at: proven, detail: 'Your domain still points to Hostinger (website or parking page)', records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, live_everywhere: false, tls: TLS.other, regions: regions(0, [IP], [PARKING]), resolvers: resolvers(false, [PARKING]),
      records: [row('A', '@', PARKING, false, `Still points to Hostinger (website or parking page) — change it to ${IP}`), row('A', 'www', PARKING, false, `Should be A ${IP}`)],
      issues: [
        issue('OLD_HOST', 'error', 'Your domain still points to Hostinger (website or parking page)', `Your DNS still has an A record for @ pointing to Hostinger (website or parking page). Change it to ${IP} at Hostinger.`),
        issue('WRONG_TARGET', 'error', 'DNS records point somewhere else', `Change the A record for @ to ${IP} and delete any other A records for @.`),
        issue('WWW_SETUP', 'warning', 'www.shop.com is not set up yet', `www.shop.com has an A record to ${PARKING}. Replace it with an A record for www pointing to ${IP}, so visitors who type www reach the store (they are sent on to shop.com).`),
      ] }) }),
  // A CNAME at @ (to the Cloudflare target) on a proxy root, at Porkbun.
  cnameApex: dom({ domain: 'shop.com', status: 'VERIFYING', verified_at: proven, detail: 'DNS records point somewhere else', records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, live_everywhere: false, tls: TLS.certWait, dns_host: NS.Porkbun, regions: regions(0, [IP], [TARGET, ...CF_EDGE]), resolvers: resolvers(false, [TARGET, ...CF_EDGE]),
      records: [row('CNAME', '@', TARGET, false, `Should be an A record to ${IP}`), row('CNAME', 'www', TARGET, false, `Should be A ${IP} (or a CNAME to shop.com)`)],
      issues: [
        issue('WRONG_TARGET', 'error', 'DNS records point somewhere else', `Delete the CNAME record for @ and add an A record for @ pointing to ${IP}.`),
        issue('WWW_SETUP', 'warning', 'www.shop.com is not set up yet', `www.shop.com has a CNAME to ${TARGET}. Replace it with an A record for www pointing to ${IP}, so visitors who type www reach the store (they are sent on to shop.com).`),
      ] }) }),
  orange: dom({ domain: 'shop.com', status: 'VERIFYING', verified_at: proven, detail: 'Turn off the orange cloud in Cloudflare', records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, live_everywhere: false, tls: TLS.other, dns_host: NS.Cloudflare, regions: regions(0, [IP], CF_EDGE), resolvers: resolvers(false, CF_EDGE),
      records: [
        ...CF_EDGE.map((ip) => row('A', '@', ip, false, 'Your Cloudflare proxy (orange cloud) answers here, not the store')),
        ...CF_EDGE.map((ip) => row('A', 'www', ip, false, 'Cloudflare proxy (orange cloud): set www to "DNS only"')),
      ],
      issues: [
        issue('ORANGE_CLOUD', 'error', 'Turn off the orange cloud in Cloudflare', `In Cloudflare → shop.com → DNS → Records, edit the @ record: it must be an A record to ${IP} (not a CNAME or ALIAS) with Proxy status "DNS only" (grey cloud). It is proxied (orange) now, so your own Cloudflare answers instead of the store and the HTTPS certificate cannot be issued. It connects by itself within about 10 minutes of the change.`),
        issue('WWW_SETUP', 'warning', 'www.shop.com is not set up yet', `In Cloudflare → shop.com → DNS → Records, set the www record (A ${IP}, or a CNAME to shop.com) to Proxy status "DNS only" (grey cloud).`),
      ] }) }),
  // Nameservers just moved Hostinger → Cloudflare (Cloudflare copied the old records); resolvers still on Hostinger.
  nsSwitching: dom({ domain: 'shop.com', status: 'VERIFYING', detail: NS_SWITCHING.title, records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ pointed: false, live_everywhere: false, tls: TLS.other, regions: regions(0, [IP], [PARKING]), resolvers: resolvers(false, [PARKING]),
      dns_host: { ...NS.Cloudflare, moving_from: { provider: 'Hostinger', nameservers: NS.Hostinger.nameservers } },
      records: [row('A', '@', PARKING, false, OLD_DNS), txtRow('_fullfilio', OLD_DNS), row('A', 'www', PARKING, false, OLD_DNS)], issues: [NS_SWITCHING] }) }),
  // The same switch on a domain that was live (old DNS still points at the proxy): kept live.
  nsSwitchingLive: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: `Live — the last check found a problem: ${NS_SWITCHING.title}`, records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, dns_host: { ...NS.Cloudflare, moving_from: { provider: 'Hostinger', nameservers: NS.Hostinger.nameservers } },
      records: [row('A', '@', IP, false, OLD_DNS), row('A', 'www', IP, false, OLD_DNS)], issues: [NS_SWITCHING, UNCONFIRMED] }) }),
  liveClean: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: LIVE, records: apexRecords('shop.com'), diagnostics: diag() }),
  // Kept live: the HTTPS probe timed out (DNS fine). TLS_PENDING is what diagnose() adds for a pointed domain with tls.ok false.
  liveProbeTimeout: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: 'Live — the last check could not finish; it runs again by itself', records: apexRecords('shop.com'),
    diagnostics: diag({ tls: TLS.noAnswer, issues: [TLS_PENDING, UNCONFIRMED] }) }),
  // Live; the DNS checker (DoH) did not answer at all, the store answered over HTTPS: ACTIVE straight away.
  liveDnsOutage: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: LIVE, records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, live_everywhere: false, records: [], regions: regions(0, [IP], []), resolvers: resolvers(false, []), issues: [CHECK_FAILED] }) }),
  // Live; DoH down AND the probe timed out: kept live, UNCONFIRMED.
  liveDnsOutageTimeout: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: `Live — the last check found a problem: ${CHECK_FAILED.title}`, records: apexRecords('shop.com'),
    diagnostics: diag({ pointed: false, live_everywhere: false, records: [], regions: regions(0, [IP], []), resolvers: resolvers(false, []), tls: TLS.noAnswer, issues: [CHECK_FAILED, UNCONFIRMED] }) }),
  // Live; the proxy answered 502 (the store behind it hiccupped): kept live.
  liveStoreDown: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: 'Live — the last check found a problem: The store did not answer just now', records: apexRecords('shop.com'),
    diagnostics: diag({ tls: TLS.down502, issues: [STORE_DOWN('shop.com'), UNCONFIRMED] }) }),
  // Live with Hostinger's default AAAA left at @.
  liveAaaa: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: LIVE, records: apexRecords('shop.com'),
    diagnostics: diag({ records: [A_ROOT, row('AAAA', '@', STRAY_V6, false, 'Remove: the store has no IPv6 address'), A_WWW],
      issues: [issue('AAAA', 'error', 'IPv6 (AAAA) records found', `Delete the AAAA record for @ (${STRAY_V6}) at Hostinger. Visitors on IPv6 reach another server, and the HTTPS certificate cannot be issued or renewed while it is there (it is checked over IPv6 first).`)] }) }),
  // Root live, www not set up.
  rootWwwMissing: dom({ domain: 'shop.com', status: 'ACTIVE', verified_at: proven, detail: LIVE, records: apexRecords('shop.com'),
    diagnostics: diag({ records: [A_ROOT, row('A', 'www', '—', false, `Not found yet — add an A record for www pointing to ${IP}`)], issues: [WWW_MISSING('shop.com')] }) }),
  // Cloudflare for SaaS subdomain, CNAME right, TXT not added yet (second check), GoDaddy.
  saasTxt: dom({ domain: 'shop.brand.com', status: 'VERIFYING', detail: 'Verification record missing', records: [cnameRecord('shop'), txtRecord('_fullfilio.shop')],
    diagnostics: diag({ kind: 'subdomain', dns_host: NS.GoDaddy, tls: TLS.certWait, records: [row('CNAME', 'shop', TARGET, true), txtRow('_fullfilio.shop')],
      regions: regions(6, [TARGET]), resolvers: resolvers(true, [TARGET]), issues: [TXT_MISSING('_fullfilio.shop')] }) }),
  // Proven and attached; Cloudflare is issuing the certificate.
  saasHosting: dom({ domain: 'shop.brand.com', status: 'VERIFYING', verified_at: proven, detail: 'DNS is right — the hosting is confirming the domain and issuing HTTPS (usually 5–15 minutes)', records: [cnameRecord('shop')],
    diagnostics: diag({ kind: 'subdomain', dns_host: NS.GoDaddy, tls: TLS.certWait, records: [row('CNAME', 'shop', TARGET, true)], regions: regions(6, [TARGET]), resolvers: resolvers(true, [TARGET]),
      issues: [TLS_PENDING], hosting: { status: 'active', ssl_status: 'pending_validation', error: null } }) }),
  saasLive: dom({ domain: 'shop.brand.com', status: 'ACTIVE', verified_at: proven, detail: LIVE, records: [cnameRecord('shop')],
    diagnostics: diag({ kind: 'subdomain', dns_host: NS.GoDaddy, records: [row('CNAME', 'shop', TARGET, true)], regions: regions(6, [TARGET]), resolvers: resolvers(true, [TARGET]),
      hosting: { status: 'active', ssl_status: 'active', error: null } }) }),
  // No hosting API (MANUAL): proven, DNS right; the platform owner has not attached it yet.
  manualProven: dom({ domain: 'bazaar.com.bd', status: 'MANUAL', verified_at: proven, detail: 'Add the DNS record below; the platform owner then connects the domain to the hosting.',
    records: [{ type: 'A', name: '@', value: VERCEL_A, why: 'Points your domain at the store' }],
    diagnostics: diag({ tls: TLS.certWait, dns_host: NS.Vercel, records: [row('A', '@', VERCEL_A, true)], regions: regions(6, [VERCEL_A]), resolvers: resolvers(true, [VERCEL_A]), issues: [TLS_PENDING] }) }),
  // MANUAL, first check (TXT not looked up yet), DNS already right.
  manualTxt: dom({ domain: 'bazaar.com.bd', status: 'MANUAL', detail: WAITING_TXT,
    records: [{ type: 'A', name: '@', value: VERCEL_A, why: 'Points your domain at the store' }, txtRecord('_fullfilio')],
    diagnostics: diag({ tls: TLS.certWait, dns_host: NS.Vercel, records: [row('A', '@', VERCEL_A, true)], regions: regions(6, [VERCEL_A]), resolvers: resolvers(true, [VERCEL_A]) }) }),
  // Cloudflare for SaaS: proven, but attaching the custom hostname failed (ERROR).
  error: dom({ domain: 'shop.brand.com', status: 'ERROR', verified_at: proven, detail: 'Not attached to the hosting yet — press Check again', records: [cnameRecord('shop')],
    diagnostics: diag({ kind: 'subdomain', dns_host: NS.GoDaddy, tls: TLS.certWait, records: [row('CNAME', 'shop', TARGET, true)], regions: regions(6, [TARGET]), resolvers: resolvers(true, [TARGET]), issues: [TLS_PENDING] }) }),
  // www row next to the primary root (proven through its twin).
  wwwLive: dom({ domain: 'www.shop.com', status: 'ACTIVE', is_primary: false, verified_at: proven, detail: LIVE, records: wwwRecords,
    diagnostics: diag({ kind: 'subdomain', records: [row('A', 'www', IP, true)] }) }),
  wwwWaiting: dom({ domain: 'www.shop.com', status: 'VERIFYING', is_primary: false, verified_at: proven, detail: 'No DNS records found', records: wwwRecords,
    diagnostics: diag({ kind: 'subdomain', pointed: false, live_everywhere: false, records: [], regions: regions(0, [IP], []), resolvers: resolvers(false, []), tls: TLS.noAnswer,
      issues: [issue('NO_RECORDS', 'error', 'No DNS records found', `Add an A record for www pointing to ${IP} at your domain provider.`)] }) }),
  // Cloudflare for SaaS without the root proxy: a root at Hostinger cannot connect.
  needsCloudflare: dom({ domain: 'shop.com', status: 'VERIFYING', detail: 'Main domain works only with Cloudflare DNS',
    records: [{ type: 'CNAME', name: '@', value: TARGET, why: 'Points your domain at the store (a CNAME at the root, also called ALIAS or flattening; if your provider cannot, use www instead)' }, txtRecord('_fullfilio')],
    diagnostics: diag({ pointed: false, live_everywhere: false, tls: TLS.other, regions: regions(0, [IP], [PARKING]), resolvers: resolvers(false, [PARKING]),
      records: [row('A', '@', PARKING, false, 'Still points to Hostinger (website or parking page) — delete this record')],
      issues: [
        issue('NEEDS_CLOUDFLARE', 'error', 'Main domain works only with Cloudflare DNS', 'shop.com can connect only when its DNS is on Cloudflare (free); it is on Hostinger now, which cannot. Move the DNS to Cloudflare with the steps below, or use www.shop.com, which works at any DNS company.'),
        issue('OLD_HOST', 'error', 'Your domain still points to Hostinger (website or parking page)', 'Your DNS still has an A record for @ pointing to Hostinger (website or parking page). Delete it at Hostinger.'),
        issue('WRONG_TARGET', 'error', 'DNS records point somewhere else', `Point @ at ${TARGET} with a CNAME (or ALIAS / ANAME) record and delete the A and AAAA records for @.`),
      ] }) }),
  // 76-char IDN subdomain on Cloudflare for SaaS; nameservers of two companies; TXT missing.
  longIdn: dom({ domain: LONG_IDN, status: 'VERIFYING', is_primary: false, detail: 'Your domain uses nameservers from two companies', records: [cnameRecord(LONG_SUB), txtRecord(`_fullfilio.${LONG_SUB}`)],
    diagnostics: diag({ kind: 'subdomain', dns_host: NS.Mixed, tls: TLS.certWait, live_everywhere: false, regions: regions(4, [TARGET], ['203.0.113.80']), resolvers: resolvers(true, [TARGET]),
      records: [row('CNAME', LONG_SUB, TARGET, true), txtRow(`_fullfilio.${LONG_SUB}`)],
      issues: [
        issue('NS_MIXED', 'error', 'Your domain uses nameservers from two companies', `It lists ${NS.Mixed.nameservers.join(', ')}. Visitors randomly get the records of one or the other, so the old site keeps coming back. At the company where you bought the domain, set the nameservers to only one company (the one where you edit DNS), then wait an hour.`),
        TXT_MISSING(`_fullfilio.${LONG_SUB}`),
      ] }) }),
  // 62-char apex on the proxy, kept live through a probe timeout, www missing (long issue title + footer).
  longApex: dom({ domain: LONG_APEX, status: 'ACTIVE', verified_at: proven, detail: `Live — the last check found a problem: www.${LONG_APEX} is not set up yet`, records: apexRecords(LONG_APEX),
    diagnostics: diag({ tls: TLS.noAnswer, records: [A_ROOT, row('A', 'www', '—', false, `Not found yet — add an A record for www pointing to ${IP}`)],
      issues: [WWW_MISSING(LONG_APEX), TLS_PENDING, UNCONFIRMED] }) }),
  // Waiting for its TXT for 5 days: re-checked hourly now (dueForRecheck), not every 10 minutes.
  waitingDays: dom({ domain: 'shop.com', status: 'VERIFYING', detail: 'Verification record missing', created_at: '2026-10-15T08:00:00Z', checked_at: '2026-10-20T07:45:00Z',
    status_changed_at: '2026-10-15T08:00:00Z', records: [...apexRecords('shop.com'), txtRecord('_fullfilio')],
    diagnostics: diag({ checked_at: '2026-10-20T07:45:00Z', tls: TLS.certWait, records: [A_ROOT, txtRow('_fullfilio'), A_WWW], issues: [TXT_MISSING('_fullfilio')] }) } as Partial<StoreDomain> & Pick<StoreDomain, 'domain' | 'status' | 'records'>),
} satisfies Record<string, StoreDomain>
for (const [key, d] of Object.entries(FIX)) d.id = key
/** What each fixture's primary domain is (the www rows sit next to a primary root). */
export const primaryOf = (d: StoreDomain) => (d.is_primary ? d.domain : d.domain.startsWith('www.') ? d.domain.slice(4) : 'shop.com')
// </fixtures>

// --- rendering helpers ----------------------------------------------------------------------

const noop = () => undefined
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const html = (d: StoreDomain, extra: { onUseWww?: () => Promise<unknown> } = {}) => renderToStaticMarkup(createElement(DomainDetail, {
  d, primary: primaryOf(d), canEdit: true, checking: false, inDialog: true, onCheck: noop, onRemove: noop, onBack: noop, onMakePrimary: async () => undefined, ...extra,
}))
const popup = (d: StoreDomain, extra?: { onUseWww?: () => Promise<unknown> }) => text(html(d, extra))
/** The status word in the domain list. */
const chip = (d: StoreDomain) => decode(renderToStaticMarkup(createElement(DomainList, { domains: [d], onOpen: noop })).match(/ring-1 ring-inset[^"]*">([^<]*)</)?.[1] ?? '')
/** The line under the globe. */
const hero = (d: StoreDomain) => text(html(d).match(/<p class="mt-1 text-center[^"]*">(.*?)<\/p>/)?.[1] ?? '')
/** The status line at the bottom of the popup (its <span>, nested spans included). */
const footer = (d: StoreDomain) => {
  const h = html(d)
  const start = h.indexOf('<span class="w-full min-w-0')
  let depth = 0
  for (const m of h.slice(start).matchAll(/<span\b|<\/span>/g)) {
    depth += m[0] === '</span>' ? -1 : 1
    if (depth === 0) return text(h.slice(start, start + m.index + 7))
  }
  return ''
}
type Icon = 'ok' | 'warn' | 'bad' | 'wait' | 'info'
const iconOf = (h: string): Icon => {
  const cls = h.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? ''
  return cls.includes('lucide-clock') ? 'wait' : cls.includes('text-blue-600') ? 'ok' : cls.includes('text-amber-600') ? 'warn' : cls.includes('text-red-600') ? 'bad' : 'info'
}
/** The popup's sections in order: DNS, regions, HTTPS, then one per info note. */
const sections = (d: StoreDomain) => html(d).split('<div class="px-4 py-3">').slice(1).map((h) => ({
  icon: iconOf(h),
  title: text(h.match(/<span class="block text-\[13px\] font-medium">(.*?)<\/span>/)?.[1] ?? ''),
  sub: text(h.match(/<span class="block text-\[11px\] text-muted-foreground">(.*?)<\/span>/)?.[1] ?? ''),
  text: text(h),
}))
const https = (d: StoreDomain) => sections(d)[2]
const regionRow = (d: StoreDomain) => sections(d)[1]
const notes = (d: StoreDomain) => sections(d).slice(3).map((s) => s.title)
/** "Add at your domain provider": the copy buttons it offers (values and names). */
const toAdd = (d: StoreDomain) => {
  const h = html(d)
  const i = h.indexOf('Add at your domain provider')
  if (i < 0) return null
  const part = h.slice(i, h.indexOf('</ul>', i)) // the phone cards (the desktop table repeats them)
  return { values: [...part.matchAll(/aria-label="Copy the (\w+) value for ([^"]+)"/g)].map((m) => `${m[1]} ${decode(m[2])}`), names: [...part.matchAll(/title="Copy name">([^<]+)</g)].map((m) => decode(m[1])) }
}
const KEEP_CHECKING = 'We keep checking by ourselves every 10 minutes'

// The remove dialog's text: removeNote() is private to the page, so it is taken from the source as is.
type RemoveNote = (domains: StoreDomain[], removing: string | null, featureOff: boolean) => string
const removeNote: RemoveNote = (() => {
  const src = readFileSync(fileURLToPath(new URL('../../pages/admin/website.tsx', import.meta.url)), 'utf8')
  const start = src.indexOf('function removeNote(')
  const fn = src.slice(start, src.indexOf('\n}\n', start) + 2)
  const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(`${js}\nreturn removeNote`)() as RemoveNote
})()

// --- the status word, everywhere it shows ----------------------------------------------------

describe('panel r4: the status word for every state', () => {
  const expected: Record<keyof typeof FIX, string> = {
    fresh: 'Pending', waitingTxt: 'Pending', txtMissing: 'Not connected', txtWrongName: 'Not connected', txtOldValue: 'Not connected',
    aWrong: 'Not connected', cnameApex: 'Not connected', orange: 'Not connected', nsSwitching: 'Not connected', nsSwitchingLive: 'Connected · issue',
    liveClean: 'Connected', liveProbeTimeout: 'Connected · issue', liveDnsOutage: 'Connected · issue', liveDnsOutageTimeout: 'Connected · issue',
    liveStoreDown: 'Connected · issue', liveAaaa: 'Connected · issue', rootWwwMissing: 'Connected · issue', saasTxt: 'Not connected', saasHosting: 'Pending',
    saasLive: 'Connected', manualProven: 'Pending', manualTxt: 'Pending', error: 'Not connected', wwwLive: 'Connected', wwwWaiting: 'Not connected',
    needsCloudflare: 'Not connected', longIdn: 'Not connected', longApex: 'Connected · issue', waitingDays: 'Not connected',
  }
  for (const [key, label] of Object.entries(expected)) {
    it(`${key}: "${label}" in the list and in the popup header`, () => {
      const d = FIX[key as keyof typeof FIX]
      expect(chip(d)).toBe(label)
      expect(popup(d).slice(0, 200 + d.domain.length)).toContain(label)
    })
  }

  it('every live domain (ACTIVE) gets a blue band, never "Not connected", and never "We keep checking every 10 minutes"', () => {
    for (const d of Object.values(FIX).filter((x) => x.status === 'ACTIVE')) {
      expect(hero(d), d.id).toMatch(/^Connected/)
      expect(popup(d), d.id).not.toContain('Not connected')
      expect(popup(d), d.id).not.toContain(KEEP_CHECKING)
      expect(popup(d), d.id).not.toContain('Fix the following to connect your domain')
    }
  })
})

// --- states that render right ----------------------------------------------------------------

describe('panel r4: states that render right', () => {
  it('fresh add (no check yet): nothing claimed, every record to add has a copy button, the TXT name too', () => {
    const t = popup(FIX.fresh)
    expect(t).toContain('DNS not checked yet')
    expect(t).toContain('Regions not checked yet')
    expect(t).toContain('HTTPS not checked yet')
    expect(t).toContain(KEEP_CHECKING)
    expect(toAdd(FIX.fresh)).toEqual({ values: ['A @', 'A www', 'TXT _fullfilio'], names: ['www', '_fullfilio'] })
  })

  it('waiting for the TXT (proxy root, Hostinger): HTTPS waits for the TXT, A-record tip for Hostinger (not "the root cannot connect")', () => {
    const t = popup(FIX.waitingTxt)
    expect(https(FIX.waitingTxt).title).toBe('HTTPS starts once the TXT record below is found')
    expect(t).toContain('DNS for this domain is managed at Hostinger')
    expect(t).toContain('For @ use an A record with the address below')
    expect(t).not.toContain('The root (@) cannot connect at Hostinger')
    expect(t).toContain(WAITING_TXT)
    expect(toAdd(FIX.waitingTxt)?.values).toEqual(['A @', 'A www', 'TXT _fullfilio'])
  })

  it('TXT missing / wrong name / old value: red, "Fix the following", the exact problem, the TXT to copy', () => {
    for (const [d, title, note] of [
      [FIX.txtMissing, 'Verification record missing', 'Not found yet — add it at your domain provider'],
      [FIX.txtWrongName, 'Verification record has the wrong name', 'Found at _fullfilio.shop.com.shop.com: enter only the name shown here'],
      [FIX.txtOldValue, 'Verification record has an old value', `Has another value (fullfilio-verify=${OLD_CODE}) — change it to this one`],
    ] as const) {
      const t = popup(d)
      expect(hero(d)).toBe('Not connected · 6 of 6 regions')
      expect(t).toContain('Fix the following to connect your domain:')
      expect(t).toContain(`${title}.`)
      expect(t).toContain(note)
      expect(https(d).title).toBe('HTTPS starts once the TXT record below is found')
      expect(toAdd(d)?.values).toContain('TXT _fullfilio')
      expect(toAdd(d)?.names).toContain('_fullfilio')
    }
  })

  it('A record wrong (Hostinger parking): not pointing, the old host named, HTTPS "another server" in red', () => {
    const t = popup(FIX.aWrong)
    expect(t).toContain('DNS records are not pointing to Fullfilio yet')
    expect(t).toContain(`Still points to Hostinger (website or parking page) — change it to ${IP}`)
    expect(https(FIX.aWrong)).toMatchObject({ icon: 'bad', title: 'HTTPS works, but another server answered (not the store)' })
    expect(regionRow(FIX.aWrong).title).toBe('DNS seen in 0 of 6 regions')
  })

  it('CNAME at @ on a proxy root (Porkbun): told to use an A record, Porkbun\'s "pick ALIAS" tip is not given', () => {
    const t = popup(FIX.cnameApex)
    expect(t).toContain(`Delete the CNAME record for @ and add an A record for @ pointing to ${IP}.`)
    expect(t).toContain('For @ use an A record with the address below')
    expect(t).not.toContain('For @ pick type ALIAS')
  })

  it('orange cloud: "turn off the orange cloud", grey-cloud tip, never WRONG_TARGET wording', () => {
    const t = popup(FIX.orange)
    expect(t).toContain('Turn off the orange cloud in Cloudflare.')
    expect(t).toContain('Set it to DNS only (grey cloud).')
    expect(t).not.toContain('DNS records point somewhere else')
  })

  it('NS switching (not live): the move is explained, old records marked, records to add shown', () => {
    const t = popup(FIX.nsSwitching)
    expect(t).toContain('Just moved here from Hostinger')
    expect(t).toContain(OLD_DNS)
    expect(toAdd(FIX.nsSwitching)?.values).toEqual(['A @', 'A www', 'TXT _fullfilio'])
  })

  it('NS switching on a live domain: "opens on this domain, but fix", records to add at Cloudflare shown', () => {
    const t = popup(FIX.nsSwitchingLive)
    expect(t).toContain('Your store opens here, but the DNS records need attention')
    expect(t).toContain('Your store opens on this domain, but fix the following:')
    expect(toAdd(FIX.nsSwitchingLive)?.values).toEqual(['A @', 'A www'])
  })

  it('live and clean: all green, nothing to add, no tips', () => {
    const t = popup(FIX.liveClean)
    expect(hero(FIX.liveClean)).toBe('Connected · 6 of 6 regions')
    expect(sections(FIX.liveClean).slice(0, 3).map((s) => s.icon)).toEqual(['ok', 'ok', 'ok'])
    expect(t).not.toContain('Add at your domain provider')
    expect(t).not.toContain('DNS for this domain is managed at')
  })

  it('live with a stray AAAA: "opens on this domain, but fix", the AAAA row red, nothing to add', () => {
    const t = popup(FIX.liveAaaa)
    expect(t).toContain('Your store opens on this domain, but fix the following:')
    expect(t).toContain(`Delete the AAAA record for @ (${STRAY_V6}) at Hostinger.`)
    expect(t).toContain('Remove: the store has no IPv6 address')
    expect(toAdd(FIX.liveAaaa)).toBeNull()
  })

  it('root live, www missing: the www tip (records to add incl. the www A record)', () => {
    expect(popup(FIX.rootWwwMissing)).toContain('www.shop.com is not set up yet.')
    expect(toAdd(FIX.rootWwwMissing)?.values).toContain('A www')
  })

  it('Cloudflare-for-SaaS subdomain waiting for its TXT: CNAME tip for GoDaddy, TXT name copyable', () => {
    const t = popup(FIX.saasTxt)
    expect(t).toContain('Add a CNAME record named shop with the value below')
    expect(t).not.toContain('delete the A record for @')
    expect(toAdd(FIX.saasTxt)).toEqual({ values: ['CNAME shop', 'TXT _fullfilio.shop'], names: ['shop', '_fullfilio.shop'] })
  })

  it('Cloudflare-for-SaaS subdomain proven, certificate being issued: hosting progress shown', () => {
    expect(https(FIX.saasHosting)).toMatchObject({ icon: 'wait', sub: 'Hosting: Domain confirmed · certificate being issued' })
    expect(hero(FIX.saasHosting)).toBe('DNS is right · finishing HTTPS · 6 of 6 regions')
  })

  it('Cloudflare-for-SaaS subdomain live: no hosting line, nothing to add', () => {
    expect(https(FIX.saasLive)).toMatchObject({ icon: 'ok', sub: '' })
    expect(toAdd(FIX.saasLive)).toBeNull()
  })

  it('MANUAL hosting: Pending, not "we keep checking every 10 minutes", the owner step in the footer', () => {
    expect(footer(FIX.manualProven)).toBe('Add the DNS record below; the platform owner then connects the domain to the hosting.')
    expect(popup(FIX.manualProven)).not.toContain(KEEP_CHECKING)
  })

  it('www row next to the primary root: "Redirects to shop.com", primary switch only once live', () => {
    expect(popup(FIX.wwwLive)).toContain('Redirects to shop.com')
    expect(popup(FIX.wwwLive)).toContain('Change')
    expect(popup(FIX.wwwWaiting)).toContain('Can be primary once connected')
    expect(popup(FIX.wwwWaiting)).toContain('For www use an A record with the address below')
    expect(toAdd(FIX.wwwWaiting)?.values).toEqual(['A www'])
  })

  it('a root that cannot connect at Hostinger (no proxy): Cloudflare steps and the "use www" button', () => {
    const t = popup(FIX.needsCloudflare, { onUseWww: async () => undefined })
    expect(t).toContain('Connect shop.com to Cloudflare')
    expect(t).toContain('Or use www.shop.com instead')
    expect(t).not.toContain('The root (@) cannot connect at Hostinger')
  })

  it('a proven domain is never told to wait for its TXT', () => {
    for (const d of Object.values(FIX).filter((x) => x.verified_at)) {
      expect(popup(d), d.id).not.toContain('HTTPS starts once the TXT record')
      expect(popup(d), d.id).not.toContain('Verification record missing')
      expect(popup(d), d.id).not.toContain(WAITING_TXT)
    }
  })

  it('long names: the list and the popup header truncate the domain instead of widening', () => {
    const list = renderToStaticMarkup(createElement(DomainList, { domains: [FIX.longIdn, FIX.longApex], onOpen: noop }))
    expect(list).toContain(`<span class="block truncate text-sm font-medium">${LONG_IDN}</span>`)
    expect(html(FIX.longApex)).toMatch(/class="min-w-0 flex-1 truncate text-sm font-semibold[^"]*">meinlieblings/)
  })
})

// --- the remove dialog -------------------------------------------------------------------------

describe('panel r4: the remove dialog', () => {
  const root = (p: Partial<StoreDomain> = {}) => ({ ...FIX.liveClean, ...p })
  const www = (p: Partial<StoreDomain> = {}) => ({ ...FIX.wwwLive, ...p })

  it('custom domains off: never promises it can be added back', () => {
    const t = removeNote([root()], 'shop.com', true)
    expect(t).toContain('cannot be added again afterwards')
    expect(t).not.toMatch(/Added back|add it again/)
  })

  it('a proven domain: "added back within 7 days … without proving it again" (store_domain_guard: v_back)', () => {
    expect(removeNote([root()], 'shop.com', false)).toContain('Added back within 7 days, it reconnects without proving it again')
  })

  it('an unproven waiting domain: keep its TXT, and no need to remove it', () => {
    const t = removeNote([FIX.txtMissing], 'shop.com', false)
    expect(t).toContain('keep its TXT record')
    expect(t).toContain('Waiting? No need to remove it')
  })

  it('a live proven twin stays: the domain keeps opening through it (store_domain_known / storefront_resolve take the proven twin)', () => {
    expect(removeNote([root(), www()], 'shop.com', false)).toContain('www.shop.com stays connected, so shop.com keeps opening the store through it.')
  })

  // Expected: the title "Remove <domain>?" wraps inside the dialog. A domain is one unbreakable word,
  // so from ~31 characters on a phone (www.bangladeshihandicraftstore.com) the title and text are cut
  // off, and from ~48 on desktop the Cancel / Remove buttons are pushed out of the dialog entirely
  // (seen in Chromium at 390×844 and 1280×800). The dialog title needs a break rule (or <wbr> after dots).
  it('a long domain in "Remove <domain>?" can wrap, so the buttons stay in the dialog', () => {
    const h = renderToStaticMarkup(createElement(ConfirmDialog, {
      open: true, onOpenChange: noop, title: `Remove www.${LONG_APEX}?`, description: removeNote([FIX.longApex], LONG_APEX, false),
      confirmLabel: 'Remove', destructive: true, onConfirm: noop,
    }))
    expect(h).toMatch(/>\s*Remove<\/button>/)
    const title = h.match(/<h2[^>]*class="([^"]*)"[^>]*>(.*?)<\/h2>/)
    expect(title?.[2]).toContain('meinlieblings')
    expect(`${title?.[1]} ${title?.[2]}`).toMatch(/break-all|overflow-wrap|break-words|<wbr|​/)
  })

  // Expected: when the twin is not proven (verified_at null, still waiting for its TXT), removing this
  // domain takes it offline (storefront_resolve → "missing", store_domain_known → no certificate),
  // so the dialog must say "The store stops opening on this domain", not that it keeps opening.
  it('a twin that is not proven yet is not promised to keep the domain open', () => {
    const waitingTwin = www({ status: 'VERIFYING', verified_at: null, detail: 'Verification record missing', records: [...wwwRecords, txtRecord('_fullfilio.www')] })
    const t = removeNote([root(), waitingTwin], 'shop.com', false)
    expect(t).not.toContain('keeps opening the store through it')
    expect(t).toContain('The store stops opening on this domain')
  })
})

// --- defects -------------------------------------------------------------------------------------

describe('panel r4: defects', () => {
  // Expected: while the ownership TXT is still awaited, the band says what is left for the
  // merchant ("DNS is right · add the TXT record"), not "finishing HTTPS" — the HTTPS row right
  // below says HTTPS starts only once the TXT is found.
  it('waiting for the TXT (first check, DNS already right): the band does not say "finishing HTTPS"', () => {
    expect(https(FIX.waitingTxt).title).toBe('HTTPS starts once the TXT record below is found')
    expect(hero(FIX.waitingTxt)).not.toContain('finishing HTTPS')
  })
  it('waiting for the TXT on MANUAL hosting: the band does not say "finishing HTTPS"', () => {
    expect(hero(FIX.manualTxt)).not.toContain('finishing HTTPS')
  })

  // Expected: a live domain kept by UNCONFIRMED (the probe timed out) has a certificate; the HTTPS
  // row says the last check could not reach it (warn), not that a certificate "is being issued",
  // and the "Certificate on the way" note is not shown.
  it('live, probe timed out: HTTPS row does not claim a certificate is being issued', () => {
    const row = https(FIX.liveProbeTimeout)
    expect(row.title).not.toMatch(/being issued|did not answer over HTTPS yet/)
    expect(notes(FIX.liveProbeTimeout)).not.toContain('Certificate on the way')
  })
  // Expected: same for a live domain whose DNS check and probe both failed: no red "did not answer
  // over HTTPS yet" (that reads as never-live) on a domain the chip calls Connected.
  it('live, DNS checker down and probe timed out: HTTPS row is not a red "did not answer over HTTPS yet"', () => {
    const row = https(FIX.liveDnsOutageTimeout)
    expect(row.icon).not.toBe('bad')
    expect(row.title).not.toContain('did not answer over HTTPS yet')
  })

  // Expected: when the DNS check itself failed (CHECK_FAILED), the regions row says the regions
  // could not be checked (wait icon), not "Domain is live in 0 of 6 regions" in red; and the band
  // under a Connected domain does not say "0 of 6 regions".
  it('live, DNS checker down: not "live in 0 of 6 regions" in red', () => {
    const row = regionRow(FIX.liveDnsOutage)
    expect(row.title).not.toContain('0 of 6')
    expect(row.icon).not.toBe('bad')
    expect(hero(FIX.liveDnsOutage)).not.toContain('0 of 6 regions')
  })

  // Expected: a domain that does not open the store (Pending / Not connected) is not called "live" in
  // the regions row: DNS is seen everywhere, but the footer uses "Live —" for "the store opens here".
  it('not connected yet (TXT missing, ERROR, waiting for the TXT): the regions row does not say "Domain is live"', () => {
    for (const d of [FIX.txtMissing, FIX.error, FIX.waitingTxt, FIX.manualProven]) expect(regionRow(d).title, d.id).not.toMatch(/live/i)
  })

  // Expected: the store answering HTTP 502 through the proxy is not a pass: the HTTPS row shows a
  // warning icon, not the blue check next to "The store did not answer just now (HTTP 502)".
  it('live, store answered 502: the HTTPS row is not marked OK', () => {
    const row = https(FIX.liveStoreDown)
    expect(row.title).toBe('The store did not answer just now (HTTP 502)')
    expect(row.icon).not.toBe('ok')
  })

  // Expected: nothing is issuing a certificate while the platform owner has not attached a MANUAL
  // domain, or while an ERROR domain is not attached to the hosting: the HTTPS row must not promise
  // "being issued (usually a few minutes)" and "Certificate on the way" must not show.
  it('MANUAL (waiting for the platform owner): no "certificate is being issued (usually a few minutes)"', () => {
    expect(https(FIX.manualProven).title).not.toContain('being issued')
    expect(notes(FIX.manualProven)).not.toContain('Certificate on the way')
  })
  it('ERROR (not attached to the hosting): no "certificate is being issued (usually a few minutes)"', () => {
    expect(https(FIX.error).title).not.toContain('being issued')
    expect(notes(FIX.error)).not.toContain('Certificate on the way')
  })

  // Expected: UNCONFIRMED says "a timeout, or a DNS checker not answering"; when the panel already
  // shows the real reason (the nameserver switch), that explanation is wrong and is not shown next to it.
  it('live through a nameserver switch: not also told "one check did not get a clear answer (a timeout …)"', () => {
    expect(popup(FIX.nsSwitchingLive)).not.toContain('a timeout, or a DNS checker not answering')
  })

  // Expected: after 3 days of waiting a domain is re-checked hourly (dueForRecheck: 55 min), so the
  // footer must not promise "every 10 minutes".
  it('waiting for 5 days: the footer does not promise a check every 10 minutes', () => {
    expect(popup(FIX.waitingDays)).not.toContain('every 10 minutes')
  })

  // Expected: a found record's name (not copyable, so not wrapped in the break-all button) can wrap
  // on a phone card: a 59-char label like _fullfilio.<LONG_SUB> must not run out of the card.
  it('long record name in "Records found" (phone card) can break', () => {
    const h = html(FIX.longIdn)
    const card = h.slice(h.indexOf('Records found'), h.indexOf('</ul>', h.indexOf('Records found')))
    const nameLine = card.match(/<p class="([^"]*)"><span class="font-medium text-foreground">TXT<\/span>/)?.[1] ?? ''
    expect(nameLine).toMatch(/break-all|overflow-wrap|break-words/)
  })

  // Expected: the footer's status line wraps a long domain inside the popup on a phone (it has no
  // break rule, so "www.<62-char label>.de" is cut off by the popup's overflow-x-hidden).
  it('long domain in the footer status line can break', () => {
    expect(html(FIX.longApex)).toMatch(/<span class="w-full min-w-0 sm:w-auto sm:flex-1[^"]*(break-all|overflow-wrap|break-words)/)
  })
})

// --- the fixtures are what the backend writes -----------------------------------------------------

type Zone = Record<string, Partial<Record<'A' | 'AAAA' | 'CNAME' | 'NS' | 'CAA' | 'TXT', string[]>>>
const TYPE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 } as const
/** Fake DoH + HTTPS probe (no network). https: what https://<domain>/ does. */
function fakeFetch(zone: Zone, https: 'store' | 'other' | 'cert' | 'timeout' | '502', dohDown = false): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'rdap.org' || url.hostname === 'data.iana.org') return new Response('{}', { status: 404 })
    if (url.pathname === '/') {
      if (https === 'cert') throw new Error('invalid peer certificate: UnknownIssuer')
      if (https === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      if (https === '502') return new Response('Bad gateway', { status: 502, headers: { server: 'Caddy' } })
      return new Response('ok', { headers: https === 'store' ? { 'x-fullfilio': 'store' } : { server: 'other' } })
    }
    if (dohDown) throw new Error('timeout')
    const name = url.searchParams.get('name') ?? ''
    const type = url.searchParams.get('type') as keyof typeof TYPE
    const rec = zone[name] ?? {}
    const answer: Array<{ name: string; type: number; data: string }> = []
    if (rec.CNAME && ['A', 'AAAA', 'CNAME'].includes(type)) {
      answer.push(...rec.CNAME.map((d) => ({ name, type: TYPE.CNAME, data: `${d}.` })))
      if (type !== 'CNAME') answer.push(...(zone[rec.CNAME[0]]?.[type] ?? []).map((d) => ({ name: rec.CNAME![0], type: TYPE[type], data: d })))
    } else if (rec[type]) answer.push(...rec[type]!.map((d) => ({ name, type: TYPE[type], data: d })))
    return new Response(JSON.stringify({ Status: 0, Answer: answer }), { headers: { 'content-type': 'application/dns-json' } })
  }) as typeof fetch
}

describe('panel r4: fixtures match the backend', () => {
  const proxy = proxyTarget(IP, TARGET)
  const zone: Zone = { 'shop.com': { A: [IP], NS: NS.Hostinger.nameservers }, 'www.shop.com': { A: [IP] } }
  const codes = (issues: Issue[]) => issues.map((i) => i.code)

  it('records to add are handler.baseRecords + ownershipRecord', () => {
    expect(FIX.waitingTxt.records).toEqual([...baseRecords('shop.com', proxy), ownershipRecord('shop.com', CODE)])
    expect(FIX.wwwLive.records).toEqual(baseRecords('www.shop.com', proxy))
    expect(FIX.saasTxt.records).toEqual([...baseRecords('shop.brand.com', cloudflareTarget(TARGET)), ownershipRecord('shop.brand.com', CODE)])
    expect(FIX.manualProven.records).toEqual(baseRecords('bazaar.com.bd', VERCEL_TARGET))
    expect(FIX.longIdn.records).toEqual([...baseRecords(LONG_IDN, cloudflareTarget(TARGET)), ownershipRecord(LONG_IDN, CODE)])
    expect(FIX.needsCloudflare.records[0]).toEqual(baseRecords('shop.com', cloudflareTarget(TARGET))[0])
  })

  it('probe timeout on a pointed, proven root: tls.ok false + TLS_PENDING (what liveProbeTimeout carries)', async () => {
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch(zone, 'timeout') })
    expect(d.pointed).toBe(true)
    expect(d.tls).toEqual(TLS.noAnswer)
    expect(codes(d.issues)).toEqual(['TLS_PENDING'])
  })

  it('the proxy answering 502: tls ok, served_by_store null, STORE_DOWN (what liveStoreDown carries)', async () => {
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch(zone, '502') })
    expect(d.tls).toEqual(TLS.down502)
    expect(d.issues).toEqual([STORE_DOWN('shop.com')])
  })

  it('DoH down, store answering: CHECK_FAILED, not pointed, 0 regions (what liveDnsOutage carries)', async () => {
    const d = await diagnose('shop.com', { target: proxy, fetcher: fakeFetch(zone, 'store', true) })
    expect(d.pointed).toBe(false)
    expect(d.issues).toEqual([CHECK_FAILED])
    expect(d.regions.filter((r) => r.ok)).toHaveLength(0)
    expect(d.tls).toEqual(TLS.ok)
  })

  it('first check after adding (TXT not asked yet), cert refused: only TLS_PENDING, which the handler drops while unproven (waitingTxt: no issues)', async () => {
    const d = await diagnose('shop.com', { target: proxy, expect: [], fetcher: fakeFetch(zone, 'cert') })
    expect(d.pointed).toBe(true)
    expect(d.tls).toEqual(TLS.certWait)
    expect(codes(d.issues)).toEqual(['TLS_PENDING'])
  })

  it('TXT missing on the second check: TXT_MISSING with the panel\'s name (txtMissing)', async () => {
    const d = await diagnose('shop.com', { target: proxy, expect: [{ type: 'TXT', name: '_fullfilio.shop.com', value: `fullfilio-verify=${CODE}` }], fetcher: fakeFetch(zone, 'cert') })
    expect(d.issues).toEqual([TXT_MISSING('_fullfilio')])
    expect(d.records).toContainEqual(txtRow('_fullfilio'))
  })

  it('a domain waiting 5 days, checked 15 minutes ago, is not due (hourly) — so "every 10 minutes" is not true', () => {
    const d = FIX.waitingDays as StoreDomain & { status_changed_at: string }
    expect(dueForRecheck({ ...d, checked_at: '2026-10-20T07:45:00Z' }, Date.parse('2026-10-20T08:00:00Z'))).toBe(false)
    expect(dueForRecheck({ ...d, checked_at: '2026-10-20T07:45:00Z' }, Date.parse('2026-10-20T08:41:00Z'))).toBe(true)
  })
})

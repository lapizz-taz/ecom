import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CreditCard, Globe, Megaphone, MessageSquare, Phone, ShieldCheck, ShoppingBag, Truck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { integrationsOverview, type IntegrationsOverview } from '@/services/support'

type State = 'connected' | 'error' | 'off'
interface Item { key: string; name: string; group: string; icon: ReactNode; state: State; detail: string; to: string; manage?: string }

const STATE: Record<State, { label: string; variant: 'success' | 'danger' | 'neutral'; dot: string }> = {
  connected: { label: 'Connected', variant: 'success', dot: 'bg-emerald-500' },
  error: { label: 'Needs attention', variant: 'danger', dot: 'bg-red-500' },
  off: { label: 'Not connected', variant: 'neutral', dot: 'bg-zinc-300' },
}
const COURIERS = [['pathao', 'Pathao'], ['steadfast', 'Steadfast'], ['redx', 'RedX'], ['carrybee', 'Carrybee']] as const
const SMS_NAMES: Record<string, string> = { smsnetbd: 'Alpha SMS', bulksmsbd: 'BulkSMSBD', sslwireless: 'SSL Wireless', http: 'Custom SMS gateway' }

function items(o: IntegrationsOverview): Item[] {
  const out: Item[] = []
  const cred = (k: string) => o.credentials[k]
  for (const platform of ['shopify', 'woocommerce'] as const) {
    const chans = o.channels.filter((c) => c.platform === platform)
    const err = chans.find((c) => c.status === 'ERROR')
    out.push({
      key: platform, group: 'Sales channels', icon: <ShoppingBag />, name: platform === 'shopify' ? 'Shopify' : 'WooCommerce',
      state: err ? 'error' : chans.some((c) => c.status === 'CONNECTED') ? 'connected' : 'off',
      detail: err ? (err.last_error ?? 'Connection error') : chans.length
        ? `${chans.map((c) => c.domain).join(', ')} · ${formatNumber(chans.reduce((n, c) => n + c.orders, 0))} orders imported${chans[0].last_sync_at ? ` · synced ${timeAgo(chans[0].last_sync_at)}` : ''}`
        : 'Import orders, sync stock and fulfil from here',
      to: '/admin/channels',
    })
  }
  out.push({
    key: 'website', group: 'Sales channels', icon: <Globe />, name: 'Website API & domains',
    state: o.site_keys > 0 || o.domains.length ? 'connected' : 'off',
    detail: o.domains.length || o.site_keys
      ? [o.domains.length ? `${o.domains.map((d) => d.domain).join(', ')}` : null, o.site_keys ? `${o.site_keys} API key(s)` : null].filter(Boolean).join(' · ')
      : 'Your own domain or a custom-coded website',
    to: '/admin/store/website',
  })
  for (const [provider, name] of COURIERS) {
    const c = o.couriers.find((x) => x.provider === provider)
    out.push({
      key: `courier-${provider}`, group: 'Couriers', icon: <Truck />, name, state: c ? 'connected' : 'off',
      detail: c ? `${c.hint}${c.last_event_at ? ` · last update ${timeAgo(c.last_event_at)}` : ''}` : 'Book parcels and receive status updates',
      to: '/admin/couriers',
    })
  }
  for (const [code, name] of [['bkash', 'bKash Merchant'], ['paystation', 'PayStation']] as const) {
    const c = cred(`payments.${code}`)
    out.push({ key: `pay-${code}`, group: 'Payments', icon: <CreditCard />, name, state: c ? 'connected' : 'off',
      detail: c ? `${c.hint} · since ${timeAgo(c.at)}` : 'Collect advance payments online', to: '/admin/settings?tab=payments' })
  }
  for (const [platform, name] of [['meta', 'Meta (Facebook & Instagram) Ads'], ['tiktok', 'TikTok Ads'], ['google', 'Google Ads']] as const) {
    const conns = o.ads.filter((a) => a.platform.toLowerCase() === platform)
    const err = conns.find((a) => a.status === 'ERROR' || a.last_error)
    out.push({
      key: `ads-${platform}`, group: 'Marketing', icon: <Megaphone />, name,
      state: err ? 'error' : conns.length ? 'connected' : 'off',
      detail: err ? (err.last_error ?? 'Connection error') : conns.length ? conns.map((a) => a.name ?? 'Account').join(', ') : 'Ad spend, campaigns and profit per order',
      to: platform === 'meta' ? '/admin/marketing' : `/admin/marketing/${platform}`,
    })
  }
  const smsKey = Object.keys(o.credentials).find((k) => k.startsWith('sms.'))
  out.push({
    key: 'sms', group: 'Messaging', icon: <MessageSquare />, name: smsKey ? SMS_NAMES[smsKey.slice(4)] ?? 'SMS gateway' : 'SMS gateway',
    state: smsKey ? 'connected' : 'off', detail: smsKey ? `${o.credentials[smsKey].hint}${o.sms?.enabled === false ? ' · automations paused' : ''}` : 'Order and shipping SMS to customers',
    to: '/admin/sms',
  })
  out.push({
    key: 'pbx', group: 'Messaging', icon: <Phone />, name: `${o.pbx?.provider || 'VoiceDrive'} PBX`,
    state: o.pbx?.enabled ? 'connected' : 'off',
    detail: o.pbx?.enabled ? `${o.pbx.mode === 'api' ? 'Click-to-call' : 'Phone links'} · ${formatNumber(o.pbx.calls_7d)} calls in 7 days` : 'Call log and click-to-call',
    to: '/admin/settings/pbx',
  })
  const fraud = cred('fraud.courier_history')
  out.push({ key: 'fraud', group: 'Fraud check', icon: <ShieldCheck />, name: 'Courier history check', state: fraud ? 'connected' : 'off',
    detail: fraud ? fraud.hint : 'Parcel history of a phone number across couriers', to: '/admin/settings?tab=fraud' })
  return out
}

export default function AppIntegrationsPage() {
  const q = useQuery({ queryKey: ['integrations-overview'], queryFn: integrationsOverview })
  const all = q.data ? items(q.data) : []
  const groups = [...new Set(all.map((i) => i.group))]
  const n = (s: State) => all.filter((i) => i.state === s).length
  return (
    <div className="space-y-4">
      <PageHeader title="App integrations" description="Every service connected to your store, in one place. Keys and passwords stay on the server — this page only shows whether each one works." />
      {q.isLoading ? <CardsSkeleton count={8} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Connected" value={n('connected')} tone="positive" />
            <StatCard label="Needs attention" value={n('error')} tone={n('error') ? 'negative' : 'default'} />
            <StatCard label="Available" value={n('off')} />
          </div>
          {groups.map((g) => (
            <section key={g} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">{g}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {all.filter((i) => i.group === g).map((i) => (
                  <Card key={i.key} className={cn('flex-row items-start gap-3 p-4', i.state === 'error' && 'border-red-200')}>
                    <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5">
                      {i.icon}<span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card', STATE[i.state].dot)} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{i.name}</p><Badge variant={STATE[i.state].variant}>{STATE[i.state].label}</Badge></div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{i.detail}</p>
                    </div>
                    <Button size="sm" variant={i.state === 'off' ? 'outline' : 'ghost'} asChild className="shrink-0">
                      <Link to={i.to}>{i.state === 'off' ? 'Connect' : 'Manage'} <ArrowRight /></Link>
                    </Button>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}

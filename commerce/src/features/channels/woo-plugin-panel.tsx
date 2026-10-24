import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Download, KeyRound, PlugZap, RefreshCw, Stethoscope, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type PluginConfig, pluginCode, pluginOverview, pluginPair, type PluginReport, pluginStatus, savePluginConfig, WOO_PLUGIN_DOWNLOAD,
} from '@/services/channels'

type Tone = 'ok' | 'warn' | 'fail'

function Mark({ tone }: { tone: Tone }) {
  return (
    <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full',
      tone === 'ok' ? 'bg-foreground text-background' : tone === 'warn' ? 'bg-muted-foreground/30 text-foreground' : 'bg-red-600 text-white')}>
      {tone === 'ok' ? <Check className="size-3" /> : tone === 'warn' ? <span className="text-[10px] font-bold">!</span> : <X className="size-3" />}
    </span>
  )
}

const FEATURES: Array<{ key: keyof PluginConfig; title: string; detail: string }> = [
  { key: 'order_events', title: 'Instant orders', detail: 'New orders and status changes are sent the moment they happen, retried until they arrive. WooCommerce webhooks stay on as a second path; an order is imported once.' },
  { key: 'capture_leads', title: 'Unfinished checkouts', detail: 'Phone, name, address and cart of checkouts that were not completed appear under Web Orders → Abandoned Carts.' },
  { key: 'attribution', title: 'Ad attribution', detail: 'UTM tags, click ids (fbclid, gclid, ttclid) and Meta cookies from the first and latest visit are saved on each order.' },
  { key: 'shield', title: 'Order shield', detail: 'At checkout: block-listed numbers are refused, and customers whose delivery record needs an advance cannot choose cash on delivery (Settings → Fraud rules decide).' },
  { key: 'custom_statuses', title: 'Delivered and Returned statuses', detail: 'Adds both statuses to WooCommerce and sets them on the store\'s order when the courier reports delivery or return.' },
]

/** Checks worth showing staff, from the plugin's last report. */
function checks(r: PluginReport | null | undefined, online: boolean): Array<{ tone: Tone; label: string; detail: string }> {
  if (!r?.plugin_version) return [{ tone: 'warn', label: 'Plugin', detail: 'No report from the plugin yet. Install it, then click "Connect plugin".' }]
  const out: Array<{ tone: Tone; label: string; detail: string }> = []
  out.push(online ? { tone: 'ok', label: 'Plugin online', detail: `Version ${r.plugin_version} · WooCommerce ${r.woocommerce ?? '?'} · WordPress ${r.wordpress ?? '?'} · PHP ${r.php ?? '?'}` }
    : { tone: 'fail', label: 'Plugin offline', detail: 'No heartbeat for over 40 minutes. Is the plugin still active, and is WP-Cron running?' })
  out.push(r.permalinks === 'pretty' ? { tone: 'ok', label: 'Permalinks', detail: 'Pretty permalinks: the REST API is reachable' }
    : { tone: 'fail', label: 'Permalinks', detail: 'WordPress → Settings → Permalinks: choose any option except "Plain"' })
  out.push(r.https ? { tone: 'ok', label: 'HTTPS', detail: 'The store is on a secure address' } : { tone: 'fail', label: 'HTTPS', detail: 'The store is not on HTTPS; API keys must not travel in clear text' })
  out.push(r.action_scheduler || r.wp_cron ? { tone: 'ok', label: 'Background tasks', detail: r.action_scheduler ? 'Action Scheduler (from WooCommerce)' : 'WP-Cron' }
    : { tone: 'warn', label: 'Background tasks', detail: 'WP-Cron is off and Action Scheduler is missing: events wait for a real cron job' })
  out.push(r.checkout === 'classic' || r.checkout === 'blocks' ? { tone: 'ok', label: 'Checkout', detail: `${r.checkout === 'blocks' ? 'Block' : 'Classic'} checkout — both are supported` }
    : { tone: 'warn', label: 'Checkout', detail: 'No standard checkout page found; unfinished-checkout capture may miss the form' })
  if (r.advance) {
    const methods = r.advance.online_gateways ?? []
    out.push(!r.advance.follows_fullfilio ? { tone: 'warn', label: 'Advance payment', detail: 'Off: turn on the order shield so riskier customers pay the advance set in Settings → Fraud' }
      : methods.length ? { tone: 'ok', label: 'Advance payment', detail: `Follows Settings → Fraud · taken online by ${methods.join(', ')}` }
        : { tone: 'fail', label: 'Advance payment', detail: 'No online payment method is switched on in WooCommerce (bKash, SSLCommerz, Nagad…), so a customer who needs an advance cannot order. Add one in WooCommerce → Settings → Payments.' })
  } else if (online) {
    out.push({ tone: 'warn', label: 'Advance payment', detail: 'Update the plugin to 1.5.2 so it collects the advance set in Settings → Fraud' })
  }
  const failed = r.outbox?.failed ?? 0
  out.push(failed ? { tone: 'fail', label: 'Delivery queue', detail: `${failed} event(s) could not be delivered. In WordPress: WooCommerce → Fullfilio → "Send again".` }
    : { tone: 'ok', label: 'Delivery queue', detail: `${r.outbox?.pending ?? 0} waiting · ${r.outbox?.sent ?? 0} delivered this week` })
  const paused = (r.webhooks ?? []).filter((w) => w.status && w.status !== 'active')
  out.push(paused.length ? { tone: 'warn', label: 'WooCommerce webhooks', detail: `${paused.length} paused by WooCommerce after failed deliveries — switched back on automatically at the next heartbeat` }
    : { tone: 'ok', label: 'WooCommerce webhooks', detail: `${(r.webhooks ?? []).length} active` })
  if (r.state?.last_error) out.push({ tone: 'warn', label: 'Last problem', detail: `${r.state.last_error}${r.state.last_error_at ? ` (${timeAgo(r.state.last_error_at)})` : ''}` })
  return out
}

function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-3">
        <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** WooCommerce store → Plugin: status, switches, diagnostics and the event log of Fullfilio Connect. */
export function WooPluginPanel({ channelId }: { channelId: string }) {
  const qc = useQueryClient()
  const key = ['woo-plugin', channelId]
  const q = useQuery({ queryKey: key, queryFn: () => pluginOverview(channelId), refetchInterval: 30_000 })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['sales-channels'] })
  }
  const [code, setCode] = useState<string | null>(null)
  const pair = useMutation({
    mutationFn: () => pluginPair(channelId),
    onSuccess: (r) => { toast[r.check.status === 'ok' ? 'success' : 'warning'](r.check.detail); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => pluginStatus(channelId),
    onSuccess: (r) => {
      if (r.reachable) toast.success(`The plugin answered in ${r.ms} ms${r.connected ? '' : ' — but it is not connected; click "Connect plugin"'}`)
      else toast.error(r.installed === false ? 'The plugin is not installed or not active on the store' : `No answer: ${r.error}`)
      refresh()
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const save = useMutation({
    mutationFn: (patch: Partial<PluginConfig>) => savePluginConfig(channelId, patch),
    onSuccess: (r) => { toast.success(r.delivered ? 'Saved and sent to the store' : 'Saved — the store picks it up at its next contact (within 15 minutes)'); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const reveal = useMutation({ mutationFn: () => pluginCode(channelId), onSuccess: (r) => setCode(r.code), onError: (e) => toast.error(toUserMessage(e)) })

  if (q.isLoading) return <LoadingState />
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const o = q.data!
  const installed = !!o.plugin?.plugin_version
  const list = checks(o.plugin, o.online)

  return (
    <div className="space-y-4">
      <Section title="Fullfilio Connect plugin"
        description={installed
          ? `${o.online ? 'Online' : 'Offline'} · version ${o.plugin?.plugin_version} · last contact ${o.plugin?.last_seen_at ? timeAgo(o.plugin.last_seen_at) : 'never'}`
          : 'Optional. Orders arrive without it; it adds unfinished checkouts, the order shield, attribution and Delivered/Returned statuses.'}
        actions={<>
          <Button size="sm" variant="outline" asChild><a href={WOO_PLUGIN_DOWNLOAD} download><Download /> Download plugin</a></Button>
          <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? <Spinner /> : <Stethoscope />} API test</Button>
          <Button size="sm" onClick={() => pair.mutate()} disabled={pair.isPending}>{pair.isPending ? <Spinner /> : <PlugZap />} Connect plugin</Button>
        </>}>
        {!installed && (
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Download the plugin (button above).</li>
            <li>In WordPress: Plugins → Add New → <b className="text-foreground">Upload Plugin</b> → choose the file → Install → <b className="text-foreground">Activate</b>.</li>
            <li>Back here, click <b className="text-foreground">Connect plugin</b>. Nothing to copy.</li>
          </ol>
        )}
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Orders · 7 days', o.counts.orders_7d],
            ['Unfinished checkouts · 7 days', o.counts.leads_7d],
            ['Recovered · 7 days', o.counts.leads_recovered_7d],
            ['Problems · 24 h', o.counts.failed_24h],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-lg border px-3 py-2">
              <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt>
              <dd className="font-semibold tabular-nums">{formatNumber(value as number)}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Features" description="Switched here, applied on the store straight away (or at its next contact).">
        <div className="divide-y">
          {FEATURES.map((f) => (
            <label key={f.key} className="flex cursor-pointer items-start gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{f.title}</span>
                <span className="block text-xs text-muted-foreground">{f.detail}</span>
              </span>
              <Switch checked={!!o.config[f.key]} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ [f.key]: v })} aria-label={f.title} />
            </label>
          ))}
          {o.config.shield && (
            <label className="flex cursor-pointer items-start gap-3 py-2.5 pl-4">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">If Fullfilio cannot answer in {o.config.shield_timeout} s, let the order through</span>
                <span className="block text-xs text-muted-foreground">Recommended: a slow network never costs you an order. The check still runs when the order arrives.</span>
              </span>
              <Switch checked={o.config.shield_fail_open} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ shield_fail_open: v })} aria-label="Let the order through when the check cannot answer" />
            </label>
          )}
        </div>
      </Section>

      <Section title="Troubleshooting" description="From the plugin's last report and the store connection test.">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {[...list, ...(o.channel.last_test?.checks ?? []).filter((c) => c.key !== 'plugin').map((c) => ({ tone: c.status as Tone, label: c.label, detail: c.detail }))].map((c, i) => (
            <li key={`${c.label}-${i}`} className="flex gap-2 rounded-lg border px-3 py-2 text-sm">
              <Mark tone={c.tone} />
              <span className="min-w-0"><span className="font-medium">{c.label}</span><span className="block text-xs text-muted-foreground">{c.detail}</span></span>
            </li>
          ))}
        </ul>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Fullfilio cannot reach the store? Connect with a code instead</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">Some firewalls block requests to WordPress. Copy this code and paste it in WordPress → WooCommerce → Fullfilio. Keep it private: it lets the store send events here.</p>
            {code ? (
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs">{code}</code>
                <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(code); toast.success('Code copied') }}><Copy /> Copy</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => reveal.mutate()} disabled={reveal.isPending}>{reveal.isPending ? <Spinner /> : <KeyRound />} Show connection code</Button>
            )}
          </div>
        </details>
      </Section>

      <Section title="Plugin activity" description="What the store's plugin sent, newest first. Repeats of an event already handled are marked and skipped."
        actions={<Button size="sm" variant="ghost" onClick={() => q.refetch()}><RefreshCw /> Refresh</Button>}>
        {!o.events.length ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-1.5 pr-3 font-medium">Time</th><th className="pr-3 font-medium">Event</th><th className="pr-3 font-medium">Result</th><th className="font-medium">Details</th></tr></thead>
              <tbody>
                {o.events.slice(0, 50).map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 whitespace-nowrap" title={formatDateTime(e.created_at)}>{timeAgo(e.created_at)}</td>
                    <td className="pr-3">{e.type.replace(/_/g, ' ')}</td>
                    <td className="pr-3"><span className={cn('rounded px-1.5 py-0.5 text-xs', e.status === 'OK' ? 'bg-muted' : e.status === 'DUPLICATE' ? 'text-muted-foreground' : 'bg-red-600/10 text-red-700')}>{e.status.toLowerCase()}</span></td>
                    <td className="max-w-md truncate text-xs text-muted-foreground" title={JSON.stringify(e.detail)}>{Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

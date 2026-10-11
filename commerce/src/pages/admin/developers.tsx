import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, BookOpen, Check, Copy, KeyRound, ListTree, Plus, ShieldAlert, Terminal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ComingSoon } from '@/components/common/coming-soon'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useMerchantFeatures } from '@/features/billing/use-features'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { API_SCOPES, createApiKey, externalApiBase, listApiKeys, listApiLogs, revokeApiKey, type ApiKey, type ApiScope } from '@/services/developer-api'

const copy = (v: string, what = 'Copied') => void navigator.clipboard.writeText(v).then(() => toast.success(what))

/** External API: keys for the business's own systems, a request log, and the reference. */
export default function DevelopersPage() {
  const [state, update] = useUrlState({ tab: 'keys' })
  const { isOff, loading } = useMerchantFeatures()
  if (!loading && isOff('external_api')) {
    return (
      <div className="space-y-4">
        <PageHeader title="Developers" description="Connect your own systems to orders, products, stock and customers." />
        <ComingSoon icon={<Terminal />} title="External API is not in your plan"
          description="Upgrade your plan to connect an ERP, accounting software or your own scripts to Fullfilio over a REST API." />
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Developers" icon={<Terminal />}
        description="Connect your ERP, accounting software, warehouse app or scripts to your orders, products, stock and customers over a REST API." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab }, { resetPage: false })}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="keys"><KeyRound /> API keys</TabsTrigger>
          <TabsTrigger value="logs"><ListTree /> Request log</TabsTrigger>
          <TabsTrigger value="docs"><BookOpen /> Reference</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="animate-in fade-in-0"><KeysTab /></TabsContent>
        <TabsContent value="logs" className="animate-in fade-in-0"><LogsTab /></TabsContent>
        <TabsContent value="docs" className="animate-in fade-in-0"><DocsTab /></TabsContent>
      </Tabs>
    </div>
  )
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <span key={s} className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset',
          s.endsWith(':write') ? 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-muted text-muted-foreground ring-border')}>{s}</span>
      ))}
    </span>
  )
}

function KeysTab() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: listApiKeys })
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const edit = can('settings.manage')
  if (keys.isLoading) return <LoadingState />
  if (keys.error) return <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
  const list = keys.data ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 shadow-xs">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Base URL</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{externalApiBase()}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => copy(externalApiBase(), 'Base URL copied')}><Copy /> Copy</Button>
        {edit && <Button size="sm" onClick={() => setCreating(true)}><Plus /> Create API key</Button>}
      </div>
      {!list.length ? (
        <EmptyState icon={<KeyRound />} title="No API keys yet" description="Create a key for each system you connect, with only the permissions it needs." />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-xs">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Name</th><th className="px-4 py-2.5 font-medium">Permissions</th>
              <th className="px-4 py-2.5 font-medium">Last used</th><th className="px-4 py-2.5 text-right font-medium">Requests</th><th className="w-24" />
            </tr></thead>
            <tbody>
              {list.map((k) => {
                const expired = k.expires_at && new Date(k.expires_at) < new Date()
                const off = Boolean(k.revoked_at) || Boolean(expired)
                return (
                  <tr key={k.id} className={cn('border-b last:border-0 align-top', off && 'opacity-60')}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{k.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{k.prefix}…</p>
                      <p className="text-[11px] text-muted-foreground">
                        {k.revoked_at ? `Turned off ${timeAgo(k.revoked_at)}` : expired ? 'Expired' : k.expires_at ? `Expires ${formatDateTime(k.expires_at)}` : 'Never expires'}
                      </p>
                    </td>
                    <td className="px-4 py-3"><ScopeChips scopes={k.scopes} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{k.last_used_at ? timeAgo(k.last_used_at) : 'Never'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(k.request_count)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {edit && !off && <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}><Ban /> Turn off</Button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
        Keys are shown once and stored only as a fingerprint. Use them from your server, never in a website or app that customers download. Requests from a browser are refused.
      </p>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={(key) => { setShown(key); void qc.invalidateQueries({ queryKey: ['api-keys'] }) }} />
      <Dialog open={!!shown} onOpenChange={(v) => !v && setShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
            <DialogDescription>For your security it will not be shown again. If you lose it, turn it off and create a new one.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2.5">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{shown}</code>
            <Button size="icon-sm" variant="ghost" aria-label="Copy key" onClick={() => copy(shown!, 'API key copied')}><Copy /></Button>
          </div>
          <DialogFooter><Button onClick={() => setShown(null)}><Check /> I have saved it</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!revoking} onOpenChange={(v) => !v && setRevoking(null)} title={`Turn off "${revoking?.name}"?`}
        description="Systems using this key stop working right away. This cannot be undone; create a new key to reconnect." confirmLabel="Turn off" destructive
        onConfirm={async () => { await revokeApiKey(revoking!.id); toast.success('API key turned off'); void qc.invalidateQueries({ queryKey: ['api-keys'] }) }} />
    </div>
  )
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiScope[]>(['orders:read'])
  const [expiry, setExpiry] = useState('never')
  const create = useMutation({
    mutationFn: () => createApiKey(name.trim(), scopes, expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString()),
    onSuccess: (r) => { onOpenChange(false); setName(''); setScopes(['orders:read']); setExpiry('never'); onCreated(r.key) },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const groups = [...new Set(API_SCOPES.map((s) => s.group))]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Give each connected system its own key with only the permissions it needs.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2 && scopes.length) create.mutate() }}>
          <Field label="Name" htmlFor="key-name"><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tally ERP sync" maxLength={60} /></Field>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Permissions</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {groups.map((g) => (
                <div key={g} className="rounded-lg border p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{g}</p>
                  {API_SCOPES.filter((s) => s.group === g).map((s) => (
                    <label key={s.code} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                      <Checkbox checked={scopes.includes(s.code)} onCheckedChange={(v) => setScopes((cur) => v ? [...cur, s.code] : cur.filter((x) => x !== s.code))} />
                      {s.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <Field label="Expires">
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="30">In 30 days</SelectItem>
                <SelectItem value="90">In 90 days</SelectItem>
                <SelectItem value="365">In 1 year</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || name.trim().length < 2 || !scopes.length}>{create.isPending && <Spinner />} Create key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LogsTab() {
  const logs = useQuery({ queryKey: ['api-logs'], queryFn: () => listApiLogs(200), refetchInterval: 30_000 })
  if (logs.isLoading) return <LoadingState />
  if (logs.error) return <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
  const list = logs.data ?? []
  if (!list.length) return <EmptyState icon={<ListTree />} title="No requests yet" description="Every call made with your API keys shows up here." />
  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-xs">
      <table className="w-full min-w-[680px] text-sm">
        <thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
          <th className="px-4 py-2.5 font-medium">Time</th><th className="px-4 py-2.5 font-medium">Key</th><th className="px-4 py-2.5 font-medium">Request</th>
          <th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 text-right font-medium">Duration</th>
        </tr></thead>
        <tbody>
          {list.map((l) => (
            <tr key={l.id} className="border-b last:border-0">
              <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{formatDateTime(l.created_at)}</td>
              <td className="px-4 py-2.5">{l.key_name ?? '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs"><Method m={l.method} /> {l.path}</td>
              <td className="px-4 py-2.5">
                <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium', l.status < 300 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : l.status < 500 ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300')}>{l.status}</span>
                {l.error_code && <span className="ml-2 font-mono text-[11px] text-muted-foreground">{l.error_code}</span>}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{l.duration_ms != null ? `${l.duration_ms} ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Method({ m }: { m: string }) {
  return <span className={cn('inline-block w-11 rounded px-1 text-center font-mono text-[10px] font-semibold', m === 'GET' ? 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300' : 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300')}>{m}</span>
}

function Code({ children }: { children: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-100">{children}</pre>
      <Button size="icon-sm" variant="ghost" aria-label="Copy" className="absolute top-1.5 right-1.5 text-zinc-400 hover:bg-white/10 hover:text-white" onClick={() => copy(children)}><Copy /></Button>
    </div>
  )
}

const ENDPOINTS: Array<{ method: 'GET' | 'POST'; path: string; scope: string; about: string; params?: string; body?: string }> = [
  { method: 'GET', path: '/me', scope: '—', about: 'The key and its permissions. Use it to test a connection.' },
  { method: 'GET', path: '/orders', scope: 'orders:read', about: 'Orders, newest change first.', params: 'status, updated_since (ISO time), limit (≤100), offset' },
  { method: 'GET', path: '/orders/{order_number}', scope: 'orders:read', about: 'One order with items and shipment. Also accepts the order id.' },
  { method: 'POST', path: '/orders/{order_number}/status', scope: 'orders:write', about: 'Move an order along its normal path (e.g. CONFIRMED, PACKING, SHIPPED). Fraud and advance-payment decisions stay in the admin.', body: '{ "status": "CONFIRMED", "note": "Confirmed by ERP" }' },
  { method: 'GET', path: '/products', scope: 'products:read', about: 'Products with variants, prices and stock.', params: 'search, limit, offset' },
  { method: 'GET', path: '/inventory', scope: 'inventory:read', about: 'Stock per SKU: on hand, reserved for orders, available.', params: 'sku, limit (≤500), offset' },
  { method: 'POST', path: '/inventory/{sku}', scope: 'inventory:write', about: 'Set, add or remove stock. A reason is required; stock reserved for orders is protected.', body: '{ "mode": "set", "quantity": 120, "note": "Warehouse count" }' },
  { method: 'GET', path: '/customers', scope: 'customers:read', about: 'Customers with order history totals.', params: 'phone, limit, offset' },
]

function DocsTab() {
  const base = externalApiBase()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-6">
        <DocSection title="Authentication">
          <p>Send the key in the <code className="font-mono">Authorization</code> header. Call the API from your server only; requests with a browser <code className="font-mono">Origin</code> are refused.</p>
          <Code>{`curl ${base}/orders?status=CONFIRMED&limit=20 \\\n  -H "Authorization: Bearer ffl_live_…"`}</Code>
        </DocSection>
        <DocSection title="Endpoints">
          <div className="divide-y rounded-xl border bg-card">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Method m={e.method} />
                  <code className="font-mono text-sm font-medium">{e.path}</code>
                  <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{e.scope}</span>
                </div>
                <p className="text-sm text-muted-foreground">{e.about}</p>
                {e.params && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Query:</span> {e.params}</p>}
                {e.body && <Code>{e.body}</Code>}
              </div>
            ))}
          </div>
        </DocSection>
        <DocSection title="Example: sync stock from your warehouse (Node.js)">
          <Code>{`const API = '${base}'
const headers = { Authorization: \`Bearer \${process.env.FULLFILIO_API_KEY}\`, 'Content-Type': 'application/json' }

for (const row of warehouseCounts) {
  const res = await fetch(\`\${API}/inventory/\${encodeURIComponent(row.sku)}\`, {
    method: 'POST', headers,
    body: JSON.stringify({ mode: 'set', quantity: row.count, note: 'Nightly warehouse count' }),
  })
  if (!res.ok) console.error(row.sku, (await res.json()).error)
}`}</Code>
        </DocSection>
        <DocSection title="Lists and errors">
          <p>Lists return <code className="font-mono">{'{ data, total, limit, offset }'}</code>. Page with <code className="font-mono">offset</code>. To pick up changes, keep the newest <code className="font-mono">updated_at</code> you saw and pass it as <code className="font-mono">updated_since</code>.</p>
          <p>Errors return <code className="font-mono">{'{ error: { code, message } }'}</code>:</p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {[['401', 'API_KEY_MISSING, API_KEY_INVALID', 'No key, wrong key, expired or turned off'], ['403', 'PERMISSION_DENIED, KEY_IN_BROWSER, FEATURE_OFF', 'Missing permission, called from a browser, or not in the plan'],
                  ['404', 'NOT_FOUND', 'No such order, SKU or endpoint'], ['422', 'VALIDATION, INVALID_TRANSITION, INSUFFICIENT_STOCK', 'The request breaks a business rule'], ['429', 'RATE_LIMITED', 'Too many requests; wait a minute']].map(([s, c, d]) => (
                  <tr key={s}><td className="px-3 py-2 font-mono text-xs">{s}</td><td className="px-3 py-2 font-mono text-[11px]">{c}</td><td className="px-3 py-2 text-muted-foreground">{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </DocSection>
      </div>
      <div className="h-fit space-y-3 rounded-xl border bg-card p-4 text-sm shadow-xs lg:sticky lg:top-4">
        <p className="font-medium">Good to know</p>
        <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground">
          <li>Base URL: <span className="font-mono text-xs break-all">{base}</span></li>
          <li>Limits: 240 reads and 60 writes per minute per key.</li>
          <li>Changes made through the API follow the same rules as the admin and appear in each order's timeline.</li>
          <li>Selling from your own coded website? Use the <a href="/admin/store/website?tab=api" className="text-brand underline-offset-2 hover:underline">Website API</a> instead.</li>
        </ul>
      </div>
    </div>
  )
}

function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 text-sm">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

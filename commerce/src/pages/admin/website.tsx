import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Code2, Copy, Globe, KeyRound, Plus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  addDomain, checkDomain, createSiteKey, listDomains, listSiteKeys, makePrimaryDomain, removeDomain, revokeSiteKey, type SiteKey, siteApiBase,
} from '@/services/website'
import { DomainDetail, DomainList } from '@/features/website/domain-status'

const copy = (v: string, what = 'Copied') => void navigator.clipboard.writeText(v).then(() => toast.success(what))

/** The client's own domain for the hosted store, and API keys for a custom-coded shop. */
export default function WebsitePage() {
  const [state, update] = useUrlState({ tab: 'domain' })
  return (
    <div className="space-y-4">
      <PageHeader title="Website & domains" description="Use your own domain for the store, or connect a website you coded yourself to sell through this platform." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab }, { resetPage: false })}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="domain"><Globe /> Custom domain</TabsTrigger>
          <TabsTrigger value="api"><Code2 /> <span className="sm:hidden">Website API</span><span className="hidden sm:inline">Custom-coded website</span></TabsTrigger>
        </TabsList>
        <TabsContent value="domain" className="animate-in fade-in-0"><DomainsTab /></TabsContent>
        <TabsContent value="api" className="animate-in fade-in-0"><ApiTab /></TabsContent>
      </Tabs>
    </div>
  )
}

function DomainsTab() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [state, update] = useUrlState({ tab: 'domain', domain: '' })
  const [value, setValue] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['store-domains'], queryFn: listDomains })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['store-domains'] })
  const add = useMutation({
    mutationFn: () => addDomain(value),
    onSuccess: (r) => {
      setValue(''); refresh(); update({ domain: r.domain.domain }, { resetPage: false })
      toast.success(r.domain.status === 'ACTIVE' ? `${r.domain.domain} is live` : `${r.domain.domain} added — add the DNS records shown`)
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const check = useMutation({
    mutationFn: (d: string) => checkDomain(d),
    onSuccess: (r) => { refresh(); r.domain.status === 'ACTIVE' ? toast.success(`${r.domain.domain} is live`) : toast.info(r.domain.detail ?? 'Not ready yet') },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const edit = can('settings.manage')
  if (list.isLoading) return <LoadingState />
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />
  const domains = list.data?.domains ?? []
  const primary = domains.find((d) => d.is_primary)?.domain ?? null
  const open = domains.find((d) => d.domain === state.domain)

  if (open) {
    return (
      <div className="max-w-3xl">
        <DomainDetail d={open} primary={primary} canEdit={edit} checking={check.isPending}
          onBack={() => update({ domain: '' }, { resetPage: false })}
          onCheck={() => check.mutate(open.domain)} onRemove={() => setRemoving(open.domain)}
          onMakePrimary={async () => {
            try { await makePrimaryDomain(open.domain); toast.success(`${open.domain} is now the primary domain`); refresh() }
            catch (e) { toast.error(toUserMessage(e)); throw e }
          }} />
        <ConfirmDialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)} title={`Remove ${removing}?`}
          description="The store stops opening on this domain. Your default address keeps working." confirmLabel="Remove" destructive
          onConfirm={async () => { await removeDomain(removing!); toast.success('Domain removed'); update({ domain: '' }, { resetPage: false }); refresh() }} />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        {edit && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connect a domain</CardTitle>
              <CardDescription>Your customers open the store on your own address, with HTTPS set up for you.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (value.trim()) add.mutate() }}>
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="shop.com or www.shop.com" className="sm:flex-1" autoCapitalize="none" spellCheck={false} />
                <Button type="submit" disabled={!value.trim() || add.isPending}>{add.isPending ? <Spinner /> : <Plus />} Add domain</Button>
              </form>
              {!list.data?.automatic && (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                  Domains are checked automatically (DNS, every region and HTTPS). The Fullfilio team attaches new domains to the hosting, so a domain can show Pending for a short while after its DNS is right.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        {!domains.length
          ? <EmptyState title="No custom domain yet" description="The store is on its default address until you connect one." />
          : <DomainList domains={domains} onOpen={(domain) => update({ domain }, { resetPage: false })} />}
      </div>
      <Card className="h-fit">
        <CardHeader><CardTitle className="text-sm">How it works</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
            <li>Add your domain here.</li>
            <li>At your registrar (Namecheap, GoDaddy, Cloudflare…), add the DNS record shown. For <b className="text-foreground">shop.com</b> it is an <b className="text-foreground">A</b> record; for <b className="text-foreground">www.shop.com</b> a <b className="text-foreground">CNAME</b>.</li>
            <li>Open the domain and click <b className="text-foreground">Check again</b>. You see each record, every region and HTTPS. DNS changes can take minutes to a few hours.</li>
            <li>On Cloudflare, set the record to <b className="text-foreground">DNS only</b> (grey cloud).</li>
            <li>The first domain is the <b className="text-foreground">primary</b>; the others redirect to it.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}

function ApiTab() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const keys = useQuery({ queryKey: ['site-keys'], queryFn: listSiteKeys })
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<{ key: string; kind: SiteKey['kind'] } | null>(null)
  const [revoking, setRevoking] = useState<SiteKey | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['site-keys'] })
  const base = siteApiBase()
  const example = `// Browser (publishable key) or your server (secret key)
const API = '${base}'
const headers = { Authorization: 'Bearer pk_live_…', 'Content-Type': 'application/json' }

// 1. Products
const { items: products } = await fetch(\`\${API}/products?limit=24\`, { headers }).then(r => r.json())

// 2. Price the cart (delivery charge, discounts, cash on delivery or advance)
await fetch(\`\${API}/quote\`, { method: 'POST', headers, body: JSON.stringify({
  items: [{ variant_id: '…', quantity: 1 }], district: 'Dhaka', phone: '01711000000', payment_method: 'COD' }) })

// 3. Place the order (send the same idempotency_key when retrying)
await fetch(\`\${API}/orders\`, { method: 'POST', headers, body: JSON.stringify({
  customer: { full_name: 'Rahim Uddin', phone: '01711000000' },
  shipping: { address: 'House 1, Road 2', district: 'Dhaka' },
  items: [{ variant_id: '…', quantity: 1 }], payment_method: 'COD',
  idempotency_key: crypto.randomUUID() }) })

// 4. Order status for the customer
await fetch(\`\${API}/orders/ISO-10001?phone=01711000000\`, { headers })`
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader className="flex flex-row items-start gap-2 space-y-0">
          <div className="flex-1">
            <CardTitle className="text-base">API keys</CardTitle>
            <CardDescription>Orders from your website go through the same checkout as the hosted store — prices, stock, delivery charges, fraud check and block list all apply.</CardDescription>
          </div>
          {can('settings.manage') && <Button size="sm" onClick={() => setCreating(true)}><KeyRound /> New key</Button>}
        </CardHeader>
        <CardContent>
          {keys.isLoading ? <LoadingState /> : keys.error ? <ErrorState error={keys.error} onRetry={() => keys.refetch()} /> : !keys.data?.length
            ? <EmptyState title="No keys yet" description="Create a key for each website." />
            : (
              <ul className="divide-y rounded-lg border">
                {keys.data.map((k) => (
                  <li key={k.id} className={cn('flex flex-wrap items-center gap-3 p-3 text-sm', k.revoked_at && 'opacity-60')}>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{k.name} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal">{k.kind === 'SECRET' ? 'Server' : 'Browser'}</span></p>
                      <p className="font-mono text-xs text-muted-foreground">{k.prefix}…</p>
                      <p className="text-xs text-muted-foreground">
                        {k.allowed_origins.length ? `${k.allowed_origins.join(', ')} · ` : ''}{formatNumber(k.orders)} orders · {k.last_used_at ? `used ${timeAgo(k.last_used_at)}` : 'never used'}
                        {k.revoked_at && ` · turned off ${formatDateTime(k.revoked_at)}`}
                      </p>
                    </div>
                    {!k.revoked_at && can('settings.manage') && <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>Turn off</Button>}
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Quick start</CardTitle>
          <CardDescription>Base address: <code className="rounded bg-muted px-1 py-0.5 text-[11px] break-all">{base}</code> <Button size="icon-sm" variant="ghost" aria-label="Copy base address" onClick={() => copy(base)}><Copy /></Button></CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed"><code>{example}</code></pre>
            <Button size="icon-sm" variant="secondary" className="absolute top-2 right-2" aria-label="Copy example" onClick={() => copy(example, 'Example copied')}><Copy /></Button>
          </div>
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <li><b className="text-foreground">Browser key (pk_live_)</b> works only from the website addresses you list — safe to put in front-end code.</li>
            <li><b className="text-foreground">Server key (sk_live_)</b> is for your backend; it is refused if a browser sends it. Never put it in front-end code.</li>
            <li>Orders arrive in Web Orders tagged <code className="rounded bg-muted px-1">site:&lt;name&gt;</code>, even when the hosted store is switched off.</li>
            <li>Prices you send are ignored; they always come from your products here.</li>
          </ul>
        </CardContent>
      </Card>
      <NewKeyDialog open={creating} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setShown(r); refresh() }} />
      <Dialog open={!!shown} onOpenChange={(v) => !v && setShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
            <DialogDescription>This is the only time the full key is shown. Only a fingerprint of it is stored.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={shown?.key ?? ''} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" size="icon" aria-label="Copy key" onClick={() => copy(shown!.key, 'Key copied')}><Copy /></Button>
          </div>
          {shown?.kind === 'SECRET' && <p className="text-xs text-muted-foreground">Keep it on your server (an environment variable), never in browser code or a public repository.</p>}
          <DialogFooter><Button onClick={() => setShown(null)}><Check /> I've saved it</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!revoking} onOpenChange={(v) => !v && setRevoking(null)} title={`Turn off "${revoking?.name}"?`}
        description="Requests with this key stop working at once. Orders already placed stay as they are." confirmLabel="Turn off" destructive
        onConfirm={async () => { await revokeSiteKey(revoking!.id); toast.success('Key turned off'); refresh() }} />
    </div>
  )
}

function NewKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: { key: string; kind: SiteKey['kind'] }) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SiteKey['kind']>('PUBLISHABLE')
  const [origins, setOrigins] = useState('')
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () => createSiteKey(name.trim(), kind, origins.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean)),
    onSuccess: (r) => { onCreated({ key: r.key, kind }); setName(''); setOrigins('') },
  })
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { create.reset(); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New website key</DialogTitle>
          <DialogDescription>One key per website, so you can turn one off without touching the others.</DialogDescription>
        </DialogHeader>
        <form id="new-key" className="grid gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
          <Field label="Website name" htmlFor="k-name" required><Input id="k-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main shop (Next.js)" maxLength={60} /></Field>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Where the key is used">
            {(['PUBLISHABLE', 'SECRET'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                className={cn('rounded-lg border p-3 text-left text-sm transition-colors', kind === k ? 'border-foreground bg-muted/50' : 'hover:border-foreground/40')}>
                <span className="block font-medium">{k === 'PUBLISHABLE' ? 'Browser' : 'Server'}</span>
                <span className="block text-xs text-muted-foreground">{k === 'PUBLISHABLE' ? 'Front-end code, limited to your website addresses' : 'Your backend only; never in browser code'}</span>
              </button>
            ))}
          </div>
          {kind === 'PUBLISHABLE' && (
            <Field label="Website addresses" htmlFor="k-origins" required hint="One per line, like https://shop.com — add http://localhost:3000 while developing.">
              <Textarea id="k-origins" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder={'https://shop.com\nhttps://www.shop.com'} />
            </Field>
          )}
          {create.error && <p className="rounded-lg bg-red-50 p-2.5 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200" role="alert">{toUserMessage(create.error)}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="new-key" disabled={name.trim().length < 2 || create.isPending}>{create.isPending && <Spinner />} Create key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

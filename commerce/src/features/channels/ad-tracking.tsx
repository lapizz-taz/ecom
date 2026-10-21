// Ad tracking for the merchant's own store, opened from Sales channels → Your store.
// Browser pixels + server events (Meta Conversions API, TikTok Events API, GA4
// Measurement Protocol) with one event id each, so every platform counts once.
// Tokens go to the server and are only ever shown masked.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleDashed, Loader2, Radar, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type AdPlatform, type AdQueueRow, type AdTokenKey, type AdTrackingConfig, type AdTrackingStatus, adTrackingGet, adTrackingSave, adTrackingTest, type PurchaseOn,
} from '@/services/channels'

const QUERY = ['store-ad-tracking']

/** What the Your store card shows: which platforms are on. */
export function useAdTracking(enabled = true) {
  return useQuery({ queryKey: QUERY, queryFn: adTrackingGet, enabled, staleTime: 60_000, meta: { silent: true } })
}

export function adPlatformsOn(s: AdTrackingStatus | undefined): string[] {
  if (!s?.config.enabled) return []
  const c = s.config
  return [c.meta.pixel_id && 'Meta', c.tiktok.pixel_id && 'TikTok', (c.google.ga4_id || c.google.ads_id) && 'Google'].filter(Boolean) as string[]
}

const PURCHASE: Array<{ value: PurchaseOn; title: string; detail: string }> = [
  { value: 'placed', title: 'Order placed', detail: 'Normal. Counts at checkout, in the browser and from the server.' },
  { value: 'confirmed', title: 'Order confirmed', detail: 'Counts when you confirm the order. Server only.' },
  { value: 'delivered', title: 'Delivered', detail: 'Counts when the courier delivers. Server only; real sales only.' },
]

export function AdTrackingDialog({ manage, onClose }: { manage: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const status = useAdTracking()
  const [c, setC] = useState<AdTrackingConfig | null>(null)
  const [tokens, setTokens] = useState<Partial<Record<AdTokenKey, string>>>({})
  const [clear, setClear] = useState<AdTokenKey[]>([])
  useEffect(() => { if (status.data && !c) setC(status.data.config) }, [status.data, c])

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => adTrackingSave(c!, tokens, clear),
    onSuccess: (s) => {
      queryClient.setQueryData(QUERY, s)
      setC(s.config)
      setTokens({})
      setClear([])
      toast.success(s.config.enabled ? 'Ad tracking saved — events start with the next visit' : 'Ad tracking saved (off)')
    },
  })

  if (status.error) {
    return (
      <FormDialog open onOpenChange={(o) => !o && onClose()} title="Ad tracking" submitLabel="Close" onSubmit={onClose}>
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      </FormDialog>
    )
  }
  const s = status.data
  const set = (patch: Partial<AdTrackingConfig>) => setC((x) => (x ? { ...x, ...patch } : x))
  const token = (k: AdTokenKey) => ({
    value: tokens[k] ?? '',
    saved: clear.includes(k) ? null : s?.tokens[k === 'meta_token' ? 'meta' : k === 'tiktok_token' ? 'tiktok' : 'ga4'] ?? null,
    onChange: (v: string) => { setTokens((t) => ({ ...t, [k]: v })); setClear((x) => x.filter((y) => y !== k)) },
    onClear: () => { setClear((x) => [...new Set([...x, k])]); setTokens((t) => ({ ...t, [k]: '' })) },
  })

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide title="Ad tracking"
      description="Meta, TikTok and Google pixels in the browser, plus a copy of every event from our own server on your store's address. Each event has one id in both places, so it counts once."
      submitLabel={manage ? 'Save' : 'Close'} busy={save.isPending} disabled={manage && !c}
      onSubmit={() => (manage ? save.mutate() : onClose())}>
      {!c ? <div className="grid place-items-center py-10"><Spinner /></div> : (
        <fieldset disabled={!manage || save.isPending} className="grid min-w-0 gap-4">
          <label className="flex items-center gap-3 rounded-lg border p-3">
            <Radar className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Track ads on my store</span>
              <span className="block text-xs text-muted-foreground">Off: no pixel loads and nothing is sent.</span>
            </span>
            <Switch checked={c.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Track ads on my store" />
          </label>

          <ul className="grid gap-1.5 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
            <li><b className="font-medium text-foreground">Events:</b> page view, product view, add to cart, checkout, search, contact, sign-up and purchase.</li>
            <li><b className="font-medium text-foreground">Ad blockers:</b> the server copy goes through your store's own address, so blockers do not stop it.</li>
            <li><b className="font-medium text-foreground">Cookies kept:</b> your store's server keeps Meta's click and browser cookies for 90 days (browsers cut them to 7).</li>
            <li><b className="font-medium text-foreground">Returning buyers:</b> their phone, email and name are kept in their own browser, hashed only, to match later visits.</li>
          </ul>

          <Section title="When a Purchase counts">
            <div className="grid gap-2 sm:grid-cols-3">
              {PURCHASE.map((p) => (
                <button key={p.value} type="button" onClick={() => set({ purchase_on: p.value })} aria-pressed={c.purchase_on === p.value}
                  className={cn('rounded-lg border p-2.5 text-left transition-colors', c.purchase_on === p.value ? 'border-foreground bg-muted/50' : 'hover:bg-muted/30')}>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {c.purchase_on === p.value ? <Check className="size-3.5" /> : <CircleDashed className="size-3.5 text-muted-foreground" />}{p.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{p.detail}</span>
                </button>
              ))}
            </div>
          </Section>

          <Platform platform="meta" title="Meta (Facebook, Instagram)" mark={<MetaMark />} manage={manage} saved={!!s?.tokens.meta}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pixel ID" hint="Events Manager → your dataset → Settings">
                <Input value={c.meta.pixel_id} inputMode="numeric" placeholder="1234567890123456" autoComplete="off"
                  onChange={(e) => set({ meta: { ...c.meta, pixel_id: e.target.value.replace(/\D/g, '') } })} />
              </Field>
              <Field label="Test event code" hint="Optional. Sends to Test events only.">
                <Input value={c.meta.test_code} placeholder="TEST12345" autoComplete="off" onChange={(e) => set({ meta: { ...c.meta, test_code: e.target.value.trim() } })} />
              </Field>
            </div>
            <TokenField label="Conversions API access token" hint="Events Manager → Settings → Conversions API → Generate access token" {...token('meta_token')} />
          </Platform>

          <Platform platform="tiktok" title="TikTok" mark={<TikTokMark />} manage={manage} saved={!!s?.tokens.tiktok}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pixel ID" hint="Events Manager → Web → your pixel">
                <Input value={c.tiktok.pixel_id} placeholder="C1A2B3C4D5E6F7G8H9I0" autoComplete="off"
                  onChange={(e) => set({ tiktok: { ...c.tiktok, pixel_id: e.target.value.trim().toUpperCase() } })} />
              </Field>
              <Field label="Test event code" hint="Needed for Test; real events skip it.">
                <Input value={c.tiktok.test_code} placeholder="TEST12345" autoComplete="off" onChange={(e) => set({ tiktok: { ...c.tiktok, test_code: e.target.value.trim() } })} />
              </Field>
            </div>
            <TokenField label="Events API access token" hint="Your pixel → Settings → Events API → Generate access token" {...token('tiktok_token')} />
          </Platform>

          <Platform platform="google" title="Google (Analytics 4, Ads)" mark={<GoogleMark />} manage={manage} saved={!!s?.tokens.ga4}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="GA4 Measurement ID">
                <Input value={c.google.ga4_id} placeholder="G-XXXXXXXXXX" autoComplete="off" onChange={(e) => set({ google: { ...c.google, ga4_id: e.target.value.trim().toUpperCase() } })} />
              </Field>
              <Field label="Google Ads conversion ID">
                <Input value={c.google.ads_id} placeholder="AW-123456789" autoComplete="off" onChange={(e) => set({ google: { ...c.google, ads_id: e.target.value.trim().toUpperCase() } })} />
              </Field>
              <Field label="Conversion label">
                <Input value={c.google.ads_label} placeholder="AbC-D_efG-h12" autoComplete="off" onChange={(e) => set({ google: { ...c.google, ads_label: e.target.value.trim() } })} />
              </Field>
            </div>
            <TokenField label="Measurement Protocol API secret" hint="GA4 Admin → Data streams → your stream → Measurement Protocol API secrets. Sends the purchase from the server." {...token('ga4_secret')} />
          </Platform>

          <Section title="Rules">
            <div className="grid gap-1.5 sm:grid-cols-2">
              <Toggle label="Browser pixels" hint="Page views, products, add to cart, checkout" checked={c.browser_events} onChange={(v) => set({ browser_events: v })} />
              <Toggle label="Server events" hint="Conversions API / Events API copies" checked={c.server_events} onChange={(v) => set({ server_events: v })} />
              <Toggle label="Advanced matching" hint="Hashed phone, email, name, city" checked={c.advanced_matching} onChange={(v) => set({ advanced_matching: v })} />
              <Toggle label="Skip duplicate orders" hint="A repeat of an earlier order is not counted" checked={c.skip_duplicates} onChange={(v) => set({ skip_duplicates: v })} />
              <Toggle label="Skip low delivery-success customers" hint="Fraud check says Low: not counted" checked={c.exclude_low_rr} onChange={(v) => set({ exclude_low_rr: v })} />
            </div>
          </Section>

          {save.error && <p className="rounded-lg border border-red-600/40 p-3 text-sm" role="alert">{(save.error as Error).message}</p>}
          {s && <RecentPurchases rows={s.recent} />}
        </fieldset>
      )}
    </FormDialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

function TokenField({ label, hint, value, saved, onChange, onClear }: {
  label: string; hint: string; value: string; saved: string | null; onChange: (v: string) => void; onClear: () => void
}) {
  return (
    <Field label={label} hint={saved && !value ? `Saved (${saved}). Leave empty to keep it.` : hint}>
      <div className="flex gap-2">
        <Input type="password" value={value} placeholder={saved ? saved : 'Paste the token'} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
        {saved && <Button type="button" variant="outline" size="sm" className="h-9" onClick={onClear}>Remove</Button>}
      </div>
    </Field>
  )
}

/** One platform's block with its connection test (uses the saved settings). */
function Platform({ platform, title, mark, manage, saved, children }: { platform: AdPlatform; title: string; mark: ReactNode; manage: boolean; saved: boolean; children: ReactNode }) {
  const test = useMutation({ meta: { silent: true }, mutationFn: () => adTrackingTest(platform) })
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border">{mark}</span>
        <p className="min-w-0 flex-1 text-sm font-medium">{title}</p>
        {manage && (
          <Button type="button" size="sm" variant="outline" disabled={test.isPending || !saved} title={saved ? 'Checks the saved settings' : 'Save a token first'} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="animate-spin" /> : null} Test
          </Button>
        )}
      </div>
      {children}
      {(test.data || test.error) && (
        <p className={cn('flex gap-2 rounded-md px-2.5 py-2 text-xs', test.data?.ok ? 'bg-muted/60' : 'ring-1 ring-red-600/40 ring-inset')} role="status">
          {test.data?.ok ? <Check className="mt-px size-3.5 shrink-0" /> : <X className="mt-px size-3.5 shrink-0" />}
          <span>{test.data?.message ?? (test.error as Error)?.message}</span>
        </p>
      )}
    </div>
  )
}

const ROW_STATUS: Record<AdQueueRow['status'], string> = { PENDING: 'Waiting', DONE: 'Sent', PARTIAL: 'Partly sent', FAILED: 'Failed', SKIPPED: 'Skipped' }

function RecentPurchases({ rows }: { rows: AdQueueRow[] }) {
  return (
    <Section title="Latest server Purchases">
      {!rows.length ? <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">None yet. They appear here when orders reach the point you chose above.</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr><th className="px-2.5 py-1.5 font-medium">Order</th><th className="px-2.5 py-1.5 font-medium">Status</th><th className="px-2.5 py-1.5 font-medium">Meta</th><th className="px-2.5 py-1.5 font-medium">TikTok</th><th className="px-2.5 py-1.5 font-medium">Google</th><th className="px-2.5 py-1.5 font-medium">When</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{r.orders?.order_number ?? '—'}</td>
                  <td className="px-2.5 py-1.5" title={r.last_error ?? undefined}>{ROW_STATUS[r.status]}{r.status === 'PENDING' && r.attempts > 0 ? ` (retry ${r.attempts})` : ''}</td>
                  {(['meta', 'tiktok', 'google'] as const).map((p) => <td key={p} className="px-2.5 py-1.5"><Outcome r={r.results?.[p]} /></td>)}
                  <td className="px-2.5 py-1.5 whitespace-nowrap text-muted-foreground">{timeAgo(r.done_at ?? r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function Outcome({ r }: { r?: { ok: boolean; error?: string; skipped?: string } }) {
  if (!r) return <span className="text-muted-foreground">—</span>
  if (r.ok) return <span className="inline-flex items-center gap-1"><Check className="size-3" /> Sent</span>
  if (r.skipped) return <span className="text-muted-foreground" title={r.skipped}>Off</span>
  return <span className="inline-flex items-center gap-1" title={r.error}><X className="size-3" /> Failed</span>
}

// Small monochrome platform marks (simple shapes, not the companies' logos).
function MetaMark() {
  return <svg viewBox="0 0 24 24" className="size-4" aria-hidden><path fill="currentColor" d="M6.9 6C4.2 6 2 9.6 2 13.2 2 15.8 3.3 18 5.6 18c1.9 0 3.2-1.5 5-4.5l1.4-2.4 1.4 2.4c1.8 3 3.1 4.5 5 4.5 2.3 0 3.6-2.2 3.6-4.8C22 9.6 19.8 6 17.1 6c-1.8 0-3.2 1.3-5.1 4.3C10.1 7.3 8.7 6 6.9 6Zm0 2.2c1 0 1.9.9 3.8 4L9.2 14.7C7.8 17 7 17.8 5.9 17.8c-1.3 0-1.9-1.4-1.9-3 0-3.4 1.4-6.6 2.9-6.6Zm10.2 0c1.5 0 2.9 3.2 2.9 6.6 0 1.6-.6 3-1.9 3-1.1 0-1.9-.8-3.3-3.1l-1.5-2.5c1.9-3.1 2.8-4 3.8-4Z" /></svg>
}
function TikTokMark() {
  return <svg viewBox="0 0 24 24" className="size-4" aria-hidden><path fill="currentColor" d="M16.6 3c.4 2.2 1.8 3.7 4 3.9v3.1c-1.5 0-2.8-.4-4-1.2v6.4c0 3.5-2.6 5.8-5.7 5.8A5.6 5.6 0 0 1 5.3 15c0-3.4 2.9-6 6.6-5.5v3.2c-1.7-.4-3.5.6-3.5 2.4 0 1.4 1.1 2.5 2.5 2.5 1.6 0 2.6-1.1 2.6-3V3h3.1Z" /></svg>
}
function GoogleMark() {
  return <svg viewBox="0 0 24 24" className="size-4" aria-hidden><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3ZM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Zm-5.6-8a6 6 0 0 1 0-3.9V7.4H3.1a10 10 0 0 0 0 9.1L6.4 14ZM12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.4L6.4 10C7.2 7.7 9.4 5.9 12 5.9Z" /></svg>
}

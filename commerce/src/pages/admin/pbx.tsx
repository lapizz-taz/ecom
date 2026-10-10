import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Link2, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { formatDateTime, timeAgo } from '@/lib/format'
import { listPbxCalls, type PbxCall, type PbxSettings, pbxSettings, pbxStatus, pbxWebhookUrl, savePbxSecret, savePbxSettings } from '@/services/support'

const STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  ANSWERED: { label: 'Answered', variant: 'success' }, NO_ANSWER: { label: 'No answer', variant: 'warning' }, BUSY: { label: 'Busy', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'danger' }, RINGING: { label: 'Ringing', variant: 'info' }, UNKNOWN: { label: 'Unknown', variant: 'neutral' },
}
const duration = (s: number | null) => (s === null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)

export default function PbxPage() {
  const { can } = useAuth()
  return (
    <div className="space-y-4">
      <PageHeader title="VoiceDrive PBX"
        description="Connect your cloud PBX: every call is logged against the customer and their latest order, and staff can call with one click." />
      {can('settings.view') && <PbxSetup canEdit={can('settings.manage')} />}
      <CallLog />
    </div>
  )
}

function PbxSetup({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient()
  const { staff } = useStaffDirectory()
  const q = useQuery({ queryKey: ['pbx-settings'], queryFn: pbxSettings })
  const status = useQuery({ queryKey: ['pbx-status'], queryFn: pbxStatus, retry: false })
  const [draft, setDraft] = useState<PbxSettings | null>(null)
  const [secret, setSecret] = useState('')
  const [webhook, setWebhook] = useState<string | null>(null)
  useEffect(() => { if (q.data) setDraft(structuredClone(q.data)) }, [q.data])
  const save = useMutation({
    mutationFn: () => savePbxSettings(draft!),
    onSuccess: () => { toast.success('PBX settings saved'); void queryClient.invalidateQueries({ queryKey: ['pbx-settings'] }) },
  })
  const saveSecret = useMutation({
    mutationFn: savePbxSecret,
    onSuccess: (r) => { setWebhook(r.url); setSecret(''); toast.success('Saved securely'); void queryClient.invalidateQueries({ queryKey: ['pbx-status'] }) },
  })
  const reveal = useMutation({ mutationFn: pbxWebhookUrl, onSuccess: (r) => setWebhook(r.url) })
  if (q.isLoading || !draft) return q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState />
  const set = (p: Partial<PbxSettings>) => setDraft({ ...draft, ...p })
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data)
  const s = status.data
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => toast.error('Could not copy — select and copy by hand'))

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Connection</CardTitle>
            <CardDescription>Works with VoiceDrive and other Asterisk-based cloud PBXs (Issabel, FreePBX, most Bangladeshi providers).</CardDescription>
          </div>
          <Switch checked={draft.enabled} disabled={!canEdit} onCheckedChange={(v) => set({ enabled: v })} aria-label="PBX on" />
        </CardHeader>
        <CardContent>
          <fieldset disabled={!canEdit} className="grid gap-4">
            <Field label="Provider name" htmlFor="pbx-provider"><Input id="pbx-provider" value={draft.provider} onChange={(e) => set({ provider: e.target.value })} className="max-w-xs" /></Field>
            <Field label="How staff call customers">
              <RadioGroup value={draft.click_mode} onValueChange={(v) => set({ click_mode: v as 'tel' | 'api' })} className="grid gap-2">
                <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><RadioGroupItem value="tel" className="mt-0.5" />
                  <span><span className="font-medium">Phone link</span><span className="block text-xs text-muted-foreground">Opens the softphone or phone app on the staff member's device (Zoiper, MicroSIP, the PBX app).</span></span></label>
                <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><RadioGroupItem value="api" className="mt-0.5" />
                  <span><span className="font-medium">PBX click-to-call</span><span className="block text-xs text-muted-foreground">The server asks the PBX to ring the staff member's extension, then connects the customer.</span></span></label>
              </RadioGroup>
            </Field>
            {draft.click_mode === 'api' && (
              <div className="grid gap-3 rounded-lg bg-muted/40 p-3">
                <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
                  <Field label="Method">
                    <Select value={draft.api_method} onValueChange={(v) => set({ api_method: v as 'GET' | 'POST' })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="GET">GET</SelectItem><SelectItem value="POST">POST</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field label="Click-to-call address" htmlFor="pbx-url" hint="From your PBX's API guide. Use {number}, {extension} and {secret}.">
                    <Input id="pbx-url" className="font-mono text-xs" value={draft.api_url_template} placeholder="https://pbx.example.com/api/originate?ext={extension}&to={number}&key={secret}"
                      onChange={(e) => set({ api_url_template: e.target.value })} />
                  </Field>
                </div>
                {draft.api_method === 'POST' && (
                  <Field label="Request body (optional)" htmlFor="pbx-body" hint='JSON or form text, e.g. {"from":"{extension}","to":"{number}","token":"{secret}"}'>
                    <Textarea id="pbx-body" rows={3} className="font-mono text-xs" value={draft.api_body_template} onChange={(e) => set({ api_body_template: e.target.value })} />
                  </Field>
                )}
              </div>
            )}
          </fieldset>
        </CardContent>
        {canEdit && (
          <CardFooter className="justify-end gap-2 border-t">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
          </CardFooter>
        )}
      </Card>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Secret & call-log webhook</CardTitle>
            <CardDescription>The PBX API secret is kept in the server vault and only used by the server. Paste the webhook address into your PBX's "call event / CDR webhook" setting.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {status.error ? <p className="text-sm text-destructive">{(status.error as Error).message}</p> : (
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant={s?.has_api_secret ? 'success' : 'neutral'}><KeyRound /> API secret {s?.has_api_secret ? s.api_secret_hint : 'not saved'}</Badge>
                <Badge variant={s?.has_webhook ? 'success' : 'neutral'}><Link2 /> Webhook {s?.has_webhook ? 'ready' : 'not created'}</Badge>
              </div>
            )}
            {canEdit && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (secret.trim()) saveSecret.mutate({ api_secret: secret.trim() }) }}>
                <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s?.has_api_secret ? 'Replace the API secret' : 'PBX API key / token'} />
                <Button type="submit" disabled={!secret.trim() || saveSecret.isPending}>{saveSecret.isPending ? <Spinner /> : 'Save'}</Button>
              </form>
            )}
            {webhook ? (
              <div className="grid gap-1.5">
                <div className="flex gap-2"><Input readOnly value={webhook} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                  <Button type="button" variant="outline" size="icon" onClick={() => copy(webhook)} aria-label="Copy webhook address"><Copy /></Button></div>
                <p className="text-xs text-muted-foreground">Accepts JSON, form posts or GET. Fields such as uniqueid / call_id, src / from, dst / to, disposition / status, billsec / duration and recording URL are understood. Repeated events for one call update it — never a duplicate.</p>
              </div>
            ) : canEdit && (
              <div className="flex flex-wrap gap-2">
                {s?.has_webhook
                  ? <Button size="sm" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate()}><Link2 /> Show webhook address</Button>
                  : <Button size="sm" variant="outline" disabled={saveSecret.isPending} onClick={() => saveSecret.mutate({})}><Link2 /> Create webhook address</Button>}
              </div>
            )}
            {canEdit && s?.has_webhook && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" disabled={saveSecret.isPending} onClick={() => saveSecret.mutate({ rotate_webhook: true })}><RefreshCw /> New webhook address</Button>
                {s.has_api_secret && <Button size="sm" variant="ghost" disabled={saveSecret.isPending} onClick={() => saveSecret.mutate({ clear_api_secret: true })}><Trash2 /> Remove API secret</Button>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Staff extensions</CardTitle>
            <CardDescription>Links calls to the staff member who took them, and tells click-to-call which phone to ring.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {draft.extensions.map((e, i) => (
              <div key={i} className="flex gap-2">
                <Select value={e.profile_id} disabled={!canEdit} onValueChange={(v) => set({ extensions: draft.extensions.map((x, j) => (j === i ? { ...x, profile_id: v } : x)) })}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Staff member" /></SelectTrigger>
                  <SelectContent>{staff.filter((m) => m.is_active).map((m) => <SelectItem key={m.id} value={m.id}>{m.full_name || m.email}</SelectItem>)}</SelectContent>
                </Select>
                <Input className="w-28 font-mono" placeholder="101" value={e.extension} disabled={!canEdit} aria-label="Extension"
                  onChange={(ev) => set({ extensions: draft.extensions.map((x, j) => (j === i ? { ...x, extension: ev.target.value.trim() } : x)) })} />
                {canEdit && <Button variant="ghost" size="icon" aria-label="Remove extension" onClick={() => set({ extensions: draft.extensions.filter((_, j) => j !== i) })}><Trash2 /></Button>}
              </div>
            ))}
            {!draft.extensions.length && <p className="text-sm text-muted-foreground">No extensions yet.</p>}
            {canEdit && (
              <div className="flex justify-between gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => set({ extensions: [...draft.extensions, { profile_id: '', extension: '' }] })}><Plus /> Add extension</Button>
                <Button size="sm" disabled={!dirty || save.isPending || draft.extensions.some((e) => !e.profile_id || !e.extension)} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function CallLog() {
  const [phone, setPhone] = useState('')
  const { nameOf } = useStaffDirectory()
  const q = useQuery({ queryKey: ['pbx-calls', phone], queryFn: () => listPbxCalls({ phone: phone || undefined, limit: 200 }), refetchInterval: 30_000 })
  const icon = (c: PbxCall) => c.status === 'NO_ANSWER' || c.status === 'BUSY' ? <PhoneMissed className="size-4 text-amber-600" />
    : c.direction === 'OUTBOUND' ? <PhoneOutgoing className="size-4 text-sky-600" /> : c.direction === 'INBOUND' ? <PhoneIncoming className="size-4 text-emerald-600" /> : <PhoneCall className="size-4" />
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div><CardTitle className="text-base">Call log</CardTitle><CardDescription>Calls reported by the PBX, newest first.</CardDescription></div>
        <SearchInput value={phone} onChange={setPhone} placeholder="Customer phone" className="w-full sm:w-56" />
      </CardHeader>
      <CardContent>
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
          <EmptyState icon={<PhoneCall />} title="No calls yet" description="Calls appear here as soon as the PBX sends them to the webhook." />
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Call</TableHead><TableHead>Customer</TableHead><TableHead>Staff</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Talk time</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {q.data.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell><div className="flex items-center gap-2">{icon(c)}<span title={formatDateTime(c.started_at ?? c.received_at)}>{timeAgo(c.started_at ?? c.received_at)}</span></div></TableCell>
                    <TableCell className="font-mono text-xs">{c.customer_phone ?? (c.direction === 'OUTBOUND' ? c.to_number : c.from_number) ?? '—'}
                      {c.order_id && <Link to={`/admin/orders/${c.order_id}`} className="ml-2 font-sans text-brand hover:underline">Order</Link>}</TableCell>
                    <TableCell>{c.profile_id ? nameOf(c.profile_id) : c.extension ? `Ext ${c.extension}` : '—'}</TableCell>
                    <TableCell><Badge variant={STATUS[c.status]?.variant ?? 'neutral'}>{STATUS[c.status]?.label ?? c.status}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{duration(c.duration_seconds)}</TableCell>
                    <TableCell>{c.recording_url && <a href={c.recording_url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">Recording</a>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

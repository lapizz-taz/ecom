import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Users } from 'lucide-react'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MerchantMultiPicker } from '@/features/platform/services/merchant-picker'
import { useDebounce } from '@/hooks/use-debounce'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { MerchantRef } from '@/services/platform'
import {
  ANNOUNCEMENT_KINDS, type AnnouncementKind, type Audience, listAnnouncements, previewAudience, saveAnnouncement, sendAnnouncement,
} from '@/services/platform-ops'

export interface ComposerDraft {
  kind?: AnnouncementKind; severity?: 'INFO' | 'WARN' | 'CRITICAL'; title?: string; body?: string; link?: string
  audience?: Audience; merchants?: MerchantRef[]; incident_id?: string
}

const STATUSES = [
  { value: 'ACTIVE', label: 'Active' }, { value: 'ONBOARDING', label: 'Onboarding' }, { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'TRIALING', label: 'On trial' }, { value: 'PAST_DUE', label: 'Payment past due' }, { value: 'PAUSED', label: 'Subscription paused' },
]
const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

/**
 * Writes an in-app announcement. Who receives it is previewed live; sending
 * passes the previewed count, and the database refuses if it has changed.
 */
export function AnnouncementComposer({ initial, onClose }: { initial?: ComposerDraft; onClose: () => void }) {
  const queryClient = useQueryClient()
  const meta = useQuery({ queryKey: ['platform-announcements'], queryFn: listAnnouncements })
  const [f, setF] = useState({
    kind: initial?.kind ?? 'GENERAL' as AnnouncementKind, severity: initial?.severity ?? 'INFO' as 'INFO' | 'WARN' | 'CRITICAL',
    title: initial?.title ?? '', body: initial?.body ?? '', link: initial?.link ?? '',
    type: initial?.audience?.type ?? (initial?.merchants?.length ? 'MERCHANTS' : 'ALL') as Audience['type'],
    plans: initial?.audience?.plans ?? [] as string[], statuses: initial?.audience?.statuses ?? [] as string[],
    include_demo: initial?.audience?.include_demo ?? false, publish_at: '', expires_at: '',
  })
  const [merchants, setMerchants] = useState<MerchantRef[]>(initial?.merchants ?? [])
  const [confirm, setConfirm] = useState(false)
  // A failed send keeps its draft; trying again updates that draft instead of making another.
  const [savedId, setSavedId] = useState<string | null>(null)
  const audience: Audience = { type: f.type, include_demo: f.include_demo,
    ...(f.type === 'PLANS' && { plans: f.plans }), ...(f.type === 'STATUSES' && { statuses: f.statuses }), ...(f.type === 'MERCHANTS' && { merchants: merchants.map((m) => m.id) }) }
  const debounced = useDebounce(JSON.stringify([audience, f.kind]), 300)
  const preview = useQuery({ queryKey: ['platform-announcements', 'preview', debounced], queryFn: () => previewAudience(audience, f.kind) })
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const optional = meta.data?.optional_kinds.includes(f.kind)
  const canManage = meta.data?.can.manage ?? false
  const payload = () => ({
    ...(savedId && { id: savedId }),
    kind: f.kind, severity: f.severity, title: f.title.trim(), body: f.body.trim(), link: f.link.trim() || null, audience,
    publish_at: f.publish_at ? new Date(f.publish_at).toISOString() : null, expires_at: f.expires_at ? new Date(f.expires_at).toISOString() : null,
    incident_id: initial?.incident_id ?? null,
  })
  const done = () => { void queryClient.invalidateQueries({ queryKey: ['platform-announcements'] }); onClose() }
  const draft = useMutation({ mutationFn: () => saveAnnouncement(payload()), onSuccess: () => { toast.success('Saved as a draft'); done() } })
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const saved = await saveAnnouncement(payload())
      setSavedId(saved.id)
      return sendAnnouncement(saved.id, preview.data!.count)
    },
    onSuccess: (a) => {
      toast.success(a.status === 'SCHEDULED' ? 'Scheduled' : `Sent to ${formatNumber(a.recipients ?? 0)} merchant(s)`)
      done()
    },
    onError: () => { setConfirm(false); void preview.refetch() },
  })
  const valid = f.title.trim().length >= 3 && f.body.trim().length >= 3 && (f.type !== 'MERCHANTS' || merchants.length > 0)
    && (f.type !== 'PLANS' || f.plans.length > 0) && (f.type !== 'STATUSES' || f.statuses.length > 0)
  const busy = draft.isPending || send.isPending
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New announcement</DialogTitle>
          <DialogDescription>Shown inside the merchant's admin. Merchants can turn off feature news, recharge reminders and general notices; service notices always reach them.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" hint={ANNOUNCEMENT_KINDS.find((k) => k.value === f.kind)?.hint}>
              <Select value={f.kind} onValueChange={(kind) => setF({ ...f, kind: kind as AnnouncementKind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ANNOUNCEMENT_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Importance" hint="Critical notices show as a banner until read.">
              <Select value={f.severity} onValueChange={(severity) => setF({ ...f, severity: severity as typeof f.severity })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="INFO">Information</SelectItem><SelectItem value="WARN">Important</SelectItem><SelectItem value="CRITICAL">Critical</SelectItem></SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Title" required><Input maxLength={140} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message" required><Textarea rows={4} maxLength={4000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <Field label="Link (optional)" hint="A page in the app, like /admin/settings/billing, or an https:// address.">
            <Input value={f.link} placeholder="/admin/…" onChange={(e) => setF({ ...f, link: e.target.value })} />
          </Field>
          <div className="space-y-2">
            <Label>Who gets it</Label>
            <RadioGroup value={f.type} onValueChange={(type) => setF({ ...f, type: type as Audience['type'] })} className="grid gap-1.5 sm:grid-cols-4">
              {([['ALL', 'All merchants'], ['PLANS', 'By plan'], ['STATUSES', 'By status'], ['MERCHANTS', 'Chosen merchants']] as const).map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><RadioGroupItem value={v} /> {l}</label>
              ))}
            </RadioGroup>
            {f.type === 'PLANS' && (
              <div className="flex flex-wrap gap-3 rounded-md border p-3">{(meta.data?.plans ?? []).map((p) => (
                <label key={p.code} className="flex items-center gap-2 text-sm"><Checkbox checked={f.plans.includes(p.code)} onCheckedChange={() => setF({ ...f, plans: toggle(f.plans, p.code) })} /> {p.name}</label>
              ))}</div>
            )}
            {f.type === 'STATUSES' && (
              <div className="flex flex-wrap gap-3 rounded-md border p-3">{STATUSES.map((s) => (
                <label key={s.value} className="flex items-center gap-2 text-sm"><Checkbox checked={f.statuses.includes(s.value)} onCheckedChange={() => setF({ ...f, statuses: toggle(f.statuses, s.value) })} /> {s.label}</label>
              ))}</div>
            )}
            {f.type === 'MERCHANTS' && <MerchantMultiPicker value={merchants} onChange={setMerchants} />}
            {f.type !== 'MERCHANTS' && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={f.include_demo} onCheckedChange={(v) => setF({ ...f, include_demo: !!v })} /> Include demo merchants</label>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Publish at (optional)" hint="Leave empty to send now."><Input type="datetime-local" min={toLocal(new Date())} value={f.publish_at} onChange={(e) => setF({ ...f, publish_at: e.target.value })} /></Field>
            <Field label="Stop showing after (optional)"><Input type="datetime-local" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} /></Field>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-live="polite">
            {preview.isFetching && !preview.data ? <Spinner /> : preview.error ? <p className="text-red-500">{(preview.error as Error).message}</p> : preview.data && (
              <>
                <p className="flex items-center gap-1.5 font-medium"><Users className="size-4" /> {formatNumber(preview.data.count)} merchant(s) match
                  {optional && preview.data.muted > 0 && <span className="font-normal text-muted-foreground"> · {formatNumber(preview.data.muted)} turned this kind off and will not see it</span>}</p>
                {preview.data.sample.length > 0 && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{preview.data.sample.slice(0, 12).map((m) => `#${m.number} ${m.name}${m.muted ? ' (off)' : ''}`).join(', ')}{preview.data.count > 12 && ' …'}</p>
                )}
              </>
            )}
          </div>
          {send.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{(send.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="outline" disabled={busy || !valid} onClick={() => draft.mutate()}>{draft.isPending && <Spinner />} Save draft</Button>
          {canManage && (confirm ? (
            <Button disabled={busy || !valid || !preview.data?.count} onClick={() => send.mutate()}>
              {send.isPending ? <Spinner /> : <Send />} Confirm: {f.publish_at ? 'schedule for' : 'send to'} {formatNumber(preview.data?.count ?? 0)}
            </Button>
          ) : (
            <Button disabled={busy || !valid || !preview.data?.count || preview.isFetching} onClick={() => setConfirm(true)}><Send /> {f.publish_at ? 'Schedule' : 'Send'}…</Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

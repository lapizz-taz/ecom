import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCheck, MessageCircle, RotateCcw, Save, Send, Upload } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { EVENT_INFO, fillWhatsapp, type MessageEvent, WHATSAPP_MAX_BODY, WHATSAPP_VARIABLES, whatsappProblems } from '@/features/messaging/shared'
import { WhatsappStatusBadge, whatsappState } from '@/features/messaging/whatsapp-status'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { getMessage, resetMessage, saveMessage, setMessageEnabled, submitWhatsapp, testWhatsapp, whatsappSettings } from '@/services/messaging'

const EXAMPLES = Object.fromEntries(WHATSAPP_VARIABLES.map((v) => [v.name, v.example]))

/** WhatsApp's own text styles: *bold*, _italic_, ~strikethrough~. */
function Styled({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g)
  return parts.map((p, i) => {
    if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>
    if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>
    return <Fragment key={i}>{p}</Fragment>
  })
}

/** One WhatsApp message: its words, Meta's review, and a phone-style preview. */
export default function WhatsappTemplatePage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const manage = can('notifications.manage')
  const queryClient = useQueryClient()
  const message = useQuery({ queryKey: ['customer-message', id], queryFn: () => getMessage(id) })
  const settings = useQuery({ queryKey: ['whatsapp-settings'], queryFn: whatsappSettings })
  const [draft, setDraft] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [phone, setPhone] = useState('')
  const editor = useRef<HTMLTextAreaElement>(null)

  const m = message.data
  useEffect(() => {
    if (m && draft === null) setDraft(m.template)
  }, [m, draft])
  const dirty = !!m && draft !== null && draft !== m.template
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const problems = useMemo(() => (draft === null ? [] : whatsappProblems(draft)), [draft])

  const refresh = (row?: unknown) => {
    if (row) queryClient.setQueryData(['customer-message', id], row)
    void queryClient.invalidateQueries({ queryKey: ['customer-messages', 'WHATSAPP'] })
  }
  const save = useMutation({
    mutationFn: () => saveMessage(id, null, draft!),
    onSuccess: (row) => { toast.success('Message saved'); refresh(row) },
  })
  const submit = useMutation({
    mutationFn: async () => {
      if (dirty) refresh(await saveMessage(id, null, draft!))
      return submitWhatsapp(id)
    },
    onSuccess: (r) => {
      toast.success(r.status === 'APPROVED' ? 'Meta approved it' : 'Sent to Meta for review')
      void message.refetch()
      refresh()
    },
  })
  const toggle = useMutation({
    mutationFn: (on: boolean) => setMessageEnabled(id, on),
    onSuccess: (_d, on) => { toast.success(on ? 'This message is on' : 'This message is off'); void message.refetch(); refresh() },
  })
  const test = useMutation({
    mutationFn: () => testWhatsapp(id, phone),
    onSuccess: (r) => { toast.success(`Test message sent to ${r.sent_to}`); setTesting(false) },
  })

  const insert = (name: string) => {
    if (draft === null || !manage) return
    const tag = `{{${name}}}`
    const t = editor.current
    const start = t?.selectionStart ?? draft.length
    const end = t?.selectionEnd ?? draft.length
    setDraft(draft.slice(0, start) + tag + draft.slice(end))
    requestAnimationFrame(() => {
      t?.focus()
      t?.setSelectionRange(start + tag.length, start + tag.length)
    })
  }

  if (message.isLoading) return <LoadingState />
  if (message.error) return <ErrorState error={message.error} onRetry={() => message.refetch()} />
  if (!m || m.channel !== 'WHATSAPP') return <EmptyState icon={<MessageCircle className="size-5" />} title="Message not found" />
  const info = EVENT_INFO[m.event as MessageEvent]
  const state = whatsappState(m)
  const number = settings.data?.numbers.find((n) => n.id === settings.data?.channel_id)
  const canSubmit = !!number?.waba_id && !problems.length && draft !== null && (dirty || state.edited || !state.submitted || m.wa_status === 'REJECTED' || m.wa_status === 'DELETED' || m.wa_status === 'DISABLED')
  const length = draft?.trim().length ?? 0

  return (
    <div className="space-y-4">
      <PageHeader back={{ to: '/admin/whatsapp', label: 'WhatsApp' }} title={info?.title ?? m.event} description={info?.when}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm">
              {m.is_enabled ? 'On' : 'Off'}
              <Switch checked={m.is_enabled} disabled={!manage || toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} aria-label="Send this message" />
            </label>
            {manage && (
              <>
                <Button variant="ghost" onClick={() => setResetting(true)}><RotateCcw /> Reset to default</Button>
                <Button variant="outline" disabled={!dirty || !!problems.length || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
                <Button disabled={!canSubmit || submit.isPending} title={number?.waba_id ? undefined : 'Choose the sending number in WhatsApp → Setup first'}
                  onClick={() => submit.mutate()}>{submit.isPending ? <Spinner /> : <Upload />} Submit to Meta</Button>
              </>
            )}
          </>
        } />

      {draft !== null && (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-4">
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="wa_text">Message</Label>
                  <span className={`text-xs tabular-nums ${length > WHATSAPP_MAX_BODY ? 'text-red-600' : 'text-muted-foreground'}`}>{length} / {WHATSAPP_MAX_BODY}</span>
                </div>
                <Textarea id="wa_text" ref={editor} value={draft} disabled={!manage} rows={10} className="text-sm leading-relaxed"
                  onChange={(e) => setDraft(e.target.value)} />
                {problems.length > 0 && (
                  <ul className="space-y-1 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    {problems.map((p) => <li key={p} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {p}</li>)}
                  </ul>
                )}
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Click to insert where the cursor is. Use *bold* and _italic_ as in WhatsApp.</p>
                  <div className="flex flex-wrap gap-1.5">
                    {WHATSAPP_VARIABLES.map((v) => (
                      <button key={v.name} type="button" disabled={!manage} onClick={() => insert(v.name)} title={`{{${v.name}}}`}
                        className="rounded-md border bg-muted/40 px-2 py-1 text-xs hover:bg-muted disabled:opacity-60">{v.label}</button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
                <CardTitle className="text-base">Meta review</CardTitle>
                <WhatsappStatusBadge message={m} />
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{state.hint}</p>
                {state.edited && <p className="text-amber-700">You changed the text after submitting it. Customers keep getting the submitted text until you submit the new one.</p>}
                {state.submitted && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Template</dt><dd className="font-mono">{m.wa_name}</dd>
                    <dt className="text-muted-foreground">Language</dt><dd>{m.wa_language === 'bn' ? 'Bangla' : 'English'}</dd>
                    {m.wa_checked_at && <><dt className="text-muted-foreground">Checked</dt><dd>{formatDateTime(m.wa_checked_at)}</dd></>}
                  </dl>
                )}
                {state.approved && manage && (
                  <Button variant="outline" size="sm" onClick={() => setTesting(true)}><Send /> Send a test</Button>
                )}
                {!number?.waba_id && <p className="text-xs text-amber-700">Choose the sending number in WhatsApp → Setup before submitting.</p>}
              </CardContent>
            </Card>
          </div>

          {/* A phone-style preview with example values (WhatsApp's light chat colours). */}
          <div className="h-fit overflow-hidden rounded-2xl border">
            <div className="flex items-center gap-2.5 bg-[#008069] px-4 py-3 text-white">
              <span className="flex size-8 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">{number?.name?.[0]?.toUpperCase() || 'S'}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{number?.name || 'Your store'}</span>
                <span className="block text-[11px] text-white/80">Business account</span>
              </span>
            </div>
            <div className="min-h-80 bg-[#efeae2] p-4">
              <div className="max-w-[88%] rounded-lg rounded-tl-none bg-white px-3 py-2 text-[13.5px] leading-snug text-[#111b21] shadow-sm">
                <p className="break-words whitespace-pre-wrap"><Styled text={fillWhatsapp(draft.trim(), EXAMPLES)} /></p>
                <span className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-[#667781]">10:42 <CheckCheck className="size-3.5 text-[#53bdeb]" /></span>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={resetting} onOpenChange={setResetting} title="Reset this message?" confirmLabel="Reset"
        description="The text goes back to Fullfilio's wording. Submit it to Meta again afterwards to use it."
        onConfirm={async () => {
          const row = await resetMessage(id)
          setDraft(null)
          refresh(row)
          toast.success('Back to the default text')
        }} />

      <Dialog open={testing} onOpenChange={(o) => !test.isPending && setTesting(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send a test</DialogTitle>
            <DialogDescription>The approved message goes to this WhatsApp number with example values.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="wa_test_phone">WhatsApp number</Label>
            <Input id="wa_test_phone" inputMode="tel" placeholder="01711000000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTesting(false)}>Cancel</Button>
            <Button disabled={test.isPending || phone.replace(/\D/g, '').length < 10} onClick={() => test.mutate()}>{test.isPending ? <Spinner /> : <Send />} Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

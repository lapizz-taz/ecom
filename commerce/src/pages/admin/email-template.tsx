import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CircleCheck, Mail, Monitor, RotateCcw, Save, Send, Smartphone } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { EMAIL_VARIABLES, EVENT_INFO, type MessageEvent, renderLiquid, SAMPLE_DATA, variablesFor } from '@/features/messaging/shared'
import { toast } from '@/lib/toast'
import { emailSettings, getMessage, previewData, resetMessage, saveMessage, sendTestEmail, setMessageEnabled, setReplyButtons } from '@/services/messaging'

const SAMPLE_REPLY_URL = (SAMPLE_DATA.order as { reply_url: string }).reply_url

type Rendered = { subject: string; html: string; error: null } | { subject: string; html: string; error: string }

function render(subject: string, template: string, data: Record<string, unknown>): Rendered {
  let s = ''
  try {
    s = renderLiquid(subject, data, { mode: 'text' }).replace(/\s+/g, ' ').trim()
    return { subject: s, html: renderLiquid(template, data), error: null }
  } catch (e) {
    return { subject: s, html: '', error: (e as Error).message }
  }
}

/** One customer email: its subject and code (Liquid, like Shopify), with a live preview. */
export default function EmailTemplatePage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const manage = can('notifications.manage')
  const queryClient = useQueryClient()
  const message = useQuery({ queryKey: ['customer-message', id], queryFn: () => getMessage(id) })
  const settings = useQuery({ queryKey: ['email-settings'], queryFn: emailSettings })
  const realOrder = useQuery({ queryKey: ['notification-preview-data'], queryFn: () => previewData(), staleTime: 60_000 })
  const [draft, setDraft] = useState<{ subject: string; template: string } | null>(null)
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop')
  const [useSample, setUseSample] = useState(false)
  const [resetting, setResetting] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const lastFocus = useRef<'subject' | 'template'>('template')

  const m = message.data
  useEffect(() => {
    if (m && draft === null) setDraft({ subject: m.subject ?? '', template: m.template })
  }, [m, draft])
  const dirty = !!m && !!draft && (draft.subject !== (m.subject ?? '') || draft.template !== m.template)
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // The store's latest order when there is one; otherwise a made-up order in the store's own name and colours.
  // The confirm page's link is there only when this email asks the customer to confirm (as when it is sent).
  const asksToConfirm = !!m?.reply_buttons && m.event === 'ORDER_CREATED'
  const data = useMemo(() => {
    const s = settings.data
    const shop = SAMPLE_DATA.shop as Record<string, unknown>
    const base = realOrder.data && !useSample ? realOrder.data
      : { ...SAMPLE_DATA, shop: { ...shop, name: s?.store.name || shop.name, email: s?.store.email || shop.email,
          logo_url: s?.design.logo_url ?? s?.store.logo_url ?? null, accent_color: s?.design.accent_color ?? shop.accent_color } }
    const { reply_url: _reply, ...order } = (base.order ?? {}) as Record<string, unknown>
    // A cart reminder is about a cart, not an order: the sample cart when the store's order has none.
    return { ...base, cart: base.cart ?? SAMPLE_DATA.cart, order: asksToConfirm ? { ...order, reply_url: SAMPLE_REPLY_URL } : order }
  }, [realOrder.data, settings.data, useSample, asksToConfirm])
  const deferred = useDeferredValue(draft)
  const preview = useMemo(() => deferred ? render(deferred.subject, deferred.template, data) : null, [deferred, data])

  const refresh = (row?: unknown) => {
    if (row) queryClient.setQueryData(['customer-message', id], row)
    void queryClient.invalidateQueries({ queryKey: ['customer-messages', 'EMAIL'] })
  }
  const save = useMutation({
    mutationFn: () => saveMessage(id, draft!.subject, draft!.template),
    onSuccess: (row) => { toast.success('Email saved'); refresh(row) },
  })
  const toggle = useMutation({
    mutationFn: (on: boolean) => setMessageEnabled(id, on),
    onSuccess: (_d, on) => { toast.success(on ? 'This email is on' : 'This email is off'); void message.refetch(); refresh() },
  })
  const confirm = useMutation({
    mutationFn: (on: boolean) => setReplyButtons(id, on),
    onSuccess: (row, on) => { toast.success(on ? 'Customers can confirm or cancel from this email' : 'No confirm button in this email'); refresh(row) },
  })
  const test = useMutation({
    mutationFn: () => sendTestEmail(id, { subject: draft!.subject, template: draft!.template, data }),
    onSuccess: (r) => toast.success(`Test email sent to ${r.sent_to}`),
  })

  const insert = (name: string) => {
    if (!draft || !manage) return
    const tag = `{{ ${name} }}`
    const field = lastFocus.current === 'subject' ? subjectRef.current : editor.current
    const key = lastFocus.current
    const value = draft[key]
    const start = field?.selectionStart ?? value.length
    const end = field?.selectionEnd ?? value.length
    setDraft({ ...draft, [key]: value.slice(0, start) + tag + value.slice(end) })
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(start + tag.length, start + tag.length)
    })
  }

  if (message.isLoading) return <LoadingState />
  if (message.error) return <ErrorState error={message.error} onRetry={() => message.refetch()} />
  if (!m || m.channel !== 'EMAIL') return <EmptyState icon={<Mail className="size-5" />} title="Email not found" />
  const info = EVENT_INFO[m.event as MessageEvent]
  const ready = settings.data?.ready ?? false

  return (
    <div className="space-y-4">
      <PageHeader back={{ to: '/admin/email', label: 'Email' }} title={info?.title ?? m.event} description={info?.when}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm">
              {m.is_enabled ? 'On' : 'Off'}
              <Switch checked={m.is_enabled} disabled={!manage || toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} aria-label="Send this email" />
            </label>
            {manage && (
              <>
                <Button variant="ghost" onClick={() => setResetting(true)}><RotateCcw /> Reset to default</Button>
                <Button variant="outline" disabled={!draft || !!preview?.error || test.isPending || !ready} title={ready ? 'Sends this version to your own email' : 'Set up sending first'}
                  onClick={() => test.mutate()}>{test.isPending ? <Spinner /> : <Send />} Send test</Button>
                <Button disabled={!dirty || !!preview?.error || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
              </>
            )}
          </>
        } />

      {draft && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="min-w-0 space-y-3">
            {m.event === 'ORDER_CREATED' && (
              <label className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Ask the customer to confirm</span>
                  <span className="block text-xs text-muted-foreground">
                    Adds a <span className="font-medium text-foreground">Confirm your order</span> button and a cancel link. A confirmed order is
                    marked “Customer confirmed” (or approved, if you choose that in Settings → Customer messages); a cancel cancels it before you approve it.
                  </span>
                </span>
                <Switch checked={m.reply_buttons} disabled={!manage || confirm.isPending} onCheckedChange={(on) => confirm.mutate(on)} aria-label="Ask the customer to confirm" />
              </label>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email_subject">Subject</Label>
              <Input id="email_subject" ref={subjectRef} value={draft.subject} maxLength={300} disabled={!manage}
                onFocus={() => { lastFocus.current = 'subject' }} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="email_code">Email body (HTML and Liquid)</Label>
                {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
              </div>
              <Textarea id="email_code" ref={editor} value={draft.template} disabled={!manage} spellCheck={false}
                onFocus={() => { lastFocus.current = 'template' }}
                onKeyDown={(e) => {
                  // Tab indents instead of leaving the editor.
                  if (e.key !== 'Tab' || e.shiftKey) return
                  e.preventDefault()
                  const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd
                  setDraft({ ...draft, template: `${draft.template.slice(0, a)}  ${draft.template.slice(b)}` })
                  requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2))
                }}
                onChange={(e) => setDraft({ ...draft, template: e.target.value })}
                className="h-[520px] resize-y font-mono text-xs leading-relaxed [tab-size:2]" />
              {preview?.error && (
                <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {preview.error}
                </p>
              )}
            </div>
            <details className="rounded-lg border bg-card" open>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Variables <span className="font-normal text-muted-foreground">· click to insert where the cursor is</span></summary>
              <div className="flex flex-wrap gap-1.5 border-t p-3">
                {variablesFor(EMAIL_VARIABLES, m.event).map((v) => (
                  <button key={v.name} type="button" disabled={!manage} onClick={() => insert(v.name)} title={`{{ ${v.name} }}`}
                    className="rounded-md border bg-muted/40 px-2 py-1 text-xs hover:bg-muted disabled:opacity-60">{v.label}</button>
                ))}
              </div>
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                Also: <code>{`{% for item in ${m.event === 'CART_REMINDER' ? 'cart' : 'order'}.line_items %}`}</code> … <code>{'{{ item.title }}'}</code>, <code>{'{{ item.quantity }}'}</code>, <code>{'{{ item.line_price | money }}'}</code> … <code>{'{% endfor %}'}</code>,
                and <code>{'{% if %}'}</code>, <code>{'{% unless %}'}</code>, <code>{'{% assign %}'}</code>, <code>{'| default: "…"'}</code>, <code>{'| upcase'}</code>, <code>{'| date: "%d %b"'}</code>.
              </p>
            </details>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-lg border p-0.5">
                <Button size="sm" variant={width === 'desktop' ? 'secondary' : 'ghost'} onClick={() => setWidth('desktop')}><Monitor /> Desktop</Button>
                <Button size="sm" variant={width === 'mobile' ? 'secondary' : 'ghost'} onClick={() => setWidth('mobile')}><Smartphone /> Mobile</Button>
              </div>
              {realOrder.data ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Sample order <Switch checked={useSample} onCheckedChange={setUseSample} aria-label="Preview with a sample order" />
                </label>
              ) : <span className="text-xs text-muted-foreground">Preview with a sample order</span>}
            </div>
            <div className="overflow-hidden rounded-xl border bg-muted/40">
              <div className="border-b bg-card px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">Subject:</span> <span className="font-medium">{preview?.subject || '—'}</span>
              </div>
              <div className="flex justify-center p-3">
                {/* The email as sent, in a sandbox: no scripts, no access to this page. Mounted with its HTML: an
                    empty frame that gets its HTML while still loading the empty one can stay blank. */}
                {preview?.html ? (
                  <iframe title="Email preview" sandbox="" srcDoc={preview.html}
                    className={`h-[640px] rounded-md border bg-white transition-[width] ${width === 'mobile' ? 'w-[375px] max-w-full' : 'w-full'}`} />
                ) : <div className="h-[640px] w-full rounded-md border bg-white" />}
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={resetting} onOpenChange={setResetting} title="Reset this email?" confirmLabel="Reset"
        description="The subject and code go back to Fullfilio's design. Your changes to this email are lost."
        onConfirm={async () => {
          const row = await resetMessage(id)
          setDraft(null)
          refresh(row)
          toast.success('Back to the default email')
        }} />
    </div>
  )
}

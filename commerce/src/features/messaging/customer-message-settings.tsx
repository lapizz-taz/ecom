import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, ShoppingCart, Star, SunMedium, ThumbsUp } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  type MessageChannelAll, type MessageLanguage, type MessagingSettings, type MessagingSettingsPatch, messagingSettings,
  saveMessagingSettings, setMessagingLanguage,
} from '@/services/messaging'

const LANGUAGE: Record<MessageLanguage, string> = { en: 'English', bn: 'Bangla (বাংলা)' }
const CHANNEL: Record<MessageChannelAll, { label: string; to: string }> = {
  SMS: { label: 'SMS', to: '/admin/sms?tab=automations' },
  EMAIL: { label: 'Email', to: '/admin/email' },
  WHATSAPP: { label: 'WhatsApp', to: '/admin/whatsapp' },
}
const FIRST_MINUTES = [30, 60, 120, 180, 360, 720, 1440]
const SECOND_HOURS = [6, 12, 24, 48, 72]
const REVIEW_DAYS = [1, 2, 3, 4, 5, 7, 10, 14]
const after = (minutes: number) => (minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`)
const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`

/**
 * Settings shared by SMS, email and WhatsApp: the language customers get, what a customer's
 * Confirm does, abandoned cart and review timing, and the owner's morning summary.
 */
export function CustomerMessageSettings({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['messaging-settings'], queryFn: messagingSettings })
  const save = useMutation({
    mutationFn: (p: MessagingSettingsPatch) => saveMessagingSettings(p),
    onSuccess: (s) => { toast.success('Saved'); queryClient.setQueryData(['messaging-settings'], s) },
  })

  if (settings.isLoading) return <LoadingState />
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
  const s = settings.data
  if (!s) return null
  const disabled = !canManage || save.isPending

  return (
    <div className="space-y-4">
      <LanguageCard settings={s} canManage={canManage} />

      <Section icon={<ThumbsUp />} title="Customer confirms the order"
        description="The order confirmation by email and WhatsApp can ask the customer to confirm: a Confirm button (and a cancel link) in the email, Confirm and Cancel buttons on WhatsApp. Fewer calls, fewer fake orders and parcels sent back."
        channels={s.enabled.confirm} off="Switch on “Ask the customer to confirm” in the Order confirmation of Email or WhatsApp.">
        <SwitchRow checked={s.confirm.auto_approve} disabled={disabled} onChange={(on) => save.mutate({ confirm: { auto_approve: on } })}
          title="Approve the order when the customer confirms"
          text="Off: the order is marked “Customer confirmed” and waits for your team. On: it is approved straight away (orders waiting for an advance or a check stay where they are). A cancel before approval always cancels the order; after approval your team gets a request on the order." />
      </Section>

      <Section icon={<ShoppingCart />} title="Abandoned cart reminders"
        description="A customer who left checkout with a phone number or email gets a reminder with a link back to the same cart. Sent between 9 AM and 9 PM only."
        channels={s.enabled.cart} off="Switch on “Abandoned cart reminder” in SMS, Email or WhatsApp.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First reminder">
            <Select value={String(s.cart.first_minutes)} disabled={disabled}
              onValueChange={(v) => save.mutate({ cart: { ...s.cart, first_minutes: Number(v) } })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{FIRST_MINUTES.map((m) => <SelectItem key={m} value={String(m)}>{after(m)} after they leave</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Second reminder">
            <Select value={s.cart.second ? String(s.cart.second_hours) : 'off'} disabled={disabled}
              onValueChange={(v) => save.mutate({ cart: { ...s.cart, second: v !== 'off', second_hours: v === 'off' ? s.cart.second_hours : Number(v) } })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">No second reminder</SelectItem>
                {SECOND_HOURS.map((h) => <SelectItem key={h} value={String(h)}>{h} hours after the first</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <dl className="grid grid-cols-3 divide-x rounded-lg border text-center">
          <Stat label={`Reminded (${s.cart_stats.days} days)`} value={formatNumber(s.cart_stats.reminded)} />
          <Stat label="Bought after" value={formatNumber(s.cart_stats.recovered)} />
          <Stat label="Sales recovered" value={formatMoney(s.cart_stats.recovered_value)} />
        </dl>
      </Section>

      <ReviewSection settings={s} disabled={disabled} onSave={(p) => save.mutate(p)} />
      <SummarySection settings={s} disabled={disabled} saving={save.isPending} onSave={(p) => save.mutate(p)} />
    </div>
  )
}

function LanguageCard({ settings, canManage }: { settings: MessagingSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [next, setNext] = useState<MessageLanguage | null>(null)
  const [apply, setApply] = useState(true)
  const change = useMutation({
    mutationFn: (lang: MessageLanguage) => setMessagingLanguage(lang, apply),
    onSuccess: (r) => {
      const parts = [`Customers now get ${LANGUAGE[r.language].split(' ')[0]}`]
      if (r.changed) parts.push(`${r.changed} text${r.changed === 1 ? '' : 's'} switched`)
      if (r.custom) parts.push(`${r.custom} you wrote stay as they are`)
      toast.success(parts.join(' · '))
      if (r.whatsapp_to_submit) toast.info(`Submit ${r.whatsapp_to_submit} WhatsApp message${r.whatsapp_to_submit === 1 ? '' : 's'} to Meta again in the new language.`)
      setNext(null)
      for (const key of [['messaging-settings'], ['whatsapp-settings'], ['customer-messages'], ['customer-message'], ['sms-rules']]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
  return (
    <Section icon={<Languages />} title="Language"
      description="The language of every SMS, email and WhatsApp message customers get, and of the confirm page.">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={settings.language} disabled={!canManage || change.isPending} onValueChange={(v) => v !== settings.language && setNext(v as MessageLanguage)}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="en">{LANGUAGE.en}</SelectItem>
            <SelectItem value="bn">{LANGUAGE.bn}</SelectItem>
          </SelectContent>
        </Select>
        {change.isPending && <Spinner />}
      </div>
      <ConfirmDialog open={next !== null} onOpenChange={(o) => !o && setNext(null)} title={`Send customer messages in ${next ? LANGUAGE[next] : ''}?`}
        confirmLabel="Change language" onConfirm={async () => { if (next) await change.mutateAsync(next) }}
        description={
          <span className="block space-y-3">
            <span className="block">Fullfilio has every message written in both languages. WhatsApp messages need Meta’s approval again in the new language.</span>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox checked={apply} onCheckedChange={(v) => setApply(v === true)} className="mt-0.5" />
              Switch the texts that are still Fullfilio’s to the new language (texts you wrote yourself stay as they are)
            </label>
          </span>
        } />
    </Section>
  )
}

function ReviewSection({ settings: s, disabled, onSave }: { settings: MessagingSettings; disabled: boolean; onSave: (p: MessagingSettingsPatch) => void }) {
  const [url, setUrl] = useState(s.review.url)
  useEffect(() => setUrl(s.review.url), [s.review.url])
  const valid = url.trim() === '' || /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url.trim())
  return (
    <Section icon={<Star />} title="Review requests"
      description="A few days after a parcel is delivered, the customer is asked for a review: on your Facebook page, Google or your website. Sent between 9 AM and 9 PM."
      channels={s.enabled.review} off="Switch on “Review request” in SMS, Email or WhatsApp.">
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <Field label="Ask">
          <Select value={String(s.review.days)} disabled={disabled} onValueChange={(v) => onSave({ review: { ...s.review, days: Number(v) } })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{REVIEW_DAYS.map((d) => <SelectItem key={d} value={String(d)}>{d} day{d === 1 ? '' : 's'} after delivery</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Review link" htmlFor="review_url">
          <div className="flex gap-2">
            <Input id="review_url" value={url} disabled={disabled} maxLength={500} placeholder="https://www.facebook.com/yourpage/reviews"
              onChange={(e) => setUrl(e.target.value)} aria-invalid={!valid} />
            <Button variant="outline" disabled={disabled || !valid || url.trim() === s.review.url} onClick={() => onSave({ review: { ...s.review, url: url.trim() } })}>Save</Button>
          </div>
        </Field>
      </div>
      {!valid && <p className="text-xs text-destructive">Enter the full link, starting with https://</p>}
      {!s.review.url && <p className="text-xs text-amber-700">Add the link first: without it the message has nowhere to send the customer.</p>}
    </Section>
  )
}

function SummarySection({ settings: s, disabled, saving, onSave }: {
  settings: MessagingSettings; disabled: boolean; saving: boolean; onSave: (p: MessagingSettingsPatch) => void
}) {
  const [emails, setEmails] = useState(s.summary.emails.join(', '))
  useEffect(() => setEmails(s.summary.emails.join(', ')), [s.summary.emails])
  const list = [...new Set(emails.split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))]
  const dirty = list.join(',') !== s.summary.emails.join(',')
  const add = (email: string) => setEmails([...list, email].join(', '))
  const put = (p: Partial<MessagingSettings['summary']>) => onSave({ summary: { enabled: s.summary.enabled, hour: s.summary.hour, emails: list, ...p } })
  return (
    <Section icon={<SunMedium />} title="Daily summary for the owner"
      description="One email each morning with yesterday’s orders, approvals, shipments, deliveries, returns, ad spend and profit, and what is still waiting.">
      {!s.email_ready && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          It goes out through your email setup: <Link to="/admin/email?tab=sender" className="font-medium underline">set up sending and switch emails on</Link> first.
        </p>
      )}
      <SwitchRow checked={s.summary.enabled} disabled={disabled || (!s.summary.enabled && list.length === 0)}
        onChange={(on) => put({ enabled: on })} title="Send the daily summary"
        text={s.summary.last_sent ? `Last sent ${formatDateTime(s.summary.last_sent)}.` : list.length ? 'Not sent yet.' : 'Add who gets it below first.'} />
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <Field label="Send at">
          <Select value={String(s.summary.hour)} disabled={disabled} onValueChange={(v) => put({ hour: Number(v) })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Send to (up to 5)" htmlFor="summary_emails">
          <div className="flex gap-2">
            <Input id="summary_emails" value={emails} disabled={disabled} placeholder="owner@yourshop.com" onChange={(e) => setEmails(e.target.value)} />
            <Button variant="outline" disabled={disabled || !dirty || list.length > 5} onClick={() => put({})}>{saving ? <Spinner /> : 'Save'}</Button>
          </div>
        </Field>
      </div>
      {s.staff_emails.some((e) => !list.includes(e)) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Your team:
          {s.staff_emails.filter((e) => !list.includes(e)).slice(0, 8).map((e) => (
            <button key={e} type="button" disabled={disabled} onClick={() => add(e)} className="rounded-md border px-1.5 py-0.5 hover:bg-muted hover:text-foreground">+ {e}</button>
          ))}
        </div>
      )}
    </Section>
  )
}

function Section({ icon, title, description, channels, off, children }: {
  icon: ReactNode; title: string; description: string; channels?: MessageChannelAll[]; off?: string; children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          {channels && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              {channels.length ? (
                <>
                  <span className="text-muted-foreground">On for</span>
                  {channels.map((c) => <Link key={c} to={CHANNEL[c].to}><Badge variant="success">{CHANNEL[c].label}</Badge></Link>)}
                </>
              ) : <span className="text-amber-700">Off. {off}</span>}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  )
}

function SwitchRow({ checked, disabled, onChange, title, text }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void; title: string; text: string }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border p-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{text}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
    </label>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-2.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

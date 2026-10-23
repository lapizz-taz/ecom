import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, Mail, Send, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { connectMailbox, disconnectMailbox, type EmailSettings, type MailboxInput, saveEmailSettings } from '@/services/messaging'

/** Mail servers sellers in Bangladesh use most, with their SSL settings (port 465 works everywhere we send from). */
const PRESETS = [
  { id: 'gmail', label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465, security: 'ssl', help: 'Turn on 2-Step Verification, then make an app password.', link: 'https://myaccount.google.com/apppasswords' },
  { id: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'ssl', help: 'Use an app-specific password if two-factor sign-in is on.', link: 'https://accounts.zoho.com/home#security/app_password' },
  { id: 'yahoo', label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl', help: 'Make an app password in Account security.', link: 'https://login.yahoo.com/account/security' },
  { id: 'hostinger', label: 'Hostinger email', host: 'smtp.hostinger.com', port: 465, security: 'ssl', help: 'Use the mailbox password from hPanel → Emails.', link: '' },
  { id: 'namecheap', label: 'Namecheap Private Email', host: 'mail.privateemail.com', port: 465, security: 'ssl', help: 'Use the mailbox password.', link: '' },
  { id: 'other', label: 'Other (cPanel, your hosting)', host: '', port: 465, security: 'ssl', help: 'Your host lists the SMTP server; it is often mail.yourdomain.com with SSL on port 465.', link: '' },
] as const

/** How customer emails go out: the seller's own mailbox, or Fullfilio's email service. */
export function EmailSender({ settings, canManage }: { settings: EmailSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['email-settings'] })
  const [identity, setIdentity] = useState({ from_name: settings.from_name, reply_to: settings.reply_to })
  useEffect(() => setIdentity({ from_name: settings.from_name, reply_to: settings.reply_to }), [settings.from_name, settings.reply_to])
  const save = useMutation({
    mutationFn: (p: Parameters<typeof saveEmailSettings>[0]) => saveEmailSettings(p),
    onSuccess: () => { toast.success('Saved'); void refresh() },
  })
  const useService = settings.provider === 'fullfilio'

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Send from</CardTitle>
            <CardDescription>Choose where your customer emails come from. You can switch at any time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Choice active={settings.provider === 'smtp'} title="Your own mailbox" badge="No API needed"
              text="Gmail, Zoho, Yahoo or your hosting email. Emails come from your own address. Free."
              disabled={!canManage || !settings.smtp_saved} onPick={() => save.mutate({ provider: 'smtp' })}
              note={settings.smtp_saved ? undefined : 'Connect it below first.'} />
            <Choice active={useService} title="Fullfilio email service" badge={settings.service.available ? `${settings.service.daily_limit} a day` : 'Not available yet'}
              text={settings.service.available ? `Sent from ${settings.service.from_email} with your store name; replies come to you.` : 'Fullfilio has not switched this on yet.'}
              disabled={!canManage || !settings.service.available} onPick={() => save.mutate({ provider: 'fullfilio' })} />
          </CardContent>
        </Card>

        <MailboxForm settings={settings} canManage={canManage} onDone={() => void refresh()} />
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Sender details</CardTitle>
          <CardDescription>What customers see in their inbox.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="from_name">Sender name</Label>
            <Input id="from_name" value={identity.from_name} placeholder={settings.store.name || 'Your store'} disabled={!canManage}
              onChange={(e) => setIdentity({ ...identity, from_name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reply_to">Replies go to</Label>
            <Input id="reply_to" type="email" value={identity.reply_to} placeholder={settings.store.email || 'you@yourstore.com'} disabled={!canManage}
              onChange={(e) => setIdentity({ ...identity, reply_to: e.target.value })} />
            <p className="text-xs text-muted-foreground">Empty: your store email from Settings.</p>
          </div>
          {useService && (
            <p className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
              Today: {settings.service.sent_today} of {settings.service.daily_limit} emails through Fullfilio. Connect your own mailbox to send more.
            </p>
          )}
          {canManage && (
            <Button className="w-full" disabled={save.isPending} onClick={() => save.mutate(identity)}>
              {save.isPending && <Spinner />} Save sender details
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Choice({ active, title, text, badge, note, disabled, onPick }: { active: boolean; title: string; text: string; badge: string; note?: string; disabled: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} disabled={disabled || active}
      className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50 disabled:opacity-60'}`}>
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {active ? <CheckCircle2 className="size-4 text-primary" /> : <Badge variant="outline" className="font-normal">{badge}</Badge>}
      </span>
      <span className="text-xs text-muted-foreground">{text}</span>
      {note && !active && <span className="text-xs text-amber-700">{note}</span>}
    </button>
  )
}

function MailboxForm({ settings, canManage, onDone }: { settings: EmailSettings; canManage: boolean; onDone: () => void }) {
  const saved = settings.smtp_saved
  const presetOf = (host: string) => PRESETS.find((p) => p.host && p.host === host)?.id ?? (host ? 'other' : 'gmail')
  const [preset, setPreset] = useState<string>(presetOf(settings.smtp.host))
  const [form, setForm] = useState<MailboxInput>({
    host: settings.smtp.host || 'smtp.gmail.com', port: settings.smtp.port || 465, security: settings.smtp.security || 'ssl',
    username: settings.smtp.username, password: '', from_email: settings.smtp.from_email,
  })
  const [editing, setEditing] = useState(!saved)
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[0]
  const connect = useMutation({
    mutationFn: () => connectMailbox({ ...form, password: form.password || undefined, from_email: form.from_email || form.username }),
    onSuccess: (r) => {
      toast.success(`Connected. A test email went to ${r.sent_to}.`)
      setEditing(false)
      setForm((f) => ({ ...f, password: '' }))
      onDone()
    },
  })
  const disconnect = useMutation({
    mutationFn: disconnectMailbox,
    onSuccess: () => { toast.success('Mailbox disconnected'); setEditing(true); onDone() },
  })
  const pick = (id: string) => {
    setPreset(id)
    const next = PRESETS.find((x) => x.id === id)!
    setForm((f) => ({ ...f, host: next.host || (f.host && presetOf(f.host) === 'other' ? f.host : ''), port: next.port, security: next.security }))
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Mail className="size-4" /> Your own mailbox</CardTitle>
          <CardDescription>
            {saved ? <>Connected: <span className="font-medium text-foreground">{settings.smtp.from_email}</span> through {settings.smtp.host}{settings.connected_at ? ` · ${formatDateTime(settings.connected_at)}` : ''}</>
              : 'Sign in with the mailbox your emails should come from. We send you a test email to check it works.'}
          </CardDescription>
        </div>
        {saved && canManage && !editing && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change</Button>
            <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}><Unplug /> Disconnect</Button>
          </div>
        )}
      </CardHeader>
      {editing && canManage && (
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Email provider</Label>
              <Select value={preset} onValueChange={pick}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PRESETS.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {p.help} {p.link && <a href={p.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline">Open <ExternalLink className="size-3" /></a>}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_user">Email address (username)</Label>
              <Input id="smtp_user" type="email" autoComplete="off" value={form.username} placeholder="orders@yourstore.com"
                onChange={(e) => setForm({ ...form, username: e.target.value, from_email: form.from_email === form.username ? e.target.value : form.from_email })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_pass">{preset === 'gmail' || preset === 'yahoo' || preset === 'zoho' ? 'App password' : 'Password'}</Label>
              <Input id="smtp_pass" type="password" autoComplete="new-password" value={form.password} placeholder={saved ? 'Unchanged' : ''}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_from">Send from</Label>
              <Input id="smtp_from" type="email" value={form.from_email} placeholder={form.username || 'orders@yourstore.com'} onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
            </div>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp_host">Mail server</Label>
                <Input id="smtp_host" value={form.host} placeholder="mail.yourdomain.com" disabled={preset !== 'other'} onChange={(e) => setForm({ ...form, host: e.target.value.trim() })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp_port">Port</Label>
                <Select value={String(form.port)} onValueChange={(v) => setForm({ ...form, port: Number(v), security: v === '587' || v === '2525' || v === '2587' ? 'starttls' : 'ssl' })} disabled={preset !== 'other'}>
                  <SelectTrigger id="smtp_port"><SelectValue /></SelectTrigger>
                  <SelectContent>{[465, 2465, 587, 2525, 2587].map((x) => <SelectItem key={x} value={String(x)}>{x}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </div>
          {form.port === 587 && <p className="text-xs text-amber-700">Port 587 is often blocked for sending servers: use 465 (SSL) if the test fails.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {saved && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            <Button disabled={connect.isPending || !form.username || !form.host || (!saved && !form.password)} onClick={() => connect.mutate()}>
              {connect.isPending ? <Spinner /> : <Send />} Connect and send a test email
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime, titleCase } from '@/lib/format'
import { listNotificationLogs, listNotificationTemplates, retryNotification, updateNotificationTemplate } from '@/services/settings'
import { SelectSetting, SettingCard, SwitchSetting, useSettingDraft } from './setting-form'

const PROVIDERS = [
  { value: 'console', label: 'Log only (testing)', secrets: [] },
  { value: 'webhook', label: 'Webhook (your own service / WhatsApp BSP)', secrets: ['NOTIFY_WEBHOOK_URL', 'NOTIFY_WEBHOOK_SECRET'] },
  { value: 'resend', label: 'Resend (email)', secrets: ['RESEND_API_KEY', 'EMAIL_FROM'] },
]
const VARIABLES = ['customer_name', 'customer_first_name', 'order_number', 'total', 'cod_amount', 'due_amount', 'advance_amount', 'payment_amount', 'courier_name', 'tracking_number', 'tracking_url', 'track_order_url', 'store_name', 'store_phone']
const STATUS_VARIANT = { QUEUED: 'info', SENDING: 'info', SENT: 'success', FAILED: 'danger', SKIPPED: 'neutral' } as const

export function NotificationSettings() {
  return (
    <div className="grid gap-4">
      <Channels />
      <Templates />
      <Logs />
    </div>
  )
}

function Channels() {
  const s = useSettingDraft('notifications')
  return (
    <SettingCard setting={s} title="Channels"
      description="WhatsApp and email messages are queued in the database and sent by the notifications-dispatch function with retries. Provider credentials are Edge Function secrets.">
      <SwitchSetting s={s} path={['enabled']} label="Send customer notifications" />
      <p className="text-sm text-muted-foreground">
        SMS has its own page — provider, automations, delivery and costs: <Link to="/admin/sms" className="font-medium text-foreground underline-offset-4 hover:underline">SMS</Link>.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {(['whatsapp', 'email'] as const).map((ch) => {
          const provider = PROVIDERS.find((p) => p.value === s.get(['channels', ch, 'provider']))
          return (
            <div key={ch} className="grid gap-3 rounded-lg border p-3">
              <SwitchSetting s={s} path={['channels', ch, 'enabled']} label={titleCase(ch)} />
              <SelectSetting s={s} path={['channels', ch, 'provider']} label="Provider"
                options={PROVIDERS.filter((p) => ch === 'email' || p.value !== 'resend').map(({ value, label }) => ({ value, label }))} />
              {provider && provider.secrets.length > 0 && (
                <p className="text-xs text-muted-foreground">Secrets: {provider.secrets.map((x) => <code key={x} className="mr-1">{x}</code>)}</p>
              )}
            </div>
          )
        })}
      </div>
    </SettingCard>
  )
}

function Templates() {
  const templates = useQuery({ queryKey: ['notification-templates'], queryFn: listNotificationTemplates })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Message templates</CardTitle>
        <CardDescription>Variables: {VARIABLES.map((v) => <code key={v} className="mr-1.5 text-xs">{`{{${v}}}`}</code>)}</CardDescription>
      </CardHeader>
      <CardContent>
        {templates.isLoading ? <LoadingState /> : (
          <div className="grid gap-3">
            {(templates.data ?? []).map((t) => <TemplateRow key={t.id} template={t} />)}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type Template = Awaited<ReturnType<typeof listNotificationTemplates>>[number]

function TemplateRow({ template }: { template: Template }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [subject, setSubject] = useState(template.subject ?? '')
  const [body, setBody] = useState(template.template)
  useEffect(() => { setSubject(template.subject ?? ''); setBody(template.template) }, [template])
  const dirty = body !== template.template || subject !== (template.subject ?? '')
  const save = useMutation({
    mutationFn: (values: { is_enabled?: boolean; subject?: string | null; template?: string }) => updateNotificationTemplate(template.id, values),
    onSuccess: () => { toast.success('Template saved'); void queryClient.invalidateQueries({ queryKey: ['notification-templates'] }) },
  })
  const editable = can('settings.manage')
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{titleCase(template.event)} <Badge variant="outline">{titleCase(template.channel)}</Badge></p>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={template.is_enabled} disabled={!editable || save.isPending} onCheckedChange={(v) => save.mutate({ is_enabled: v })} /> {template.is_enabled ? 'On' : 'Off'}
        </label>
      </div>
      {template.channel === 'EMAIL' && <Input aria-label="Subject" value={subject} disabled={!editable} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />}
      <Textarea aria-label="Message" rows={2} value={body} disabled={!editable} onChange={(e) => setBody(e.target.value)} />
      {dirty && editable && (
        <Button size="sm" className="w-fit" disabled={!body.trim() || save.isPending}
          onClick={() => save.mutate({ template: body, subject: template.channel === 'EMAIL' ? subject || null : template.subject })}>
          {save.isPending ? <Spinner /> : <Save />} Save template
        </Button>
      )}
    </div>
  )
}

function Logs() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const logs = useQuery({ queryKey: ['notification-logs'], queryFn: () => listNotificationLogs(100) })
  const retry = useMutation({
    mutationFn: retryNotification,
    onSuccess: () => { toast.success('Queued for another attempt'); void queryClient.invalidateQueries({ queryKey: ['notification-logs'] }) },
  })
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Recent messages</CardTitle>
        <CardDescription>Last 100 notifications and their delivery status.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {logs.isLoading ? <LoadingState /> : !logs.data?.length ? <EmptyState title="No messages yet" /> : (
          <div className="max-h-[32rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">When</TableHead><TableHead>Event</TableHead><TableHead>To</TableHead>
                  <TableHead>Order</TableHead><TableHead>Status</TableHead><TableHead className="pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.data.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="pl-6 text-xs whitespace-nowrap">{formatDateTime(l.created_at)}</TableCell>
                    <TableCell className="text-xs">{titleCase(l.event ?? 'test')} · {l.channel}</TableCell>
                    <TableCell className="font-mono text-xs">{l.recipient}</TableCell>
                    <TableCell className="text-xs">{l.orders ? <Link to={`/admin/orders/${l.order_id}`} className="hover:underline">{l.orders.order_number}</Link> : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[l.status]}>{l.status.toLowerCase()}</Badge>
                      {l.attempts > 1 && <span className="ml-1 text-xs text-muted-foreground">×{l.attempts}</span>}
                      {l.error && <p className="max-w-56 truncate text-xs text-red-600" title={l.error}>{l.error}</p>}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {l.status === 'FAILED' && can('settings.manage') && (
                        <Button size="icon-sm" variant="ghost" aria-label="Retry" disabled={retry.isPending} onClick={() => retry.mutate(l.id)}><RefreshCw /></Button>
                      )}
                    </TableCell>
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

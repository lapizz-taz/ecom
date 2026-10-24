import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { PlatformIcon } from '@/features/inbox/ui'
import { ChannelNumbers, SetupChecklist, type SetupStep, WHATSAPP_FIGURES } from '@/features/messaging/channel-overview'
import { MessageGroups } from '@/features/messaging/message-list'
import { MessageLogTab } from '@/features/messaging/message-log'
import { Notice } from '@/features/messaging/notice'
import { pricePerMessage, whatsappCategory } from '@/features/messaging/whatsapp-cost'
import { WhatsappCosts } from '@/features/messaging/whatsapp-costs'
import { WhatsappStatusBadge } from '@/features/messaging/whatsapp-status'
import { useUrlState } from '@/hooks/use-url-state'
import { toast } from '@/lib/toast'
import { channelStats, listMessages, saveWhatsappSettings, syncWhatsapp, whatsappSettings, type WhatsappSettings } from '@/services/messaging'

const numberLabel = (n: WhatsappSettings['numbers'][number]) => [n.name, n.display_phone].filter(Boolean).join(' · ') || 'WhatsApp number'

/** WhatsApp module: order updates as WhatsApp messages Meta approved, sent from the store's own number. */
export default function WhatsappPage() {
  const { can } = useAuth()
  const manage = can('notifications.manage')
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'messages' })
  const settings = useQuery({ queryKey: ['whatsapp-settings'], queryFn: whatsappSettings })
  const messages = useQuery({ queryKey: ['customer-messages', 'WHATSAPP'], queryFn: () => listMessages('WHATSAPP') })
  const stats = useQuery({ queryKey: ['messaging-stats', 'WHATSAPP'], queryFn: () => channelStats('WHATSAPP'), staleTime: 60_000 })
  const save = useMutation({
    mutationFn: (p: Parameters<typeof saveWhatsappSettings>[0]) => saveWhatsappSettings(p),
    onSuccess: (s, p) => {
      toast.success('enabled' in p ? (s.enabled ? 'WhatsApp messages are on' : 'WhatsApp messages are off')
        : 'sms_fallback' in p ? (s.sms_fallback ? 'Undelivered WhatsApp messages go by SMS' : 'No SMS instead of WhatsApp') : 'Saved')
      queryClient.setQueryData(['whatsapp-settings'], s)
    },
  })
  const sync = useMutation({
    mutationFn: syncWhatsapp,
    onSuccess: (r) => {
      toast.success(r.updated ? `Checked ${r.updated} message${r.updated === 1 ? '' : 's'} with Meta` : 'Nothing submitted to Meta yet')
      void queryClient.invalidateQueries({ queryKey: ['customer-messages', 'WHATSAPP'] })
    },
  })
  const s = settings.data
  const number = s?.numbers.find((n) => n.id === s.channel_id)
  const all = messages.data ?? []
  const approved = all.filter((m) => m.wa_status === 'APPROVED').length
  const sending = all.some((m) => m.is_enabled && m.wa_status === 'APPROVED')
  // Meta stopped accepting the number's access token (expired or revoked): nothing goes out until it is reconnected.
  const needsReconnect = number?.status === 'FAILED'
  const steps: SetupStep[] = s ? [
    {
      title: 'Connect your WhatsApp Business number', done: s.numbers.some((n) => n.status === 'OK'),
      text: needsReconnect ? 'Meta no longer accepts this number’s access token: reconnect it in Messaging → Channels.'
        : 'In Messaging → Channels. The same number answers chats in the Inbox.',
      action: <Button size="sm" variant="outline" asChild><Link to="/admin/inbox/channels">{needsReconnect ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}</Link></Button>,
    },
    {
      title: 'Choose the number messages come from', done: s.ready,
      text: number ? numberLabel(number) : 'And the language Meta should check the texts in.',
      action: s.numbers.length > 0 && <Button size="sm" variant="outline" onClick={() => update({ tab: 'setup' })}>Choose number</Button>,
    },
    {
      title: 'Get your messages approved by Meta', done: approved > 0,
      text: `${approved} of ${all.length} approved. Open a message and press Submit to Meta; Meta usually answers within minutes.`,
      action: s.ready && <Button size="sm" variant="outline" onClick={() => update({ tab: 'messages' })}>Open messages</Button>,
    },
    {
      title: 'Add a payment method in Meta', done: null,
      text: <>Meta Business Suite → Settings → WhatsApp accounts → Payment settings. Meta bills your card for delivered messages (about {pricePerMessage('UTILITY')} for an order update).</>,
      action: <Button size="sm" variant="ghost" onClick={() => update({ tab: 'setup' })}>What it costs</Button>,
    },
    {
      title: 'Send yourself a test', done: !!stats.data?.tested,
      text: 'Open an approved message and send it to your own phone.',
    },
    {
      title: 'Switch on WhatsApp messages', done: s.enabled,
      text: 'Approved messages that are switched on go out when an order reaches their step.',
      action: manage && s.ready && approved > 0 && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ enabled: true })}>Switch on</Button>,
    },
  ] : []
  const live = !!s && s.ready && s.enabled && sending && !needsReconnect

  return (
    <div className="space-y-4">
      <PageHeader title="WhatsApp" icon={<PlatformIcon platform="WHATSAPP" className="size-4" />}
        description="Send order confirmations, shipping updates and payment alerts over WhatsApp, from your own business number."
        actions={s && (
          <>
            {manage && number && (
              <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
                {sync.isPending ? <Spinner /> : <RefreshCw />} Refresh from Meta
              </Button>
            )}
            <label className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm font-medium">
              Send WhatsApp messages
              <Switch checked={s.enabled} disabled={!manage || save.isPending || (!s.enabled && !s.ready)} onCheckedChange={(on) => save.mutate({ enabled: on })} />
            </label>
          </>
        )} />

      {settings.isLoading ? <LoadingState /> : settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : s && (
        <>
          {needsReconnect && (
            <Notice tone="warn"
              text={`${numberLabel(number)} needs reconnecting: Meta no longer accepts its access token, so no WhatsApp message can go out${s.sms_fallback ? ' (the same updates go by SMS instead)' : ''}.`}
              action={<Button size="sm" asChild><Link to="/admin/inbox/channels">Reconnect</Link></Button>} />
          )}
          {messages.isLoading ? null : live ? (
            <Notice tone="ok" text={`On. Messages Meta approved (${approved}) go out from ${number ? numberLabel(number) : 'your number'} when an order reaches their step.`} />
          ) : (
            <SetupChecklist title="Set up WhatsApp messages" steps={steps} />
          )}
          {(live || !!stats.data?.sent) && <ChannelNumbers stats={stats.data} loading={stats.isLoading} figures={WHATSAPP_FIGURES} />}

          <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
            <TabsList>
              <TabsTrigger value="messages">Messages</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="messages" className="space-y-3">
              {messages.isLoading ? <LoadingState /> : messages.error ? <ErrorState error={messages.error} onRetry={() => messages.refetch()} />
                : <MessageGroups channel="WHATSAPP" messages={messages.data ?? []} canManage={manage} basePath="/admin/whatsapp" sent={stats.data}
                    status={(m) => (
                      <>
                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline" title="Meta's price per delivered message (Bangladesh)">
                          ~{pricePerMessage(whatsappCategory(m.event))}
                        </span>
                        <WhatsappStatusBadge message={m} />
                      </>
                    )} />}
              <p className="text-xs text-muted-foreground">
                WhatsApp lets a business message customers first only with texts Meta approved. A message goes out when it is switched on and approved.
                Any message can still be sent by hand from an order with <span className="font-medium text-foreground">Send on WhatsApp</span>.
              </p>
            </TabsContent>
            <TabsContent value="setup" className="space-y-4">
              <Setup settings={s} canManage={manage} saving={save.isPending} onSave={(p) => save.mutate(p)} />
              <WhatsappCosts />
            </TabsContent>
            <TabsContent value="activity"><MessageLogTab channel="WHATSAPP" /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

function Setup({ settings, canManage, saving, onSave }: {
  settings: WhatsappSettings; canManage: boolean; saving: boolean
  onSave: (p: Parameters<typeof saveWhatsappSettings>[0]) => void
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending number</CardTitle>
          <CardDescription>Messages come from a WhatsApp Business number connected in Messaging → Channels.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings.numbers.length ? (
            <div className="space-y-1.5">
              <Label>Number</Label>
              <Select value={settings.channel_id ?? ''} disabled={!canManage || saving} onValueChange={(v) => onSave({ channel_id: v })}>
                <SelectTrigger><SelectValue placeholder="Choose a number" /></SelectTrigger>
                <SelectContent>
                  {settings.numbers.map((n) => (
                    <SelectItem key={n.id} value={n.id} disabled={!n.waba_id || n.status === 'DISCONNECTED'}>
                      {numberLabel(n)}{!n.waba_id ? ' (reconnect it to send templates)' : n.status === 'DISCONNECTED' ? ' (disconnected)' : n.status === 'FAILED' ? ' (needs reconnecting)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No WhatsApp number is connected yet.</p>
          )}
          <Button variant="outline" size="sm" asChild><Link to="/admin/inbox/channels"><ExternalLink /> Messaging channels</Link></Button>

          <div className="space-y-1.5">
            <Label>Message language</Label>
            <Select value={settings.language} disabled={!canManage || saving} onValueChange={(v) => onSave({ language: v as WhatsappSettings['language'] })}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="bn">Bangla (বাংলা)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Meta checks that the text is in this language. Change it before you submit; messages already approved keep theirs.
              To switch every customer message to Bangla or English at once, use Settings → Customer messages.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border p-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Send an SMS when WhatsApp can’t</span>
              <span className="block text-xs text-muted-foreground">
                When a WhatsApp message is not approved yet, fails, or the number is not on WhatsApp, the same update goes as the
                event’s SMS text instead (SMS → Automations, from your SMS balance), so the customer still hears from you. Needs SMS switched on.
              </span>
            </span>
            <Switch checked={settings.sms_fallback} disabled={!canManage || saving} onCheckedChange={(on) => onSave({ sms_fallback: on })}
              aria-label="Send an SMS when WhatsApp can't" />
          </label>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground marker:text-foreground">
            <li>Choose the number and language here.</li>
            <li>Open a message, adjust the words, and press <span className="font-medium text-foreground">Submit to Meta</span>. Meta usually answers within minutes, at most a day.</li>
            <li>Once approved, switch the message on, and switch WhatsApp messages on at the top.</li>
          </ol>
          <p className="mt-3 rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
            Meta charges your WhatsApp Business account for each delivered message (about {pricePerMessage('UTILITY')} for an order update);
            Fullfilio adds no charge. Prices and how charging starts are below.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

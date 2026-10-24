import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { ChannelNumbers, EMAIL_FIGURES, SetupChecklist, type SetupStep } from '@/features/messaging/channel-overview'
import { EmailDesign } from '@/features/messaging/email-design'
import { EmailSender } from '@/features/messaging/email-sender'
import { MessageGroups } from '@/features/messaging/message-list'
import { MessageLogTab } from '@/features/messaging/message-log'
import { Notice } from '@/features/messaging/notice'
import { useUrlState } from '@/hooks/use-url-state'
import { toast } from '@/lib/toast'
import { channelStats, emailSettings, type EmailSettings, listMessages, saveEmailSettings } from '@/services/messaging'

const SENT_FROM: Record<EmailSettings['provider'], string> = { smtp: 'your mailbox', fullfilio: 'Fullfilio\'s email service', none: '' }

/** Email module: which emails customers get, how they look, where they come from, and what was sent. */
export default function EmailPage() {
  const { can } = useAuth()
  const manage = can('notifications.manage')
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'notifications' })
  const settings = useQuery({ queryKey: ['email-settings'], queryFn: emailSettings })
  const messages = useQuery({ queryKey: ['customer-messages', 'EMAIL'], queryFn: () => listMessages('EMAIL') })
  const stats = useQuery({ queryKey: ['messaging-stats', 'EMAIL'], queryFn: () => channelStats('EMAIL'), staleTime: 60_000 })
  const power = useMutation({
    mutationFn: (enabled: boolean) => saveEmailSettings({ enabled }),
    onSuccess: (s) => {
      toast.success(s.enabled ? 'Customer emails are on' : 'Customer emails are off')
      queryClient.setQueryData(['email-settings'], s)
    },
  })
  const s = settings.data
  const anyOn = (messages.data ?? []).some((m) => m.is_enabled)
  const confirmation = messages.data?.find((m) => m.event === 'ORDER_CREATED')
  const steps: SetupStep[] = s ? [
    {
      title: 'Choose how emails are sent', done: s.ready,
      text: 'Connect your own mailbox (Gmail, Zoho, your hosting) or use Fullfilio’s email service.',
      action: <Button size="sm" variant="outline" onClick={() => update({ tab: 'sender' })}>Set up sending</Button>,
    },
    {
      title: 'Add your logo and colour', done: !!s.design.logo_url, optional: true,
      text: 'Every email shows them at the top and on its buttons.',
      action: <Button size="sm" variant="outline" onClick={() => update({ tab: 'design' })}>Design</Button>,
    },
    {
      title: 'Send yourself a test', done: !!stats.data?.tested,
      text: 'Open an email and press Send test: it goes to your own address, so you see it as customers will.',
      action: confirmation && <Button size="sm" variant="outline" asChild><Link to={`/admin/email/${confirmation.id}`}>Open order confirmation</Link></Button>,
    },
    {
      title: 'Choose the emails customers get', done: anyOn,
      text: 'Switch on the order confirmation, shipping updates and any others you want.',
      action: <Button size="sm" variant="outline" onClick={() => update({ tab: 'notifications' })}>Choose emails</Button>,
    },
    {
      title: 'Switch on customer emails', done: s.enabled,
      text: 'Nothing goes out until this is on (the switch at the top of the page).',
      action: manage && s.ready && <Button size="sm" disabled={power.isPending} onClick={() => power.mutate(true)}>Switch on</Button>,
    },
  ] : []
  const live = !!s && s.ready && s.enabled && anyOn

  return (
    <div className="space-y-4">
      <PageHeader title="Email" icon={<Mail />}
        description="Order confirmations, shipping updates and payment emails, sent to customers who give their email address. Change any email's words and code, like Shopify."
        actions={s && (
          <label className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm font-medium">
            Send customer emails
            <Switch checked={s.enabled} disabled={!manage || power.isPending || (!s.enabled && !s.ready)} onCheckedChange={(on) => power.mutate(on)} />
          </label>
        )} />

      {settings.isLoading ? <LoadingState /> : settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : s && (
        <>
          {messages.isLoading ? null : live ? (
            <Notice tone="ok" text={`On. Emails go out from ${s.provider === 'smtp' ? s.smtp.from_email : s.service.from_email ?? SENT_FROM.fullfilio} when an order reaches each step below that is switched on.`} />
          ) : (
            <SetupChecklist title={s.ready && !s.enabled ? `Ready to send from ${SENT_FROM[s.provider]}: a few steps left` : 'Set up customer emails'} steps={steps} />
          )}
          {(live || !!stats.data?.sent) && <ChannelNumbers stats={stats.data} loading={stats.isLoading} figures={EMAIL_FIGURES} />}

          <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
            <TabsList>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="sender">Sending</TabsTrigger>
              <TabsTrigger value="design">Design</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="notifications" className="space-y-3">
              {messages.isLoading ? <LoadingState /> : messages.error ? <ErrorState error={messages.error} onRetry={() => messages.refetch()} />
                : <MessageGroups channel="EMAIL" messages={messages.data ?? []} canManage={manage} basePath="/admin/email" sent={stats.data} />}
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>Emails go only to customers who gave an email address at checkout or on their order.</li>
                <li>
                  Cart reminders and review requests have an <span className="font-medium text-foreground">Unsubscribe</span> link, and Gmail and
                  other mail apps show their own unsubscribe button. A customer who unsubscribes still gets emails about their orders.
                </li>
                <li>Links for customers (confirm an order, unsubscribe) open on your online store’s address when you use Fullfilio’s store.</li>
              </ul>
            </TabsContent>
            <TabsContent value="sender"><EmailSender settings={s} canManage={manage} /></TabsContent>
            <TabsContent value="design"><EmailDesign settings={s} canManage={manage} /></TabsContent>
            <TabsContent value="activity"><MessageLogTab channel="EMAIL" /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

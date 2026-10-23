import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { EmailDesign } from '@/features/messaging/email-design'
import { EmailSender } from '@/features/messaging/email-sender'
import { MessageGroups } from '@/features/messaging/message-list'
import { MessageLogTab } from '@/features/messaging/message-log'
import { Notice } from '@/features/messaging/notice'
import { useUrlState } from '@/hooks/use-url-state'
import { toast } from '@/lib/toast'
import { emailSettings, type EmailSettings, listMessages, saveEmailSettings } from '@/services/messaging'

const SENT_FROM: Record<EmailSettings['provider'], string> = { smtp: 'your mailbox', fullfilio: 'Fullfilio\'s email service', none: '' }

/** Email module: which emails customers get, how they look, where they come from, and what was sent. */
export default function EmailPage() {
  const { can } = useAuth()
  const manage = can('notifications.manage')
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'notifications' })
  const settings = useQuery({ queryKey: ['email-settings'], queryFn: emailSettings })
  const messages = useQuery({ queryKey: ['customer-messages', 'EMAIL'], queryFn: () => listMessages('EMAIL') })
  const power = useMutation({
    mutationFn: (enabled: boolean) => saveEmailSettings({ enabled }),
    onSuccess: (s) => {
      toast.success(s.enabled ? 'Customer emails are on' : 'Customer emails are off')
      queryClient.setQueryData(['email-settings'], s)
    },
  })
  const s = settings.data

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
          {!s.ready ? (
            <Notice tone="warn" text="Choose where your emails come from: connect your own mailbox (Gmail, Zoho, your hosting) or use Fullfilio's email service."
              action={state.tab !== 'sender' && <Button size="sm" onClick={() => update({ tab: 'sender' })}>Set up sending</Button>} />
          ) : !s.enabled ? (
            <Notice tone="warn" text={`Ready to send from ${SENT_FROM[s.provider]}, but customer emails are off. Switch them on above when the emails look right.`} />
          ) : (
            <Notice tone="ok" text={`On. Emails go out from ${s.provider === 'smtp' ? s.smtp.from_email : s.service.from_email ?? SENT_FROM.fullfilio} when an order reaches each step below that is switched on.`} />
          )}

          <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
            <TabsList>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="sender">Sending</TabsTrigger>
              <TabsTrigger value="design">Design</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="notifications" className="space-y-3">
              {messages.isLoading ? <LoadingState /> : messages.error ? <ErrorState error={messages.error} onRetry={() => messages.refetch()} />
                : <MessageGroups channel="EMAIL" messages={messages.data ?? []} canManage={manage} basePath="/admin/email" />}
              <p className="text-xs text-muted-foreground">Emails go only to customers who gave an email address at checkout or on their order.</p>
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

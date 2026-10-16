import { MessageSquare } from 'lucide-react'
import { ComingSoon } from '@/components/common/coming-soon'
import { PageHeader } from '@/components/common/page-header'
import { LoadingState } from '@/components/common/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useMerchantFeatures } from '@/features/billing/use-features'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { SmsAutomationsTab } from '@/features/sms/sms-automations'
import { SmsMessagesTab } from '@/features/sms/sms-messages'
import { SmsOverviewTab } from '@/features/sms/sms-overview'
import { useUrlState } from '@/hooks/use-url-state'

export default function SmsPage() {
  const { can } = useAuth()
  const { isOff, loading } = useMerchantFeatures()
  const [state, update] = useUrlState({ tab: 'overview' })
  return (
    <div className="space-y-4">
      {can('inbox.view') && <MessagingTabs />}
      <PageHeader title="SMS" description="Text customers automatically as their order moves along. Every message and its cost is logged; costs go to Finance." />
      {loading ? <LoadingState /> : isOff('sms') ? (
        // Super Admin → Features & Access has SMS switched off (for everyone or this business).
        <ComingSoon icon={<MessageSquare />} title="SMS is coming soon" description="Order updates by text message will open here for your business soon. Messenger, Instagram and WhatsApp work in the Inbox meanwhile." />
      ) : (
        <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="automations">Automations</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><SmsOverviewTab /></TabsContent>
          <TabsContent value="automations"><SmsAutomationsTab /></TabsContent>
          <TabsContent value="messages"><SmsMessagesTab /></TabsContent>
        </Tabs>
      )}
    </div>
  )
}

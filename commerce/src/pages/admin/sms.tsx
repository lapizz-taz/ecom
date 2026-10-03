import { PageHeader } from '@/components/common/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SmsAutomationsTab } from '@/features/sms/sms-automations'
import { SmsMessagesTab } from '@/features/sms/sms-messages'
import { SmsOverviewTab } from '@/features/sms/sms-overview'
import { useUrlState } from '@/hooks/use-url-state'

export default function SmsPage() {
  const [state, update] = useUrlState({ tab: 'overview' })
  return (
    <div className="space-y-4">
      <PageHeader title="SMS" description="Text customers automatically as their order moves along. Every message and its cost is logged; costs go to Finance." />
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
    </div>
  )
}

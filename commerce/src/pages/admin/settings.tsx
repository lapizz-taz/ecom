import { PageHeader } from '@/components/common/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { DeliverySettings } from '@/features/settings/delivery-settings'
import { FinanceCategories } from '@/features/settings/finance-categories'
import { FraudSettings } from '@/features/settings/fraud-settings'
import { LabelBuilder } from '@/features/settings/label-builder'
import { NotificationSettings } from '@/features/settings/notification-settings'
import { OperationsSettings } from '@/features/settings/operations-settings'
import { PaymentSettings } from '@/features/settings/payment-settings'
import { StoreSettings } from '@/features/settings/store-settings'
import { useUrlState } from '@/hooks/use-url-state'

const TABS = [
  { key: 'store', label: 'Store', render: () => <StoreSettings /> },
  { key: 'delivery', label: 'Delivery', render: () => <DeliverySettings /> },
  { key: 'payments', label: 'Payments', render: () => <PaymentSettings /> },
  { key: 'fraud', label: 'Fraud & advance', render: () => <FraudSettings /> },
  { key: 'operations', label: 'Orders & operations', render: () => <OperationsSettings /> },
  { key: 'labels', label: 'Label builder', render: () => <LabelBuilder /> },
  { key: 'notifications', label: 'Notifications', render: () => <NotificationSettings /> },
  { key: 'finance', label: 'Finance categories', permission: 'finance.view', render: () => <FinanceCategories /> },
]

export default function SettingsPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({ tab: 'store' })
  const tabs = TABS.filter((t) => !t.permission || can(t.permission))
  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        description={can('settings.manage')
          ? 'Changes apply immediately to checkout, fraud checks and automation. Every change is recorded in the audit log.'
          : 'You can view settings but not change them.'}
      />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
          <TabsList>{tabs.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}</TabsList>
        </div>
        {tabs.map((t) => <TabsContent key={t.key} value={t.key} className="pt-2">{t.render()}</TabsContent>)}
      </Tabs>
    </div>
  )
}

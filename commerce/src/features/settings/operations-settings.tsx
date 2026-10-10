import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Layers } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { autoMergeScan, listReviewStatuses } from '@/services/orders'
import { CallStatusesSettings } from './call-statuses'
import { NumberSetting, SelectSetting, SettingCard, type SettingDraft, SwitchSetting, useSettingDraft } from './setting-form'

export function OperationsSettings() {
  const orders = useSettingDraft('orders')
  const inventory = useSettingDraft('inventory')
  const customers = useSettingDraft('customers')
  const production = useSettingDraft('production')
  const finance = useSettingDraft('finance')
  const fulfillment = useSettingDraft('fulfillment')

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SettingCard setting={orders} title="Orders">
        <SwitchSetting s={orders} path={['require_confirmation']} label="Approve web orders by hand" hint="On: orders that pass the risk check wait in Web Orders until someone calls and approves them. Off: they are approved automatically." />
        <SwitchSetting s={orders} path={['require_confirmation_after_advance']} label="Still call after an advance is paid" />
        <SwitchSetting s={orders} path={['require_courier_before_ship']} label="Require a courier before marking shipped" />
        <SwitchSetting s={orders} path={['track_carts']} label="Track carts on the store (abandoned carts)"
          hint="The store keeps a copy of each visitor's cart so carts left behind show in Web Orders → Abandoned Carts" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={orders} path={['advance_payment_timeout_hours']} label="Advance payment window (hours)" min={1} hint="Unpaid advance orders are cancelled after this" />
          <NumberSetting s={orders} path={['max_quantity_per_item']} label="Max quantity per item" min={1} />
          <NumberSetting s={orders} path={['abandoned_cart_minutes']} label="Cart counts as abandoned after (minutes)" min={5} max={10080} hint="No activity for this long" />
        </div>
      </SettingCard>

      <CallStatusesSettings />

      <SettingCard setting={orders} title="Repeat & duplicate orders"
        description="Customers often check out twice in a row. Repeat checkouts are merged into one parcel; other look-alike orders are flagged for you to merge or dismiss.">
        <SwitchSetting s={orders} path={['auto_merge_enabled']} label="Merge repeat checkouts automatically"
          hint="Same phone and address, placed within the window below, before the label is printed" />
        <SwitchSetting s={orders} path={['duplicate_check_enabled']} label="Flag possible duplicate orders" hint="Same phone number, or same address in the same district" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={orders} path={['auto_merge_minutes']} label="Merge window (minutes)" min={1} max={60} />
          <NumberSetting s={orders} path={['duplicate_window_hours']} label="Duplicate window (hours)" min={1} max={168} />
        </div>
        <div className="grid gap-3 rounded-lg border p-3">
          <SwitchSetting s={orders} path={['auto_merge_web_enabled']} label="Merge web orders from the same customer automatically"
            hint="Same phone number, same district, both still in Web Orders, nothing paid on the new one. Runs in the background — no pop-ups. Shopify / WooCommerce orders are flagged instead (they stay 1:1 with the store's order)." />
          <NumberSetting s={orders} path={['auto_merge_window_hours']} label="Merge orders placed up to this many hours apart" min={0.05} max={168} />
          <ReviewPriority s={orders} />
          <MergeNowButton />
        </div>
      </SettingCard>

      <SettingCard setting={fulfillment} title="Labels & scanning"
        description={<>Label size, what is printed and in what order: <Link to="/admin/label-builder" className="underline">Label builder</Link>.</>}>
        <SwitchSetting s={fulfillment} path={['require_label_before_rts']} label="Require a printed label before 'Ready to ship'"
          hint="The scanner refuses parcels whose label was never printed" />
      </SettingCard>

      <SettingCard setting={inventory} title="Inventory">
        <SwitchSetting s={inventory} path={['allow_overselling']} label="Allow selling when out of stock" hint="Off: checkout and order edits are refused when stock is not available" />
        <SwitchSetting s={inventory} path={['return_restock_default']} label="Restock returned items by default" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={inventory} path={['low_stock_threshold']} label="Default low-stock threshold" min={0} hint="Products can override this" />
          <SelectSetting s={inventory} path={['costing_method']} label="Cost when receiving stock" options={[
            { value: 'WEIGHTED_AVERAGE', label: 'Weighted average' }, { value: 'LATEST', label: 'Latest purchase price' },
          ]} />
        </div>
      </SettingCard>

      <SettingCard setting={customers} title="Customer segments" description="Segments update automatically as orders are delivered, cancelled or returned."
        validate={() => {
          const rate = Number(customers.get(['high_risk_bad_rate']))
          return rate > 0 && rate <= 1 ? null : 'High-risk rate must be between 0 and 1'
        }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={customers} path={['vip_min_spent']} label="VIP from total spent" min={0} />
          <NumberSetting s={customers} path={['vip_min_orders']} label="VIP from delivered orders" min={1} />
          <NumberSetting s={customers} path={['regular_min_orders']} label="Regular from delivered orders" min={1} />
          <NumberSetting s={customers} path={['high_risk_bad_rate']} label="High risk when bad-order share reaches" min={0} max={1} step={0.05} hint="0.5 = half of finished orders cancelled, failed or returned" />
        </div>
      </SettingCard>

      <SettingCard setting={production} title="Production">
        <SwitchSetting s={production} path={['enabled']} label="Use the production pipeline" />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectSetting s={production} path={['auto_create']} label="Create a production job when an order moves to processing" options={[
            { value: 'REQUIRED_ONLY', label: 'Only for made-to-order products' }, { value: 'ALL', label: 'For every order' }, { value: 'OFF', label: 'Never (create manually)' },
          ]} />
          <NumberSetting s={production} path={['default_deadline_days']} label="Default deadline (days)" min={0} />
        </div>
      </SettingCard>

      <SettingCard setting={finance} title="Finance automation" description="Entries posted automatically by the system; each one is idempotent and can be traced to its order.">
        <SwitchSetting s={finance} path={['record_courier_cost_on_delivery']} label="Record the courier charge as an expense on delivery" />
        <SwitchSetting s={finance} path={['auto_collect_cod_on_delivery']} label="Count COD as collected the moment an order is delivered"
          hint="Off (recommended): COD stays receivable until you record the courier's settlement" />
        <SwitchSetting s={finance} path={['post_ad_spend_to_expenses']} label="Post marketing ad spend to Advertising expenses" />
      </SettingCard>
    </div>
  )
}

const DEFAULT_PRIORITY = ['PROCESSING', 'FOLLOW_UP', 'GOOD_NO_RESPONSE', 'NO_RESPONSE']

/** Call statuses that may be merged, best first: the merged order takes the best one. */
function ReviewPriority({ s }: { s: SettingDraft }) {
  const statuses = useQuery({ queryKey: ['review-statuses'], queryFn: () => listReviewStatuses() })
  const list = (s.get(['merge_review_priority']) as string[] | undefined) ?? DEFAULT_PRIORITY
  const label = (code: string) => statuses.data?.find((x) => x.code === code)?.label ?? code
  const open = (statuses.data ?? []).filter((x) => !x.closes_order && !list.includes(x.code))
  const move = (i: number, d: number) => { const n = [...list]; [n[i], n[i + d]] = [n[i + d], n[i]]; s.set(['merge_review_priority'], n) }
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">Call status after merging <span className="font-normal text-muted-foreground">— best first</span></p>
      <ol className="grid gap-1">
        {list.map((code, i) => (
          <li key={code} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
            <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
            <span className="flex-1">{label(code)}</span>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!s.canEdit || i === 0} onClick={() => move(i, -1)} aria-label="Higher"><ArrowUp /></Button>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!s.canEdit || i === list.length - 1} onClick={() => move(i, 1)} aria-label="Lower"><ArrowDown /></Button>
            <Button type="button" size="sm" variant="ghost" disabled={!s.canEdit || list.length <= 1} onClick={() => s.set(['merge_review_priority'], list.filter((c) => c !== code))}>Remove</Button>
          </li>
        ))}
      </ol>
      {s.canEdit && open.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {open.map((x) => <Button key={x.code} type="button" size="sm" variant="outline" onClick={() => s.set(['merge_review_priority'], [...list, x.code])}>+ {x.label}</Button>)}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Orders in a status not listed here are never merged automatically. Example: Processing + Good but no response → Processing.</p>
    </div>
  )
}

function MergeNowButton() {
  const { can } = useAuth()
  const scan = useMutation({
    mutationFn: autoMergeScan,
    onSuccess: (r) => toast.success(r.merged ? `${r.merged} waiting order${r.merged === 1 ? '' : 's'} merged` : 'Nothing to merge'),
    onError: (e) => toast.error(toUserMessage(e)),
  })
  if (!can('orders.update')) return null
  return (
    <div>
      <Button type="button" size="sm" variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}><Layers /> Merge waiting web orders now</Button>
      <p className="mt-1 text-xs text-muted-foreground">Applies the saved rules to orders already in Web Orders.</p>
    </div>
  )
}

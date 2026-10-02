import { NumberSetting, SelectSetting, SettingCard, SwitchSetting, TextSetting, useSettingDraft } from './setting-form'

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
        <SwitchSetting s={orders} path={['require_confirmation']} label="Confirm every order by phone" hint="Orders that pass the fraud check wait in “Needs confirmation” instead of being confirmed automatically" />
        <SwitchSetting s={orders} path={['require_confirmation_after_advance']} label="Confirm by phone even after an advance is paid" />
        <SwitchSetting s={orders} path={['require_courier_before_ship']} label="Require a courier before marking shipped" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={orders} path={['advance_payment_timeout_hours']} label="Advance payment window (hours)" min={1} hint="Unpaid advance orders are cancelled after this" />
          <NumberSetting s={orders} path={['max_quantity_per_item']} label="Max quantity per item" min={1} />
        </div>
      </SettingCard>

      <SettingCard setting={orders} title="Repeat & duplicate orders"
        description="Customers often check out twice in a row. Repeat checkouts are merged into one parcel; other look-alike orders are flagged for you to merge or dismiss.">
        <SwitchSetting s={orders} path={['auto_merge_enabled']} label="Merge repeat checkouts automatically"
          hint="Same phone and address, placed within the window below, before the label is printed" />
        <SwitchSetting s={orders} path={['duplicate_check_enabled']} label="Flag possible duplicate orders" hint="Same phone number, or same address in the same district" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting s={orders} path={['auto_merge_minutes']} label="Merge window (minutes)" min={1} max={60} />
          <NumberSetting s={orders} path={['duplicate_window_hours']} label="Duplicate window (hours)" min={1} max={168} />
        </div>
      </SettingCard>

      <SettingCard setting={fulfillment} title="Labels & scanning">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectSetting s={fulfillment} path={['label_size']} label="Default label size" options={[
            { value: '100x150', label: '4 × 6 in (100 × 150 mm) thermal' }, { value: '75x100', label: '3 × 4 in (75 × 100 mm) thermal' },
            { value: 'A4', label: 'A4 — 4 labels per sheet' },
          ]} />
          <TextSetting s={fulfillment} path={['label_note']} label="Footer note on labels" placeholder="e.g. Please call before delivery" />
        </div>
        <SwitchSetting s={fulfillment} path={['show_cod_on_label']} label="Print the amount to collect (COD)" />
        <SwitchSetting s={fulfillment} path={['show_items_on_label']} label="Print the item list" />
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

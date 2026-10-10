import { ListSetting, SettingCard, TextareaSetting, TextSetting, useSettingDraft } from './setting-form'

export function StoreSettings() {
  const store = useSettingDraft('store')
  const storefront = useSettingDraft('storefront')
  const policies = useSettingDraft('policies')

  return (
    <div className="grid gap-4">
      <SettingCard setting={store} title="Business profile" description="Shown on the storefront, invoices and customer messages."
        validate={() => (/^[A-Z0-9]{1,8}$/.test(String(store.get(['order_prefix']) ?? '')) ? null : 'Order prefix must be 1–8 uppercase letters or digits')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextSetting s={store} path={['name']} label="Store name" />
          <TextSetting s={store} path={['tagline']} label="Tagline" />
          <TextSetting s={store} path={['email']} label="Email" />
          <TextSetting s={store} path={['phone']} label="Phone" />
          <TextSetting s={store} path={['whatsapp']} label="WhatsApp number" hint="Customers can confirm their order here with one tap after checkout" />
          <TextSetting s={store} path={['address']} label="Address" className="sm:col-span-2" />
          <TextSetting s={store} path={['website_url']} label="Website" placeholder="https://" />
          <TextSetting s={store} path={['logo_url']} label="Logo URL" nullable placeholder="https://" />
          <TextSetting s={store} path={['social', 'facebook']} label="Facebook page" placeholder="https://facebook.com/…" />
          <TextSetting s={store} path={['social', 'instagram']} label="Instagram" placeholder="https://instagram.com/…" />
        </div>
        <p className="text-xs text-muted-foreground">Currency, time zone, order numbers and phone rules are in <a className="underline" href="/admin/settings?tab=advanced">Advanced settings</a>.</p>
      </SettingCard>

      <SettingCard setting={store} title="Legal & invoice details" description="Printed on invoices when filled in. Public: anyone can see what you enter here.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextSetting s={store} path={['legal', 'business_name']} label="Registered business name" placeholder="Same as store name if empty" />
          <TextSetting s={store} path={['legal', 'business_type']} label="Business type" placeholder="Proprietorship, partnership, limited company…" />
          <TextSetting s={store} path={['legal', 'trade_license']} label="Trade licence no." mono />
          <TextSetting s={store} path={['legal', 'bin']} label="BIN / VAT registration" mono />
          <TextSetting s={store} path={['legal', 'dbid']} label="DBID (e-commerce ID)" mono />
          <TextSetting s={store} path={['legal', 'support_hours']} label="Support hours" placeholder="Sat–Thu, 10 am – 8 pm" />
        </div>
        <TextareaSetting s={store} path={['legal', 'invoice_footer']} label="Invoice footer note" rows={2} hint="e.g. exchange policy or thank-you line" />
      </SettingCard>

      <SettingCard setting={storefront} title="Storefront home page">
        <TextSetting s={storefront} path={['announcement']} label="Announcement bar" hint="Leave empty to hide" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextSetting s={storefront} path={['hero_title']} label="Hero title" />
          <TextSetting s={storefront} path={['hero_image_url']} label="Hero image URL" nullable />
          <TextSetting s={storefront} path={['hero_cta_label']} label="Button label" />
          <TextSetting s={storefront} path={['hero_cta_link']} label="Button link" mono />
        </div>
        <TextareaSetting s={storefront} path={['hero_subtitle']} label="Hero subtitle" rows={2} />
        <ListSetting s={storefront} path={['featured_category_slugs']} label="Featured collections" separator="comma" mono hint="Category handles, comma separated" />
        <TextareaSetting s={storefront} path={['footer_text']} label="Footer text" rows={2} />
      </SettingCard>

      <SettingCard setting={policies} title="Policies" description="Shown on the storefront policy pages.">
        <TextareaSetting s={policies} path={['shipping']} label="Shipping policy" />
        <TextareaSetting s={policies} path={['returns']} label="Return & refund policy" />
        <TextareaSetting s={policies} path={['privacy']} label="Privacy policy" />
        <TextareaSetting s={policies} path={['terms']} label="Terms" />
      </SettingCard>
    </div>
  )
}

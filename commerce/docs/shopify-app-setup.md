# Shopify app setup

This connects your Shopify store to the admin so that:

- Shopify orders are imported into **Web Orders**.
- Orders you mark **Shipped** are fulfilled on Shopify with the courier name, tracking number and tracking link. Shopify then sends its own shipping e-mail.
- Your stock (on hand − reserved) is kept in step with Shopify's *available* quantity.
- Shopify products can be imported into your products (with opening stock if you choose).
- Staff can **Mark paid** or **Cancel** an order on Shopify from the order page. Nothing on Shopify changes unless a person clicks.

You create one app for your store in Shopify's **Dev Dashboard**, then connect it under **Store → Sales Channels**. This takes about five minutes. The admin shows the same steps with copy buttons in the Shopify connect dialog.

> Since 1 January 2026 Shopify no longer lets merchants create new "custom apps" from *Settings → Apps → Develop apps*. Use the Dev Dashboard. A store that already has an older custom app with an Admin API access token can still connect with **Access token** instead.

---

## 1. Create the app

1. Go to <https://dev.shopify.com> and sign in as the **store owner** (or staff with the *Develop apps* permission). A Dev Dashboard app installs only on stores in its own organization, so a collaborator or agency account can't create it for you.
2. Click **Apps → Create app** and select **Start from Dev Dashboard**. Name it, for example `EcomDrive`.
3. Open the new app and select **Versions → Create version**. Fill in the settings below.

| Setting | Value |
|---|---|
| App URL (`application_url`) | `https://<your admin domain>/admin/channels`, e.g. `https://commerce-sage-eight-89.vercel.app/admin/channels` |
| Embed app in Shopify admin (`embedded`) | **Off** (`false`). The admin opens in its own tab; it does not run inside Shopify. |
| Redirect URLs | Only needed for **Approve on Shopify** (section 5B): `https://<your admin domain>/oauth/shopify/callback` |
| Webhooks API version | `2026-07` |
| Scopes | see the next section |

Set **embedded to false**. The admin refuses to be framed by other sites, so an embedded app would show a blank page inside Shopify.

### "The redirect_uri and application_url must have matching hosts"

Shopify requires the redirect URL to be on the **same host** as the App URL. Older versions of the admin used a `supabase.co` redirect URL, which does not match a `vercel.app` App URL and causes this error. Fix it in either of two ways:

- **Recommended:** connect with **App keys** (section 5A). It uses no redirect, so the error cannot happen.
- Or, in the app version, set the redirect URL to `https://<your admin domain>/oauth/shopify/callback`, with exactly the same domain as the App URL. Release the version and connect again.

If you open the admin on a custom domain, use that domain in both URLs. The connect dialog always shows the right values for the domain you're on.

## 2. Scopes (exact list)

```
read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_returns,write_returns
```

| Scopes | What the admin does with them |
|---|---|
| `read_orders`, `write_orders` | Import orders and cancellations, and read fulfilment status. **Mark paid** and **Cancel on Shopify** run only when staff click them on the order page. Cancelling never refunds and never restocks on Shopify. |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` | When an order is **Shipped** here, fulfil it on Shopify with the courier, tracking number and tracking link |
| `read_inventory`, `write_inventory` | Keep Shopify's available quantity equal to yours, and receive the inventory webhook |
| `read_locations`, `write_locations` | List locations so you can choose the one to keep in step |
| `read_products`, `write_products` | Read the catalogue to link variants by SKU; import Shopify products into your products |
| `read_draft_orders`, `write_draft_orders` | Reserved for sending phone or Messenger orders to Shopify (next update) |
| `read_returns`, `write_returns` | Reserved for syncing returns with Shopify (next update) |

Customer details are not a scope; they come with the order as *protected customer data* (section 3), so `read_customers` is not needed.

If your orders are fulfilled by a **fulfilment-service app** (a 3PL) instead of your own location, also add `read_third_party_fulfillment_orders,write_third_party_fulfillment_orders`.

### Example `shopify.app.toml` (Shopify CLI users)

```toml
client_id = "PASTE-FROM-DEV-DASHBOARD"
name = "EcomDrive"
application_url = "https://commerce-sage-eight-89.vercel.app/admin/channels"
embedded = false

[access_scopes]
scopes = "read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_returns,write_returns"

[auth]
redirect_urls = [ "https://commerce-sage-eight-89.vercel.app/oauth/shopify/callback" ]

[webhooks]
api_version = "2026-07"
# No subscriptions here. The admin registers its own webhooks
# (orders/create, orders/updated, orders/cancelled, app/uninstalled,
# fulfillments/create, fulfillments/update, inventory_levels/update),
# all signed with the app's client secret and checked on arrival.
```

## 3. Protected customer data

Orders include the customer's name, phone, e-mail and address, so Shopify requires you to declare why the app reads them:

1. In the app, open **API access → Protected customer data access → Request access**.
2. Under **Protected customer data**, choose the reason **Order fulfilment / store management**.
3. Under **Protected customer fields**, select **Name, Email, Phone, Address**.
4. Save. For an app used on your own store this is a self-declaration with no review.

Without this step, imported orders arrive with empty customer fields.

## 4. Release

1. Click **Release** on the version.
2. Open **Distribution**, choose **Custom distribution**, and enter your store's `….myshopify.com` address.
3. Copy the **Client ID** and **Client secret** from **Settings**.

## 5. Connect in the admin

Go to **Store → Sales Channels → Shopify → Connect**.

### 5A. App keys (recommended, no redirect)

1. In the app's overview in the Dev Dashboard, click **Install app** and choose your store.
2. In the admin, choose **App keys (easiest)** and enter the store address (`yourstore.myshopify.com`), the Client ID and the Client secret.
3. Click **Connect and test**. The admin gets the access token directly from Shopify and renews it every day. You aren't sent to Shopify and back.

### 5B. Approve on Shopify

1. Choose **Approve on Shopify**, enter the store address, Client ID and Client secret, and click **Continue to Shopify**.
2. Shopify asks you to approve the scopes. Approve them, and you come back to the admin.

Either way, the access token is saved encrypted in Vault and never shown again, not even to staff. The connection test then runs automatically, and every row should be green: *Store reachable*, *Permissions*, *Customer details*, *Fulfilment on Shopify*, *Stock sync* and *Instant order updates*. If webhooks are missing, click **Fix webhooks**. *Customer details* turns green after the first order arrives with a phone number.

### Adding scopes to an existing connection

When the scope list changes, do this once:

1. Add the scopes above to a new app version and **Release** it.
2. If you use **App keys**, open **Install app** again in the Dev Dashboard to accept the new scopes.
3. In the admin, open **Store → Sales Channels → Shopify → Connect** again with the same Client ID and secret.
4. Click **Fix webhooks** so any new webhooks are added.

**Store → Store Sync** shows a red banner listing any scope that is still missing.

## 6. Turn on fulfilment and stock sync

Open **Store → Store Sync**.

**Fulfilment** (on by default for Shopify):

- *Fulfil on Shopify when shipped.* Only the **Shipped** status fulfils on Shopify. Web Orders, approval and Ready to ship never touch it.
- *Send Shopify's shipping e-mail.* Shopify e-mails the tracking link when the order has an e-mail address. The order page shows "Shopify asked to e-mail the customer". Shopify does not confirm delivery of that e-mail, so the admin never claims it was delivered.
- *Allow fulfilment without tracking* is off, so an order waits until it has a courier tracking number.

**Products** (optional): under **Import products**, search (or tick *Only not imported*), select products and import them. You see a preview first. Products whose SKU already exists here are linked instead of duplicated. *Use Shopify's stock as opening stock* records an adjustment in your inventory history.

**Stock**:

1. Click **Read Shopify catalog**. Variants with the **same SKU** here and in Shopify link automatically. Link the rest under **Not linked**.
2. Choose the **Shopify location** to keep in step (one location).
3. Choose what happens when someone changes stock by hand in Shopify. *Flag it for me* is recommended.
4. Turn on **Keep Shopify stock in step** and click **Save**. Nothing is overwritten at this moment; today's Shopify numbers become the starting point.
5. Under **Stock**, review the differences. Select rows, then choose **Set Shopify to mine** or **Use Shopify's number**. You see a preview, and nothing changes until you click **Apply**. *Use Shopify's number* records a stock adjustment in your inventory history, so no entry is ever deleted.

From then on, every stock change here (orders, cancellations, returns, purchases, manual adjustments) updates Shopify within about a minute. Failed updates retry automatically with back-off, and you can see them under **Jobs**.

## 7. WooCommerce

WooCommerce connects under **Store → Sales Channels → WooCommerce**, either with one click (WooCommerce asks you to approve read/write access) or with REST API keys. After that it uses the same **Store Sync** page:

- **Stock:** the same matching by SKU, preview and *Keep stock in step* as Shopify. WooCommerce has a single stock figure per product or variation (shown as *Store stock*). WooCommerce can't do a safe compare-and-set, so the admin reads the current number just before writing; if it changed in between, the job is marked **stale** and you are asked again rather than overwriting it.
- **Instant updates:** the `product.updated` webhook is optional. When it's on, stock edits made in WooCommerce are seen at once; without it, they are picked up at the next sync.
- **Fulfilment** (off by default): when on, a Shipped order is set to **Completed** in WooCommerce with a customer note that contains the courier and tracking number.
- **Products:** import works the same as for Shopify.

## 8. Checklist

- [ ] App created in the Dev Dashboard, **embedded = false**
- [ ] App URL set (and the redirect URL on the same domain if you use *Approve on Shopify*)
- [ ] The 14 scopes added; version released
- [ ] Protected customer data requested (name, e-mail, phone, address)
- [ ] App installed on the store (App keys) and connected under Store → Sales Channels; all checks green
- [ ] Catalog read, location chosen, differences reviewed, stock sync on

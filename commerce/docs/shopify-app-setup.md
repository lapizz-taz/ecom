# Shopify app setup

This connects your Shopify store to the admin so that:

- Shopify orders are imported into **Web Orders**.
- **First sync:** every Shopify product comes into your Products page with its SKU, prices, cost, barcode, weight, vendor, tags, images and Shopify's stock. After that, your stock here is the source of truth and every change is sent to Shopify automatically.
- New products added in Shopify later come in by themselves.
- Orders you mark **Shipped** are fulfilled on Shopify automatically, with the courier name, tracking number and tracking link. Shopify then sends its own shipping e-mail.
- Orders that are **Delivered** here are marked **Delivered** on Shopify automatically.
- Staff can **Mark paid** or **Cancel** an order on Shopify from the order page. Nothing else on Shopify changes unless a person clicks.

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
read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,write_fulfillments,read_returns,write_returns
```

| Scopes | What the admin does with them |
|---|---|
| `read_orders`, `write_orders` | Import orders and cancellations, and read fulfilment status. **Mark paid** and **Cancel on Shopify** run only when staff click them on the order page. Cancelling never refunds and never restocks on Shopify. |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` | When an order is **Shipped** here, fulfil it on Shopify with the courier, tracking number and tracking link |
| `read_fulfillments`, `write_fulfillments` | When an order is **Delivered** here, add a *Delivered* event to its Shopify fulfilment (Shopify's `fulfillmentEventCreate` needs `write_fulfillments`) |
| `read_inventory`, `write_inventory` | Keep Shopify's available quantity equal to yours, read each item's cost, and receive the inventory webhook |
| `read_locations`, `write_locations` | List locations so you can choose the one to keep in step |
| `read_products`, `write_products` | Bring Shopify products here (first sync), and new ones as they are added (product webhooks) |
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
scopes = "read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,write_fulfillments,read_returns,write_returns"

[auth]
redirect_urls = [ "https://commerce-sage-eight-89.vercel.app/oauth/shopify/callback" ]

[webhooks]
api_version = "2026-07"
# No subscriptions here. The admin registers its own webhooks
# (orders/create, orders/updated, orders/cancelled, app/uninstalled,
# fulfillments/create, fulfillments/update, inventory_levels/update,
# products/create, products/update, products/delete), all signed with the
# app's client secret and checked on arrival.
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

### If the app was uninstalled or reinstalled in Shopify

Shopify tells the admin, and the store moves to *Disconnected* with "The app was uninstalled in Shopify". Install the app again in the Dev Dashboard, then click **Reconnect** next to the store under **Sales Channels**. The saved App keys are used, so you don't need to type them again.

## 6. First sync, then everything is automatic

Open **Store → Store Sync**. The catalog has already been read by itself right after connecting. The **First sync with Shopify** card walks you through it:

1. Check that the catalog was read (click **Read again** for fresh numbers).
2. Choose the **Shopify location** to keep in step.
3. Leave **Import new Shopify products automatically afterwards** on, then click **Preview first sync**.

The preview lists exactly what will happen, and nothing changes yet:

- **New products:** every Shopify product that isn't here yet is created with its SKU, price, compare-at price, **cost price**, barcode, weight, vendor, tags, images and **Shopify's stock as opening stock**.
- **Linked by SKU:** a product you already have (same SKU) is linked, not duplicated. Its stock is set to Shopify's number **once**, as a recorded stock correction. Its price stays yours. Empty fields (cost, barcode, weight, image) are filled from Shopify.
- **Not counted:** items whose stock Shopify doesn't track are linked but not synced.

Click **Start first sync**. Stock sync then turns on, and from that moment **your stock is the source of truth**. Every sale, cancellation, return, purchase and adjustment here sets Shopify's number within about a minute. Each update reads Shopify's current number first and sets an exact value, so nothing is ever subtracted twice.

**Fulfilment and delivery** (on by default):

- *Fulfil on Shopify when shipped.* Marking an order **Shipped** fulfils it on Shopify automatically, with the courier, tracking number and tracking link; there's no button to click. If there's no tracking number yet, it waits and goes out as soon as one is added.
- *Mark delivered on Shopify.* When the courier delivers it here, the Shopify fulfilment gets a **Delivered** event, so the order shows Delivered in Shopify. This needs `write_fulfillments`.
- *Send Shopify's shipping e-mail.* Shopify e-mails the tracking link when the order has an e-mail address. Shopify does not confirm delivery of that e-mail, so the admin never claims it was delivered.

**Later changes in Shopify:**

- A product added in Shopify comes in by itself (with its stock), and a new size or colour joins the existing product.
- A product deleted in Shopify stops syncing. Your product and its stock stay here.
- If someone changes stock by hand in Shopify, it's flagged for you under **Stock** (or set back to yours if you choose *This app wins*).

Failed updates retry automatically with back-off; you can see them under **Jobs**.

## 7. WooCommerce

WooCommerce connects under **Store → Sales Channels → WooCommerce**, either with one click (WooCommerce asks you to approve read/write access) or with REST API keys. After that it uses the same **Store Sync** page:

- **First sync:** the same card and preview as Shopify. Products come in with SKU, prices, images, tags, category and stock. WooCommerce itself has no cost price; when a cost-of-goods plugin stores one (`_wc_cog_cost`, `_purchase_price` and similar), it is imported too.
- **Stock:** after the first sync your stock is the truth, as with Shopify. WooCommerce has a single stock figure per product or variation (shown as *Store stock*). WooCommerce can't do a safe compare-and-set, so the admin reads the current number just before writing; if it changed in between, the job is marked **stale** and you are asked again rather than overwriting it.
- **Instant updates:** the `product.created`, `product.updated` and `product.deleted` webhooks are optional. When they're on, new products and stock edits made in WooCommerce are seen at once; without them, they are picked up at the hourly check.
- **Fulfilment** (off by default): when on, a Shipped order is set to **Completed** in WooCommerce with a customer note that contains the courier and tracking number. WooCommerce has no separate Delivered status.

## 8. Checklist

- [ ] App created in the Dev Dashboard, **embedded = false**
- [ ] App URL set (and the redirect URL on the same domain if you use *Approve on Shopify*)
- [ ] The 16 scopes added; version released
- [ ] Protected customer data requested (name, e-mail, phone, address)
- [ ] App installed on the store (App keys) and connected under Store → Sales Channels; all checks green
- [ ] First sync previewed and started under Store → Store Sync

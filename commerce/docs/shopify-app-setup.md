# Shopify app setup

This connects your Shopify store to the admin so that:

- Shopify orders are imported into **Web Orders**.
- Orders you mark **Shipped** are fulfilled on Shopify with the courier name, tracking number and tracking link. Shopify then sends its own shipping e-mail.
- Your stock (on hand − reserved) is kept in step with Shopify's *available* quantity.

You create one app for your store in Shopify's **Dev Dashboard**, then connect it under **Store → Sales Channels**. This takes about ten minutes.

> Since 1 January 2026 Shopify no longer lets merchants create new "custom apps" from *Settings → Apps → Develop apps*. Use the Dev Dashboard. A store that already has an older custom app with an Admin API access token can still connect with **Access token** instead.

---

## 1. Create the app

1. Go to <https://dev.shopify.com> and sign in as the **store owner** (or staff with the *Develop apps* permission). A Dev Dashboard app installs only on stores in its own organization, so a collaborator or agency account can't create it for you.
2. Click **Apps → Create app** and select **Start from Dev Dashboard**. Name it, for example `EcomDrive`.
3. Open the new app and select **Versions → Create version**. Fill in the settings below. They are the same values as in the `shopify.app.toml` further down if you use the Shopify CLI.

| Setting | Value |
|---|---|
| App URL (`application_url`) | `https://commerce-sage-eight-89.vercel.app/admin/channels` |
| Embed app in Shopify admin (`embedded`) | **Off** (`false`). The admin opens in its own tab; it does not run inside Shopify. |
| Redirect URLs | `https://tcjdgiohmhjqppzwoztj.supabase.co/functions/v1/channels/callback/shopify` |
| Webhooks API version | `2026-07` |
| Scopes | see the next section |

Set **embedded to false**. The admin refuses to be framed by other sites (that is what fixed the theme preview), so an embedded app would show a blank page inside Shopify.

## 2. Scopes (exact list)

```
read_orders,read_customers,read_products,read_inventory,write_inventory,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders
```

| Scope | Why |
|---|---|
| `read_orders` | Import orders, read fulfilment status and tracking (also the *orders/updated* webhook) |
| `read_customers` | Customer name, phone and e-mail on imported orders |
| `read_products` | Read the catalogue to link Shopify variants to your products by SKU |
| `read_inventory` | Read Shopify's available quantity |
| `write_inventory` | Set Shopify's available quantity to yours |
| `read_locations` | List locations so you can choose the one to keep in step |
| `read_merchant_managed_fulfillment_orders` | Read what is left to fulfil on an order |
| `write_merchant_managed_fulfillment_orders` | Create the fulfilment with tracking when you mark an order Shipped |

**Not needed:** `write_orders`, `write_products`, `read_returns`/`write_returns` and draft-order scopes. The admin never edits, cancels or refunds Shopify orders, and never changes products.

If your orders are fulfilled by a **fulfilment-service app** (a 3PL) instead of your own location, also add `read_third_party_fulfillment_orders,write_third_party_fulfillment_orders`.

### Example `shopify.app.toml` (Shopify CLI users)

```toml
client_id = "PASTE-FROM-DEV-DASHBOARD"
name = "EcomDrive"
application_url = "https://commerce-sage-eight-89.vercel.app/admin/channels"
embedded = false

[access_scopes]
scopes = "read_orders,read_customers,read_products,read_inventory,write_inventory,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders"

[auth]
redirect_urls = [ "https://tcjdgiohmhjqppzwoztj.supabase.co/functions/v1/channels/callback/shopify" ]

[webhooks]
api_version = "2026-07"
# No subscriptions here. The admin registers its own webhooks
# (orders/create, orders/updated, orders/cancelled, app/uninstalled, and when
# allowed fulfillments/create, fulfillments/update, inventory_levels/update),
# all signed with the app's client secret and checked on arrival.
```

## 3. Protected customer data

Orders include the customer's name, phone, e-mail and address, so Shopify requires you to declare why the app reads them:

1. In the app, open **API access → Protected customer data access → Request access**.
2. Under **Protected customer data**, choose the reason **Order fulfilment / store management**.
3. Under **Protected customer fields**, select **Name, Email, Phone, Address**.
4. Save. For an app used on your own store this is a self-declaration with no review.

Without this step, imported orders arrive with empty customer fields.

## 4. Release and install

1. Click **Release** on the version.
2. Open **Distribution**, choose **Custom distribution**, and enter your store's `….myshopify.com` address. Shopify gives you an install link, but you don't need it: the admin starts the install for you in the next step.
3. Copy the **Client ID** and **Client secret** from **Settings**.

## 5. Connect in the admin

1. Go to **Store → Sales Channels → Shopify → Connect**.
2. Enter the store address (`yourstore.myshopify.com`), the Client ID and the Client secret, then click **Connect**.
3. Shopify asks you to approve the scopes; approve them. You come back to the admin. The access token is saved encrypted in Vault and never shown again, not even to staff.
4. The connection test runs automatically. Every row should be green: *Store reachable*, *Permissions*, *Customer details*, *Fulfilment on Shopify*, *Stock sync* and *Instant order updates*. If webhooks are missing, click **Fix webhooks**. *Customer details* turns green after the first order arrives with a phone number.

### If you were already connected before this update

The new features need scopes the old connection didn't have (`write_inventory`, `read_locations` and the two fulfilment-order scopes). Do this once:

1. Add the scopes above to a new app version and **Release** it.
2. In the admin, open **Store → Sales Channels → Shopify → Connect** again with the same Client ID and secret.
3. Approve the new scopes in Shopify.
4. Click **Fix webhooks** so the fulfilment and inventory webhooks are added.

**Store → Shopify Sync** shows a red banner listing any scope that is still missing.

## 6. Turn on fulfilment and stock sync

Open **Store → Shopify Sync**.

**Fulfilment** (on by default):

- *Fulfil on Shopify when shipped.* Only the **Shipped** status fulfils on Shopify. Web Orders, approval and Ready to ship never touch it.
- *Send Shopify's shipping e-mail.* Shopify e-mails the tracking link when the order has an e-mail. The order page shows "Shopify asked to e-mail the customer". Shopify does not confirm delivery of that e-mail, so the admin never claims it was delivered.
- *Allow fulfilment without tracking* is off: an order waits until it has a courier tracking number.

**Stock**:

1. Click **Read Shopify catalog**. Variants with the **same SKU** here and in Shopify link automatically. Link the rest under **Not linked**.
2. Choose the **Shopify location** to keep in step (one location).
3. Choose what happens when someone changes stock by hand in Shopify. *Flag it for me* is recommended.
4. Turn on **Keep Shopify stock in step** and click **Save**. Nothing is overwritten at this moment: today's Shopify numbers become the starting point.
5. Under **Stock**, review the differences. Select rows, then choose **Set Shopify to mine** or **Use Shopify's number**. You see a preview, and nothing changes until you click **Apply**. *Use Shopify's number* records a stock adjustment in your inventory history, so no entry is ever deleted.

From then on, every stock change here (orders, cancellations, returns, purchases, manual adjustments) updates Shopify within about a minute. Failed updates retry automatically with back-off, and you can see them under **Jobs**.

## 7. Checklist

- [ ] App created in the Dev Dashboard, **embedded = false**
- [ ] App URL and redirect URL set as above
- [ ] The 8 scopes added; version released
- [ ] Protected customer data requested (name, e-mail, phone, address)
- [ ] Connected under Store → Sales Channels; all checks green
- [ ] Catalog read, location chosen, differences reviewed, stock sync on

# WooCommerce integration

Two parts work together:

| Part | Where | What it does |
| --- | --- | --- |
| **Fullfilio Connect** (WordPress plugin) | `fullfilio-connect/` | Installed on the store. Sends orders and status changes the moment they happen, captures unfinished checkouts, saves ad attribution on each order, runs the order shield at checkout, adds the Confirmed / Shipped / Delivered / Partially delivered / Return in transit / Returned order statuses, puts returned items back in WooCommerce stock (once, never more than WooCommerce took off) and reports its health every 15 minutes. |
| SaaS module | `supabase/functions/channels`, `supabase/migrations/20261031000100_woo_plugin.sql`, `src/features/channels/woo-plugin-panel.tsx` | Connects the store (WooCommerce's own key approval screen), registers the WooCommerce webhooks, imports orders and products through the official REST API (`wc/v3`), receives the plugin's signed events and sets the WooCommerce order's status as the order moves on here (`supabase/migrations/20261102000100_woo_order_sync.sql`, `wooStatusStep` in `_shared/channels/sync.ts`). |

The plugin is optional: without it the store still connects with REST keys and webhooks. With it,
orders arrive even when WooCommerce pauses a webhook, unfinished checkouts and attribution are
captured, and the store owner gets a troubleshooting page.

## How the store connects

1. Sales channels → WooCommerce → **Download plugin** (`/downloads/fullfilio-connect.zip`).
2. WordPress → Plugins → Add New → Upload Plugin → choose the zip → Install → Activate.
3. Sales channels → WooCommerce → **Connect**, enter the store address, approve on the store.
   WooCommerce sends the API keys to Fullfilio; Fullfilio then pairs the plugin by itself
   (`POST /wp-json/fullfilio/v1/pair`, authenticated with those keys). Nothing to copy.
   If pairing cannot reach the store, the plugin tab shows a connection code to paste on
   WooCommerce → Fullfilio.

## Security

- Plugin → Fullfilio: `X-FFC-Signature = base64(HMAC-SHA256(secret, "<timestamp>.<body>"))`, a 5-minute
  window and a per-event id; repeated event ids are skipped. The secret is per store, created on the
  server and kept in Vault, never in a table the browser can read.
- WooCommerce webhooks: `X-WC-Webhook-Signature` (HMAC of the body with the webhook secret) and
  delivery-id de-duplication.
- The plugin keeps failed sends in its own queue (`wp_ffc_outbox`), retries after 30 s, 2 min, 5 min …
  up to 12 h (10 tries) and does not retry a request Fullfilio refused (4xx).

## Building the zip

```sh
node scripts/build-woo-plugin.mjs          # writes public/downloads/fullfilio-connect.zip
node scripts/build-woo-plugin.mjs --check  # fails if the zip is out of date (unit tests run this too)
```

## Test store (`test/`)

`test/docker-compose.yml` runs WordPress + MariaDB on the local Supabase network. **WooCommerce itself
could not be downloaded in the build environment**, so the store runs `woo-standin.php`, a must-use
plugin that imitates the parts of WooCommerce used here (cart and classic checkout with its hooks,
orders, the `wc/v3` REST API with key auth, `/wc-auth/v1/authorize`, signed webhooks that pause after
5 failures). The Fullfilio Connect plugin is installed on it through the normal WordPress upload.
**Before release, repeat the end-to-end run on a store with real WooCommerce (8.x / 9.x), with both
the classic and the block checkout.**

```sh
cd integrations/woocommerce/test && docker compose up -d   # store on http://172.18.0.1:8090
# install WordPress once (admin / admin-pass-123, permalinks "Post name"), then:
CHROMIUM_PATH=… FUNCTIONS_ENV_FILE=supabase/functions/.env node integrations/woocommerce/test/woo-e2e.cjs
```

The edge functions must allow the plain-http test store: `CHANNELS_ALLOW_HTTP_HOSTS=172.18.0.1:8090`.
The test covers install, connect and approval, automatic pairing, heartbeat, unfinished checkout,
order import (once, with attribution), duplicate / forged / stale events, a re-delivered webhook,
Fullfilio being unreachable (queued and retried), a paused webhook switched back on, Confirmed →
Shipped → Delivered → Return in transit → Returned set on the store once each (not sent back), returned
items put back in WooCommerce stock once, a partial delivery returned in two steps, a cancel here
(WooCommerce restores its own stock once; with stock sync on it does not), a cancel on the store,
the order shield and disconnect / reconnect.

Stock, never counted twice:

| Fullfilio "Keep stock in step" | Order placed | Cancelled | Returned / partly delivered |
| --- | --- | --- | --- |
| Off (WooCommerce keeps its count) | WooCommerce takes it off | WooCommerce puts back what it took off | The plugin puts back the items received as good (damaged ones are not), tracked per order line |
| On (Fullfilio keeps the count) | WooCommerce takes it off | Not put back by WooCommerce; Fullfilio sends the count | Counted in Fullfilio, which sends the count |

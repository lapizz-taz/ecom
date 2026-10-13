# WooCommerce integration

Two parts work together:

| Part | Where | What it does |
| --- | --- | --- |
| **Fullfilio Connect** (WordPress plugin) | `fullfilio-connect/` | Installed on the store. Sends orders and status changes the moment they happen, captures unfinished checkouts, saves ad attribution on each order, runs the order shield at checkout, adds the Confirmed / Shipped / Delivered / Partially delivered / Return in transit / Returned order statuses, puts returned items back in WooCommerce stock (once, never more than WooCommerce took off), protects the checkout (Bangladeshi phone check; bot check with Flag or Block and optional Cloudflare Turnstile, set on the plugin page), shows a dashboard (orders, value, unfinished checkouts, stopped/flagged, delivery health) and reports its health every 15 minutes. |
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

## Ad tracking (WooCommerce → Fullfilio → Ad tracking)

Works with or without the Fullfilio connection. The merchant enters their own Pixel ids and tokens.

- **Browser + server, de-duplicated.** PageView, ViewContent, AddToCart and InitiateCheckout fire in the
  browser pixels and the page posts the same event id to `wc-ajax=ffc_px`; the store sends the server copy
  (Meta Conversions API, TikTok Events API). Values come from the store, never from the browser. The
  endpoint is capped site-wide per minute (one reused row) and per IP when a persistent object cache exists.
- **When the Purchase counts:** when the order is placed (normal), on call confirmation (status Confirmed,
  recommended for COD) or on delivery. One event id per order (`ffc_ord_<id>`) for browser and server.
- **Not counted:** a customer below the receive-rate limit (Fullfilio sends the rate with Confirmed; a shield
  advance/block counts as low) and the same customer again within N hours (phone in +880 form, else email).
- **Matching:** hashed email, phone (Meta `880…`, Google/TikTok E.164), name, city, district, postcode,
  country and a first-party visitor id (`ffc_vid`, the external_id in browser and server), plus fbc/fbp
  (created in Meta's format when missing), ttclid/_ttp, gclid, IP and user agent. The page shows an
  estimated match quality from the keys sent; Meta's real Event Match Quality is in Events Manager.
- **Save & test connection:** Meta reads the pixel with the token (nothing counted); TikTok needs a test
  event code; Google uses GA4's validation server (it does not check the API secret).

## Updates

`scripts/build-woo-plugin.mjs` also writes `public/downloads/fullfilio-connect.json` (version, package URL,
SHA-256, changelog from `readme.txt`). Installed plugins (`FFC_Updater`) read it over HTTPS, so WordPress
shows "a new version is available" with Update now, View details and auto-updates. The package must be on
the manifest's host and match its SHA-256, or it is not installed. Bump `Version`/`FFC_VERSION` and the
readme `Stable tag` together; the build refuses a mismatch. Published versions use three numbers (x.y.z) so
every installed copy can read them (1.4.0 accepted nothing else); from 1.4.2 the plugin also reads two-part
versions and compares parts as numbers (1.5 = 1.5.0, 1.4.10 > 1.4.9) — `php test/updater-sim.php` checks it.

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
# ad tracking + updates in WordPress, no Fullfilio needed (ad-platform calls captured locally, port 8080 free):
CHROMIUM_PATH=… node integrations/woocommerce/test/track-e2e.cjs
php integrations/woocommerce/test/track-sim.php      # offline: rules and payloads
```

The edge functions must allow the plain-http test store: `CHANNELS_ALLOW_HTTP_HOSTS=172.18.0.1:8090`.
The test covers install, connect and approval, automatic pairing, heartbeat, unfinished checkout,
order import (once, with attribution), duplicate / forged / stale events, a re-delivered webhook,
Fullfilio being unreachable (queued and retried), a paused webhook switched back on, Confirmed →
Shipped → Delivered → Return in transit → Returned set on the store once each (not sent back), returned
items put back in WooCommerce stock once, a partial delivery returned in two steps, a cancel here
(WooCommerce restores its own stock once; with stock sync on it does not), a cancel on the store,
the order shield, checkout protection (made-up and invalid numbers refused, +880 saved as 01…, a script
blocked, then only flagged), the dashboard and disconnect / reconnect.

Stock, never counted twice:

| Fullfilio "Keep stock in step" | Order placed | Cancelled | Returned / partly delivered |
| --- | --- | --- | --- |
| Off (WooCommerce keeps its count) | WooCommerce takes it off | WooCommerce puts back what it took off | The plugin puts back the items received as good (damaged ones are not), tracked per order line |
| On (Fullfilio keeps the count) | WooCommerce takes it off | Not put back by WooCommerce; Fullfilio sends the count | Counted in Fullfilio, which sends the count |

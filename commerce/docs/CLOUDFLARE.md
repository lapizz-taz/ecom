# Fullfilio on Cloudflare

How the site runs on Cloudflare, how to switch to it step by step (starting
from buying a domain), how to go back, and what it costs.

## What runs where

| Part | Before | On Cloudflare |
| --- | --- | --- |
| Website, admin, storefront (React app) | Vercel | **Workers Static Assets** (one Worker, `fullfilio`) |
| The 22 backend functions (checkout, payments, couriers, Shopify/WooCommerce sync, Clerk bridge, Super Admin, …) | Supabase Edge Functions | **The same Worker**, at `/functions/v1/<name>` on your own domain |
| Clerk's sign-in API (`/__clerk`) and Shopify's OAuth return (`/oauth/shopify/callback`) | `vercel.json` rewrites | **The Worker** |
| Uploaded files (product and theme images, courier statements) | Supabase Storage | **R2** (bucket `fullfilio-files`) |
| Cache | — | **Workers KV** (`fullfilio-cache`): Clerk's public signing keys only |
| Merchants' own store domains | Vercel domains API | **Cloudflare for SaaS** custom hostnames |
| Database, row-level security, every business rule, scheduled jobs | Supabase Postgres + pg_cron | **unchanged** (Supabase Postgres + pg_cron) |
| Sign-in | Clerk | **unchanged** (Clerk) |

Why the database stays on Postgres: the order state machine, stock ledger,
finance postings, permissions and tenant isolation are ~170 tables and
hundreds of PL/pgSQL functions with row-level security. D1 (SQLite) has no
stored procedures or row-level security, so moving there means rewriting the
whole backend and moving live data — exactly the "rebuild" and data risk to
avoid. Nothing in the database moves; no data is copied or changed by the
switch.

Why no Cron Triggers or Queues: the database already schedules every job
(pg_cron) and only wakes a function when there is work (`where
public.channel_jobs_due()` and similar). A Cloudflare Cron Trigger would wake
the Worker every minute to ask the same question (~1,440 extra calls a day),
and the job queues are already durable tables with retries and locking. The
jobs point at Supabase now and can point at the Worker later (step 12).

## How the code supports both

- `supabase/functions/<name>/handler.ts` is each function's code (one
  `export default` handler). `index.ts` next to it only does
  `Deno.serve(handler)`, so the same code still deploys to Supabase.
- `worker/` is the Cloudflare Worker: `router.ts` (routes), `functions.ts`
  (the 22 handlers), `files.ts` (R2), `index.ts` (entry, background work via
  `ctx.waitUntil`, in-process calls between functions, KV cache).
- `wrangler.jsonc` is the Worker's configuration; `public/_headers` the
  security and cache headers of static files (same as `vercel.json`).
- `npm run build:cloudflare` builds the site with `.env.cloudflare`: the
  browser calls `/functions/v1/…` on the site itself and uploads go to R2.
  `npm run build` (Vercel) is unchanged: it still calls Supabase.
- Sign-in is checked on the server for every private call, as before: the
  functions verify the Supabase session the Clerk bridge issued, and the
  database checks permissions and the store (row-level security). Uploads ask
  the database (`public.file_access`) for the same permissions the Storage
  policies had, and every file lives in the store's own folder.
- `SUPABASE_FUNCTIONS` (a Worker variable) lists functions the Worker passes
  on to Supabase unchanged. On Workers Free it lists the long-running ones
  (store sync, courier booking, ad sync, notification sending): the free plan
  allows only 10 ms of CPU and 50 outgoing requests per call. On Workers Paid
  set it to empty and everything runs on Cloudflare.

## What it costs

| Service | Plan | Price | Limits that matter |
| --- | --- | --- | --- |
| Cloudflare Workers | Free | $0 | 100,000 Worker requests/day (static files don't count), 10 ms CPU and 50 subrequests per request |
| | Paid (recommended once you have real traffic) | $5/month | 10M requests and 30M CPU-ms/month included, then $0.30/M requests and $0.02/M CPU-ms; up to 5 min CPU and 10,000 subrequests per request |
| R2 | Free tier | $0 | 10 GB stored, 1M uploads and 10M reads a month, no egress fees; then $0.015/GB-month |
| Workers KV | Free | $0 | 100,000 reads and 1,000 writes a day (we write a few a day) |
| Cloudflare for SaaS | Free | $0 | 100 merchant domains, then $0.10/domain/month |
| Domain fullfilio.com (Cloudflare Registrar) | — | at cost (about $10–11/year for a `.com`) | renew yearly (turn on auto-renew) |
| Supabase | Free | $0 | 500 MB database, 500k Edge Function calls/month; **free projects pause after a week without activity** |
| | Pro | $25/month | daily backups, no pausing — recommended before taking real orders |
| Clerk | Free | $0 | 50,000 monthly retained users |
| | Pro | $25/month | only if you need its paid features |

Starting cost: the domain (already bought) and $0/month. A safe production
setup: Workers Paid $5 + Supabase Pro $25 = **$30/month** plus the domain.

Paid plans are needed for: running the long jobs on Cloudflare (Workers Paid),
more than 100 merchant domains, Supabase backups/no pausing (Supabase Pro).

---

## Step by step (fullfilio.com)

You do the clicks that need your accounts and payment details; nothing here
needs you to share a password or API key in chat. Already done: fullfilio.com
is registered and its DNS is on Cloudflare; the Worker configuration in this
repo is set for fullfilio.com.

### 0. Back up first

The switch doesn't move or change data, but take a copy anyway:

- In the app: **Super Admin → Data Management → Export a merchant's data** for each store.
- Full database copy (on a computer with Node.js): Supabase → **Project
  Settings → Database → Connection string** (URI, "Session pooler"), then
  ```bash
  npx supabase db dump --db-url "<connection string>" -f fullfilio-schema.sql
  npx supabase db dump --db-url "<connection string>" --data-only -f fullfilio-data.sql
  ```
  Keep both files somewhere private (they contain customer data).

### 1. Turn on R2 (file storage)

1. <https://dash.cloudflare.com> → left menu **R2 Object Storage** → **Get
   started / Purchase R2 plan** (the free tier is $0; Cloudflare asks for a card).
2. Tell Claude R2 is on — it creates the buckets `fullfilio-files` and
   `fullfilio-files-staging` for you. (Or: **Create bucket** → `fullfilio-files`,
   and again `fullfilio-files-staging`.)

The first deploy (step 3) stops with "bucket not found" until the bucket exists.

### 2. DNS records for fullfilio.com

Cloudflare → **fullfilio.com → DNS → Records → Add record**, three times
(Proxy status **Proxied**, the orange cloud, on all three):

| Type | Name | IPv6 address | What it is for |
| --- | --- | --- | --- |
| AAAA | `www` | `100::` | www.fullfilio.com |
| AAAA | `*` | `100::` | store addresses like `yourshop.fullfilio.com` |
| AAAA | `stores` | `100::` | where merchants point their own domains |

`100::` is Cloudflare's "no server, the Worker answers" address. Leave the
existing `fullfilio.com` records and any `MX`/`TXT` (e-mail) records as they
are: once the Worker is deployed it answers for fullfilio.com in front of them.

Then send www to the main address: **Rules → Redirect Rules → Create rule →
template "Redirect from WWW to root"** → Deploy.

### 3. Connect GitHub (Cloudflare builds and deploys on every push)

1. **Workers & Pages → Create → Workers → Import a repository**.
2. **Connect GitHub**, allow access to `lapizz-taz/ecom`, select it.
3. Fill in:
   - **Project name:** `fullfilio` (must match `name` in `wrangler.jsonc`)
   - **Production branch:** `claude/optimistic-cray-c2d0fc` (the branch the live site is built from)
   - **Build command:** `npm run build:cloudflare`
   - **Deploy command:** `npx wrangler deploy`
   - **Advanced → Root directory:** `commerce`
   - **Build variables** — copy each value from Vercel → project `commerce` →
     Settings → Environment Variables: `VITE_SUPABASE_URL`,
     `VITE_SUPABASE_ANON_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SUPER_ADMIN_PATH`.
4. **Deploy** (2–3 minutes). This deploy also puts the Worker on
   `fullfilio.com/*` and `*.fullfilio.com/*`: from now on https://fullfilio.com
   shows Fullfilio.

### 4. Secrets of the Worker

**Workers & Pages → fullfilio → Settings → Variables and Secrets → Add →
type Secret**. Then **Deployments → Retry deployment** (or push any commit) so
they apply.

| Name | Value |
| --- | --- |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → *Legacy API keys* → `anon` |
| `SUPABASE_SERVICE_ROLE_KEY` | same page → `service_role` (secret; never put it anywhere else) |
| `CRON_SECRET` | the same value as the `CRON_SECRET` Edge Function secret in Supabase (Edge Functions → Secrets) |
| `CLERK_SECRET_KEY` | Clerk → API Keys → Secret key |
| `CLERK_WEBHOOK_SECRET` | Clerk → Webhooks → your endpoint → Signing secret (if you use it) |
| `FILES_SIGNING_KEY` | any long random text (a password generator, 40+ characters) |
| every other secret listed in Supabase → Edge Functions → Secrets | the same value (`RESEND_API_KEY`, `META_APP_SECRET`, courier/payment fallbacks, …) — except names starting with `SUPABASE_` |

The public settings (`PLATFORM_URL=https://fullfilio.com`, `FUNCTIONS_URL`,
`CLERK_PROXY_URL`, `CLERK_AUTHORIZED_PARTIES`, `CUSTOM_DOMAIN_TARGET`,
`SUPABASE_URL`, `SUPABASE_FUNCTIONS`) are already in `wrangler.jsonc`.

### 5. Check

- https://fullfilio.com opens the Fullfilio website; https://fullfilio.com/admin/login
  shows the sign-in page; https://www.fullfilio.com goes to https://fullfilio.com.
- https://fullfilio.com/functions/v1/checkout shows a short JSON error (not a page): the functions run.

Staff sign-in does **not** work yet: Clerk still expects the Vercel address (step 6).

### 6. Move Clerk to fullfilio.com (the switch-over moment)

From here staff sign in on fullfilio.com; the Vercel address stops accepting
sign-ins. Do it at a quiet hour.

1. Clerk dashboard → production instance → **Domains** → change the domain to
   `fullfilio.com`, keeping the **proxy** setup with proxy URL
   `https://fullfilio.com/__clerk` (no DNS records needed). (Clerk's screens
   change from time to time; their docs call this "change your production domain".)
2. Clerk → **API Keys**: copy the new **publishable key** into the Cloudflare
   build variable `VITE_CLERK_PUBLISHABLE_KEY` (fullfilio → Settings → Build),
   and the secret key into `CLERK_SECRET_KEY` if it changed.
3. Clerk → **Webhooks**: endpoint `https://fullfilio.com/functions/v1/clerk-webhook`.
4. Cloudflare → fullfilio → **Deployments → Retry deployment** (the publishable key is built into the site).
5. Sign in at https://fullfilio.com/admin/login with your Super Admin account.

### 7. Supabase sign-in links

Supabase → **Authentication → URL Configuration**:
- **Site URL:** `https://fullfilio.com`
- **Redirect URLs:** add `https://fullfilio.com/**` and `https://*.fullfilio.com/**`
  (keep the Vercel ones until step 13).

### 8. Store addresses on fullfilio.com

Tell Claude, or: **Super Admin → Global Settings → Store domains → Root
domain** = `fullfilio.com`. Stores then open at `<store name>.fullfilio.com`.

### 9. One public address for every webhook and return link

Tell Claude: it adds `FUNCTIONS_URL=https://fullfilio.com/functions/v1` to the
Supabase Edge Function secrets and redeploys the Supabase functions from this
version, so the functions that still run there (store sync, couriers, ads,
notifications on Workers Free) hand out fullfilio.com addresses too.

### 10. Tell outside services the new address

Old `…supabase.co/functions/v1/…` addresses keep working (those functions stay
deployed), so this can be done calmly over a few days:

- **Shopify app** (Partners / Dev Dashboard → your app → Configuration): App
  URL `https://fullfilio.com/admin/channels`, Allowed redirection URL
  `https://fullfilio.com/oauth/shopify/callback`. Then in Fullfilio **Sales
  channels → your Shopify store → Fix webhooks**.
- **WooCommerce plugin:** Sales channels → WooCommerce → **Connect plugin** again.
- **Couriers:** Couriers → Connections → Webhook shows the new URL — paste it
  into the Pathao / Steadfast panel.
- **TikTok / Google Ads:** add the redirect URI shown on the Ads → connection
  pages (`https://fullfilio.com/functions/v1/ad-platforms/callback/…`).
- **SSLCommerz IPN** (if used): `https://fullfilio.com/functions/v1/payment-webhook?provider=sslcommerz`.
- bKash / PayStation need nothing: each payment carries its own return address.

### 11. Merchants' own store domains (Cloudflare for SaaS)

1. Cloudflare → fullfilio.com → **SSL/TLS → Custom Hostnames → Enable** (free
   for 100). **Fallback Origin** → `stores.fullfilio.com` → Add (wait for *Active*).
2. **My Profile → API Tokens → Create Token → Custom token**: permission
   *Zone → SSL and Certificates → Edit*, zone `fullfilio.com`. Copy the token.
3. Worker secrets: `CF_SAAS_API_TOKEN` (the token) and `CF_ZONE_ID` (fullfilio.com
   → Overview, right column "Zone ID").

Then in `wrangler.jsonc` replace the two routes with
`{ "pattern": "*/*", "zone_name": "fullfilio.com" }` and push (or ask Claude):
that route sends merchants' domains to the Worker (Cloudflare refuses it until
Cloudflare for SaaS is enabled). Merchants add their domain in **Settings → Domain**: a subdomain
(`shop.theirbrand.com` / `www.theirbrand.com`) gets a CNAME to
`stores.fullfilio.com`. A bare root domain (`theirbrand.com`) works only where
their DNS provider allows a CNAME at the root (ALIAS / ANAME / CNAME
flattening — e.g. Cloudflare DNS); otherwise use `www`.

### 12. (Workers Paid only) Run everything on Cloudflare

1. Cloudflare → **Workers & Pages → Plans → Workers Paid** ($5/month).
2. In `wrangler.jsonc` set `"SUPABASE_FUNCTIONS": ""` and push (or ask Claude).
3. Supabase → **SQL Editor** → paste `deploy/cloudflare/cron-to-worker.sql`
   (already set to https://fullfilio.com) → Run. The scheduled jobs now call the Worker.

### 13. Retire Vercel (after a week without problems)

Vercel → project `commerce` → **Settings → Advanced → Pause** (or delete).
Then remove `vercel.json` from the repo. Supabase Edge Functions can stay
deployed as a free fallback.

---

## Going back (rollback)

Nothing in the database changes when you switch, so going back is only
pointing things at Vercel/Supabase again:

1. Clerk → Domains → set the production domain back to
   `commerce-sage-eight-89.vercel.app` (proxy URL
   `https://commerce-sage-eight-89.vercel.app/__clerk`) and put the matching
   publishable key back in Vercel; redeploy Vercel.
2. Supabase → Authentication → URL Configuration → Site URL back to the Vercel
   address. Supabase → Edge Functions → Secrets → delete `FUNCTIONS_URL`.
3. If you ran step 12: run `deploy/cloudflare/cron-to-supabase.sql`.
4. Shopify / WooCommerce / couriers: **Fix webhooks** / **Connect plugin** from the Vercel site.
5. fullfilio.com itself: Workers & Pages → fullfilio → Settings → Domains &
   Routes → remove the fullfilio.com routes (fullfilio.com then shows what its old DNS
   records point to). Files uploaded to R2 stay in the bucket; don't delete it.

## Local development

```bash
cp .env.example .env.local          # VITE_* values
cat > .dev.vars <<'X'               # Worker secrets for `wrangler dev` (git-ignored)
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
FILES_SIGNING_KEY=any-long-random-text
X
npm run worker:dev                  # builds, then serves site + functions on http://localhost:8787
```

`npx wrangler deploy --env staging` deploys a separate `fullfilio-staging`
Worker with its own cache and bucket; give it a separate (free) Supabase
project, never the live one.

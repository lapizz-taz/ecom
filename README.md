# Isolation — AI Sales & Customer-Support Assistant

One AI brain for **Instagram DMs, Facebook Messenger and WhatsApp**, connected to **Shopify** for live products, stock, prices and orders, with a staff dashboard, human handoff and an internal test console.

Built for **Isolation** (https://isolationpvt.shop · @isolation.pvt), a Bangladesh-based online fashion & accessories brand.

---

## Contents

1. [Architecture](#1-architecture)
2. [Project structure](#2-project-structure)
3. [What you must provide](#3-what-you-must-provide-credentials--decisions)
4. [Local setup](#4-local-setup)
5. [Database setup (Supabase)](#5-database-setup-supabase)
6. [Shopify setup](#6-shopify-setup)
7. [Meta setup: Messenger + Instagram](#7-meta-setup-facebook-messenger--instagram-dms)
8. [WhatsApp setup](#8-whatsapp-business-cloud-api-setup)
9. [Deploy to Vercel](#9-deploy-to-vercel)
10. [How the AI works](#10-how-the-ai-works)
11. [Admin dashboard](#11-admin-dashboard)
12. [Test chat](#12-test-chat)
13. [Security](#13-security)
14. [Testing](#14-testing)
15. [Operations](#15-operations--troubleshooting)
16. [Before going live — checklist](#16-before-going-live--checklist)

---

## 1. Architecture

```
Customer
   │
   ▼
Instagram DM ─┐        Messenger ─┐        WhatsApp ─┐
              ▼                   ▼                  ▼
   POST /api/webhooks/meta (object=instagram|page)   POST /api/webhooks/whatsapp
   (aliases: /api/webhooks/instagram, /api/webhooks/messenger)
              │  1. verify X-Hub-Signature-256   2. identify channel
              ▼
   Unified messaging layer  (src/lib/conversation/service.ts)
     3. identify customer   4. store message (idempotent, OTP/card redacted)
     5. human took over?  → stay silent
     6. rate limits, burst coalescing, exactly-once claim
              │
              ▼
   AI agent (src/lib/ai/agent.ts)
     • deterministic guards (human request, anger, refund, discount, cancel,
       payment problem, repeated dissatisfaction, credentials)
     • OpenAI with CONTROLLED TOOLS only (src/lib/ai/tools.ts)
     • grounding check: prices / % / delivery times / "order confirmed"
       must be backed by Shopify or config data — else fallback + handoff
              │                         ▲
              ▼                         │
   Knowledge base + Settings (Postgres)  Shopify Admin GraphQL (live)
              │
              ▼
   7–10. send via ORIGINAL channel adapter → store outgoing → handoff/notify
```

- **One brain, three adapters.** Channel code only converts payloads to/from a normalized `InboundMessage`; all logic is channel-independent.
- **Shopify is the source of truth** for products, variants, prices, stock, URLs and orders. Nothing about the catalogue is hard-coded in the prompt.
- **Webhooks answer Meta immediately** and run the AI in `after()` (Vercel `waitUntil`), so Meta never times out and retries.

## 2. Project structure

```
data/                         Knowledge-base seed files (editable later in the dashboard)
  brand/brand.json            Brand facts (online only, website, Instagram, categories)
  policies/policies.json      Return/exchange/refund/... — null = NOT confirmed (AI hands off)
  faq/faq.json                Confirmed FAQs
  promotions/promotions.json  Active promotions (empty = none)
  products/seed-products.json Seed/mock catalogue for /test-chat only (Shopify overrides)
  settings/defaults.json      First-run defaults: delivery ৳80/৳100/৳120, payment, AI settings
prisma/
  schema.prisma               Database schema
  migrations/                 SQL migrations
  seed.ts                     Seeds knowledge base, settings, first admin
src/
  middleware.ts               Auth gate for /admin, /test-chat and staff APIs
  lib/
    ai/prompt.ts              ★ Core system prompt + operating rules
    ai/agent.ts               Guards → model/tool loop → overrides → grounding check
    ai/tools.ts               Controlled tools with zod validation
    ai/guards.ts              Deterministic handoff triggers & confirmation detection
    ai/validate.ts            Anti-hallucination grounding validator
    ai/replies.ts             Pre-approved fixed replies (EN / Bangla / Banglish)
    ai/language.ts            English / Bangla / Banglish detection
    ai/llm.ts                 OpenAI client + scripted model for tests
    shopify/                  Admin GraphQL client (token or client-credentials), live + mock providers
    channels/                 Meta (Messenger + Instagram) and WhatsApp adapters, payload parsers
    conversation/service.ts   Unified pipeline (receive → process → send)
    handoff/                  Handoff lifecycle + Slack/Discord/email notifications
    config/settings.ts        Central configuration (DB-backed, validated)
    knowledge/                Knowledge-base access
    security/                 Signature verification, redaction, rate limiting
    analytics/                Privacy-preserving counters + dashboard stats
    auth/                     Staff sessions (JWT cookie), bcrypt, RBAC, CSRF
  app/
    api/webhooks/{meta,instagram,messenger,whatsapp}
    api/chat                  Test-chat endpoint (staff only)
    api/shopify/{products,orders}
    api/handoff               take over / return to AI / resolve / flag
    api/admin/...             settings, knowledge, users, customers, human replies
    api/auth/{login,logout}
    api/cron/maintenance      retries, recovery, cleanup
    admin/...                 Dashboard pages
    test-chat/                Internal test console
tests/                        62 automated tests (unit, full customer flows, webhook routes)
```

## 3. What you must provide (credentials & decisions)

Only these things genuinely require you. **Never share passwords or 2FA codes with anyone (including an AI)** — you enter credentials yourself in Vercel's environment settings.

| # | What | Where it goes | How to get it |
|---|------|---------------|---------------|
| 1 | PostgreSQL database | `DATABASE_URL`, `DIRECT_URL` | [§5](#5-database-setup-supabase) |
| 2 | Session secret | `NEXTAUTH_SECRET` | `openssl rand -base64 48` |
| 3 | Your admin email + an initial password | `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` (first seed only) | You choose |
| 4 | OpenAI API key | `OPENAI_API_KEY` | platform.openai.com → API keys |
| 5 | Shopify Admin API access | `SHOPIFY_STORE_DOMAIN` + `SHOPIFY_ACCESS_TOKEN` *or* `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` | [§6](#6-shopify-setup) |
| 6 | Meta app secret, Page token, verify token | `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_VERIFY_TOKEN` | [§7](#7-meta-setup-facebook-messenger--instagram-dms) |
| 7 | WhatsApp phone number ID + permanent token | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | [§8](#8-whatsapp-business-cloud-api-setup) |
| 8 | Cron secret | `CRON_SECRET` | `openssl rand -hex 32` |
| 9 | *(optional)* Slack/Discord webhook or Resend key for handoff alerts | `HANDOFF_WEBHOOK_URL`, `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | Slack/Discord channel settings, resend.com |

**Business decisions only you can confirm** (the AI will say "a team member will confirm" and hand off until you fill them in — it will not guess):

- Return, exchange, refund, cancellation and warranty policies → *Knowledge base → policy*
- Estimated delivery times per zone → *Settings → Delivery*
- Which areas count as "Dhaka suburb" (৳100) vs inside Dhaka (৳80) → *Settings → Delivery → Areas*
- Payment methods: **Cash on Delivery is enabled by default** — confirm this is correct; enable online/partial payment only with official instructions → *Settings → Payment*
- Business hours, support contact, Facebook page, WhatsApp number → *Settings → Business*

All variables are documented in [`.env.example`](.env.example).

**Easier: connect rows 4–7 from the dashboard.** Once you can sign in, open *Dashboard → Integrations* (admins only). Each service has step-by-step instructions, fields to paste the keys into, a **Save & test** button that confirms the connection (e.g. shows your Page name or Shopify store), and for Messenger, Instagram and WhatsApp a **Set up webhooks for me** button that registers the callback URL with your Meta app and subscribes your Page / account. Keys entered there are encrypted (AES-256-GCM, key derived from `NEXTAUTH_SECRET`) before they're stored in the database, are never shown again (only their last 4 characters), take effect immediately without a redeploy, and override the environment variable of the same name. If you ever change `NEXTAUTH_SECRET`, keys saved on the dashboard can no longer be read and must be pasted again — the Integrations page tells you which.

## 4. Local setup

Requirements: Node.js 22, PostgreSQL 14+.

```bash
git clone <this repo> && cd ecom
npm install
cp .env.example .env            # fill in at least DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD
npx prisma migrate deploy       # create tables
npm run db:seed                 # knowledge base + default settings + first admin
npm run dev                     # http://localhost:3000 → /login
```

Then remove `ADMIN_INITIAL_PASSWORD` from `.env`. Open **/test-chat** to try the assistant (works with the mock catalogue even before Shopify is connected; needs `OPENAI_API_KEY` for AI answers).

To receive real webhooks locally, expose the dev server with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and use that HTTPS URL in the Meta settings.

Other scripts: `npm test`, `npm run typecheck`, `npm run build`, `npm run admin:create -- email@x.com ADMIN` (password is prompted, never passed on the command line).

## 5. Database setup (Supabase)

1. Create a project at supabase.com (region: Singapore `ap-southeast-1` is closest to Bangladesh).
2. Give the app the connection — **either** option:
   - **Shortcut (recommended on Vercel):** set `SUPABASE_PROJECT_REF` (the id in your project URL), `SUPABASE_REGION` (e.g. `ap-southeast-1`) and `SUPABASE_DB_PASSWORD` (Project Settings → Database → *Reset database password* → copy). The build finds your project's shared-pooler host (`aws-<n>-<region>.pooler.supabase.com`), composes both connection URLs, and bakes only the host into the build — never the password. If discovery ever fails, also set `SUPABASE_POOLER_HOST` to the host shown under **Connect**.
   - **Explicit URLs:** from **Connect**: `DATABASE_URL` = **Transaction pooler** URI (port **6543**) + `?pgbouncer=true&connection_limit=1`; `DIRECT_URL` = **Session pooler** URI (port **5432**). Explicit URLs win when set.
3. Deploy. On Vercel, `vercel-build` applies pending migrations and the idempotent seed on every deploy. From your own computer (explicit URLs in `.env`):
   ```bash
   npx prisma migrate deploy
   npm run db:seed
   ```

Any PostgreSQL works (Neon, Vercel Postgres, RDS). With a non-pooled database set `DIRECT_URL` equal to `DATABASE_URL`.

**Tables** (see `prisma/schema.prisma`): `Customer` (profile), `ChannelUser` (the per-channel "users" table: channel, external_user_id, name, phone), `Conversation` (status `AI_ACTIVE | HUMAN_REQUIRED | HUMAN_ACTIVE | RESOLVED`, assigned_to), `Message` (sender, message, metadata, delivery status), `Order`, `DraftOrder`, `Handoff` (reason, created_at, resolved_at), `ProcessedEvent` (webhook idempotency), `ToolCallLog`, `Setting`, `KnowledgeEntry`, `AdminUser`, `AuditLog`, `AnalyticsEvent`, `RateLimit`.

## 6. Shopify setup

The app needs Admin API access with these scopes:

| Scope | Why |
|-------|-----|
| `read_products` | products, variants, prices, images, URLs |
| `read_inventory` | stock levels |
| `read_orders` | order status lookups (add `read_all_orders` for orders older than 60 days) |
| `read_customers` | match orders by customer phone |
| `write_draft_orders` (+ `read_draft_orders`) | create the confirmed order (draft → completed with payment pending) |

The app also needs **protected customer data** access to *name, phone and address* fields (order lookups verify the phone number; orders are created with the shipping address). In the app's configuration, declare protected customer data usage for these fields.

**Option A — you already have a custom app with an Admin API token (`shpat_…`):** set `SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_STORE_DOMAIN=your-store.myshopify.com`.

**Option B — new app (Shopify Dev Dashboard):** Shopify no longer lets you create new legacy custom apps from the store admin; create the app in the **Dev Dashboard** (dev.shopify.com) under the same organization that owns the store, configure the scopes above, release a version and install it on the Isolation store. Then set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. The app obtains short-lived Admin API tokens with the **client-credentials grant** and refreshes them automatically (`src/lib/shopify/client.ts`).

Set `SHOPIFY_STORE_DOMAIN` to the `*.myshopify.com` domain (Shopify admin → Settings → Domains), not `isolationpvt.shop`.

How orders are created: the AI collects product → variant → quantity → name → phone → address → area → payment method, calls `create_draft_order` (prices re-read from Shopify, never from the model), shows the summary, and only after the customer's explicit "yes/confirm" in a **later** message calls `confirm_order`, which runs `draftOrderCreate` + `draftOrderComplete(paymentPending: true)`. Orders are tagged `isolation-ai`, `channel-<channel>`, `payment-<method>`. In *Settings → AI → Order creation mode* you can switch to **draft only** so staff review each order in Shopify before it becomes real.

Verify the connection: *Dashboard → Products & stock* should list your live catalogue; *Orders → Shopify order lookup* should find an existing order.

## 7. Meta setup: Facebook Messenger + Instagram DMs

Prerequisites: a Facebook Page for Isolation, the Instagram account **@isolation.pvt** as a *Professional* (Business/Creator) account **linked to that Page**, and admin access to both in Meta Business Suite.

1. **Create the app** — developers.facebook.com → *My Apps → Create app* → use case *Other* → type **Business**. Copy **App ID** → `META_APP_ID` and *App settings → Basic → App secret* → `META_APP_SECRET`.
2. **Add products** — *Messenger* and *Instagram* (Instagram API with Facebook Login / "Messenger API for Instagram").
3. **Page access token** — best practice is a non-expiring **System User** token: Business Settings → *Users → System users* → add (Admin) → *Assign assets*: the Page (full control) and the app → *Generate token* for the app with permissions `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages`, `business_management`. Put it in `META_ACCESS_TOKEN`. (Optionally set `META_PAGE_ID`.)
4. **Allow Instagram message access** — in the Instagram app: *Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages* = ON.
5. **Webhooks** — choose any random string as `META_VERIFY_TOKEN` and deploy first (the endpoint must be live). Then:
   - *Messenger → Settings → Webhooks*: Callback URL `https://YOUR-DOMAIN/api/webhooks/meta`, Verify token = `META_VERIFY_TOKEN`. Subscribe the Page to fields **`messages`**, **`messaging_postbacks`**, **`message_echoes`**.
   - *Instagram → Webhooks* (object **instagram**): same callback URL and verify token; subscribe to **`messages`** and **`messaging_postbacks`**.
   - `message_echoes` lets the system notice when staff reply from Meta Business Suite / the Instagram app — the AI then pauses automatically.
6. **Go live** — while the app is in *Development* mode only people with a role on the app can message it. For real customers switch the app to **Live** and complete **App Review** for **Advanced Access** to `pages_messaging` and `instagram_manage_messages` (plus **Business Verification**). Also request the **Human Agent** permission so staff can reply up to 7 days after a customer's last message (the dashboard uses the `HUMAN_AGENT` tag automatically after 24 h).

Instagram Login alternative: if you use *Instagram API with Instagram Login* instead, put the Instagram user token (`IG…`) in `INSTAGRAM_ACCESS_TOKEN` and the account id in `INSTAGRAM_ACCOUNT_ID`; the adapter then sends via `graph.instagram.com`.

Security: every webhook POST is verified with HMAC-SHA256 (`X-Hub-Signature-256`) using `META_APP_SECRET`; unsigned or wrongly signed requests get `401`.

## 8. WhatsApp Business Cloud API setup

1. In the same Meta app (or a separate one) add the **WhatsApp** product; connect/create a **WhatsApp Business Account** and register Isolation's business phone number (it must not be active in the regular WhatsApp app).
2. *WhatsApp → API Setup*: copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. Permanent token: Business Settings → *System users* → assign the WhatsApp account + app → *Generate token* with `whatsapp_business_messaging` and `whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`. (The 24-hour temporary token on the API Setup page is only for testing.)
4. *WhatsApp → Configuration → Webhook*: Callback URL `https://YOUR-DOMAIN/api/webhooks/whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN`; subscribe to the **`messages`** field.
5. If WhatsApp is in a *different* Meta app than Messenger/Instagram, set that app's secret in `WHATSAPP_APP_SECRET` (signature verification).
6. Complete Business Verification and set the display name so you can message customers beyond the test limits.

Notes: replies are free-form text inside WhatsApp's **24-hour customer-service window** (the AI only ever replies to inbound messages, so it is always inside the window). Staff replies after 24 h need an approved template — the dashboard shows the delivery failure. On WhatsApp the sender's phone number is verified by WhatsApp itself, so customers there can look up their orders by phone alone, and profiles are merged across channels only on this verified phone.

## 9. Deploy to Vercel

1. Push this repository to GitHub and **Import** it in Vercel (framework: Next.js; defaults are fine — `vercel-build` runs `prisma generate`, then `scripts/db-setup.mjs` (migrations + idempotent seed that never overwrites dashboard edits), then `next build`). If the database settings are missing or the database can't be reached, the build still deploys and the login page / `/api/health` say exactly what to fix; if the database is reachable but a migration fails, the build stops so a broken schema never goes live.
2. *Settings → Environment Variables*: add every variable from `.env.example` that you use (Production + Preview). `APP_URL` = your production URL.
3. Deploy. Open `https://YOUR-DOMAIN/api/health`: `"ok": true` means database and session secret are fine; otherwise `problem` says exactly which setting to fix (it never shows values).
4. **Admin login** — if `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` are set in Vercel, the build creates that admin account (and loads the knowledge-base starter entries) automatically on the first deploy — just sign in at `/login`, then remove `ADMIN_INITIAL_PASSWORD` from Vercel. Otherwise open `https://YOUR-DOMAIN/setup`, paste the value of `NEXTAUTH_SECRET` as the *setup key* and choose a password (works only while no admin exists).
5. Configure the Meta and WhatsApp webhooks with your production domain (§7, §8).
6. **Cron**: `vercel.json` schedules `/api/cron/maintenance` daily (Hobby plan limit). Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set. On Pro, change the schedule to every 10 minutes (`*/10 * * * *`) for faster retry of failed deliveries; or call the endpoint from any external scheduler with that header.
7. Function duration: webhook routes declare `maxDuration = 60` s (AI processing runs after the 200 response).

Preview deployments share the environment variables you assign to *Preview* — point them at a separate database if you don't want previews to touch production data.

## 10. How the AI works

**System prompt** — `src/lib/ai/prompt.ts`: the exact core instruction you specified (`CORE_SYSTEM_PROMPT`) + operating rules (grounding, orders, tracking, escalation, style, voice examples) + live business data (delivery zones/fees/times, enabled payment methods), brand knowledge, extra instructions from the dashboard, and conversation context (pending order summary, facts verified earlier in the chat). The catalogue is **not** in the prompt — products come from Shopify tools.

**Tools** (`src/lib/ai/tools.ts`) — the model can only act through these, each with strict zod validation:

| Tool | Purpose |
|------|---------|
| `search_products(query, max_price?, only_available?)` | live catalogue search (available only by default) |
| `get_product(product_id)` | variants, sizes, colours, prices, stock hint, link, image |
| `check_inventory(variant_id)` | live stock of one variant |
| `get_delivery_info(area?)` | configured fees and (if set) delivery times |
| `get_payment_methods()` | enabled methods + official instructions |
| `get_policy(topic)` | official policy or `available:false` → handoff |
| `get_faq(question)`, `get_promotions()` | knowledge base |
| `get_order(order_number, phone)` | status only after ownership verification |
| `create_draft_order(...)` | prices from Shopify, totals computed in code, summary text |
| `confirm_order(draft_id)` | places the order — refused unless the customer explicitly confirmed in a later message |
| `cancel_draft_order()` | discard an unconfirmed summary |
| `request_human(reason, summary)` | handoff |
| `get_customer_history()` | this customer's own chat orders |

**Deterministic layers that never depend on the model:**

1. *Credentials*: OTPs, PINs, passwords, CVVs and card numbers are redacted **before** storage and before the model sees the text; the customer gets a safety warning.
2. *Guards* (`guards.ts`): explicit human request, anger/abuse, refund, special-discount request, cancellation, payment problem, repeated dissatisfaction → fixed, localized reply + handoff. Each trigger (except human request) can be toggled in *Settings → AI → Human handoff*. Note: "Admin vai, …" greetings are *not* treated as a human request.
3. *Overrides*: if Shopify fails → "One moment — I'm having trouble checking that right now. I'll get our team to confirm it." + handoff. If order creation fails → "couldn't complete automatically" + handoff (never "confirmed"). If OpenAI fails → a polite holding message + handoff (never an empty/broken message).
4. *Grounding check* (`validate.ts`): every ৳ amount, percentage and delivery-time in the reply must appear in Shopify results or configured data (sums and quantity multiples allowed); "your order is confirmed" is only allowed after a successful `confirm_order`. Otherwise the reply is replaced by "Let me get that confirmed for you…" and the conversation is handed to a human.

**Language**: English / Bangla script / Banglish are detected per message (short replies like "ok" inherit the conversation language); the model mirrors it, and fixed replies exist in all three.

**Conversation memory**: last N messages (configurable) plus compact "verified facts" from earlier tool results are provided on each turn; bursts of messages are coalesced into one reply.

## 11. Admin dashboard

`/login` → `/admin`. Roles: **ADMIN** (everything) and **AGENT** (conversations, customers, orders, products, test chat — cannot change settings, knowledge base or staff).

- **Conversations** — Instagram / Messenger / WhatsApp, customer, last message, status (`AI_ACTIVE`, `HUMAN_REQUIRED`, `HUMAN_ACTIVE`, `RESOLVED`), AI/human, timestamp; filters + search; auto-refresh. Red counter = conversations needing a human.
- **Conversation view** — full history, handoff reasons, draft orders, tool calls; **Take over**, **Return to AI**, **Mark resolved**, **Flag for human**, and reply as the team (replying takes over automatically).
- **Customers** — name, phone (verified/unverified), channels, previous conversations, orders, total orders, last order, tags, notes.
- **Orders** — orders created through chat, failed submissions (with the collected details), and a Shopify order lookup.
- **Products & stock** — live Shopify catalogue with per-variant stock.
- **Knowledge base** — policies, FAQs, promotions, brand facts, extra AI instructions.
- **Settings** — delivery charges/times/areas, payment methods & instructions, AI on/off, auto-reply, tone, language behaviour, order-creation mode, handoff triggers & notifications, business info.
- **Analytics** — conversations, messages, AI responses, handoffs (by reason), orders, conversion rate, most requested products, most common question topics, failed queries, average response time, per-channel performance. Only aggregates are stored (no message text or phone numbers); test traffic is excluded.
- **Integrations** *(admin)* — connect OpenAI, Shopify, the Meta app, Messenger, Instagram and WhatsApp: paste keys, test each connection, copy webhook URLs and verify tokens, or let the dashboard set up the Meta webhooks. See [§3](#3-what-you-must-provide-credentials--decisions).
- **Staff accounts** — add staff, change roles, disable, reset passwords.

## 12. Test chat

`/test-chat` (staff only) runs the **exact production pipeline** on an internal `TEST` channel — nothing is sent to Meta/WhatsApp. For every turn it shows the customer message (and its redacted stored form), triggered guards, **tool calls with inputs and Shopify outputs**, the grounding-check result, the raw model reply if it was overridden, the final AI response and the handoff status.

Data source selector: mock catalogue (seed data), mock *out of stock*, mock *Shopify down*, mock *order creation fails*, or **live Shopify** (real data — orders created there are real). A "channel-verified phone" field simulates WhatsApp. Sample buttons cover every scenario from the brief (price, colour, size, similar items, delivery, COD, ordering, confirmation, order tracking, other customer's order, cancel, refund, exchange, discount, human, Bangla, Banglish, OTP, unknown product).

## 13. Security

- **Secrets** only from environment variables (`src/lib/env.ts`, validated with zod); nothing hard-coded; `.env*` is git-ignored.
- **Webhook authenticity**: HMAC-SHA256 signature verification on the raw body (constant-time compare); verify-token handshake; 512 KB body limit.
- **Idempotency**: every Meta/WhatsApp message id is recorded in `ProcessedEvent`; duplicates are acknowledged but never processed twice. Each inbound message is also claimed atomically before the AI runs, and order confirmation uses an atomic state transition — no double replies, no double orders.
- **Authentication**: bcrypt (cost 12) password hashes, HS256-signed session cookie (httpOnly, Secure, SameSite=Lax, 12 h), middleware gate + per-route checks, account deactivation takes effect immediately.
- **Authorization**: ADMIN vs AGENT roles; settings, knowledge base and staff management are ADMIN-only; audit log for logins, settings, knowledge, customer edits, handoff actions and order lookups.
- **CSRF**: state-changing staff APIs require a same-origin `Origin` header.
- **Rate limiting** (Postgres-backed, works on serverless): per-customer (12/min, 120/h), AI replies per conversation (60/h, loop protection), webhooks per IP, login per IP and per email (brute-force protection), staff APIs and test chat.
- **Input validation**: zod schemas on every API body and every AI tool call; Shopify search terms escaped; Prisma parameterized queries only.
- **Customer data protection**: order details only after order number + matching phone (or WhatsApp-verified phone); identical response for "not found" and "wrong phone" (no enumeration); phone numbers never returned to the model; cross-channel profiles merged only on a verified phone; test identities never merged into real customers; handoff notifications contain no message text or phone numbers.
- **Credential hygiene**: OTP/PIN/password/card data redacted before storage; the AI never asks for them; logs are structured JSON passed through a redactor (tokens, keys, `Bearer …`, `shpat_…`, `sk-…`, `EAA…` are masked). Graph API tokens are sent in the `Authorization` header, never in URLs.
- **HTTP headers**: HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy; dashboard is `noindex`.

Operational recommendations: rotate tokens if they are ever exposed; use System User tokens scoped to only the Page/WhatsApp assets; give staff AGENT accounts unless they need settings; keep `ADMIN_INITIAL_PASSWORD` out of the environment after seeding; enable Supabase backups.

## 14. Testing

```bash
# needs a PostgreSQL test database (default: postgresql://isolation:isolation@localhost:5432/isolation_test,
# override with TEST_DATABASE_URL); migrations are applied automatically
npm test
npm run typecheck
npm run build
```

62 tests cover: product price from Shopify (Banglish), blocked hallucinated price, no invented colours, no out-of-stock recommendations, unknown product → confirm + handoff; delivery fees from config (and after an admin change), no invented delivery time, configured delivery time allowed; full order flow (summary → refusal without explicit confirmation → confirmed order with Shopify prices → no duplicate order), false "order confirmed" claim blocked, Shopify order failure → handoff, out-of-stock / invalid phone / disabled payment method; order lookup privacy (wrong phone, missing phone, phone-only, correct), WhatsApp phone-only lookup, repeated dissatisfaction; refund / cancel / discount / human / anger / payment problem handoffs without calling the model; Bangla & Banglish handoff replies; human takeover, return to AI, native-inbox echo pause; OTP redaction, Shopify outage, Meta delivery failure, OpenAI failure, empty reply, invalid tool arguments, duplicate webhook events, message bursts, rate limiting, identity merging; webhook signature and handshake; session tokens; parsers, language detection, phone normalization and the grounding validator.

The model is replaced by a scripted model in automated tests (deterministic). Use `/test-chat` with your real `OPENAI_API_KEY` to evaluate real model behaviour and tone before going live.

## 15. Operations & troubleshooting

- **Handoff alerts**: set a Slack/Discord incoming-webhook URL (Settings → AI or `HANDOFF_WEBHOOK_URL`) and/or Resend email.
- **Failed deliveries** (Meta/WhatsApp API errors) are retried with backoff immediately, then by the maintenance cron (up to 4 attempts within 24 h); the conversation is flagged for a human and the failure is shown in the thread.
- **Recovery**: the cron also processes any inbound message whose background AI run never happened (e.g. function killed).
- **Kill switch**: Settings → AI → uncheck *AI enabled* or *Auto-reply* — new messages then go straight to `HUMAN_REQUIRED`.
- **Logs**: structured JSON in Vercel → Logs (secrets redacted). `LOG_LEVEL=debug` for more detail.
- Webhook not verifying? The verify token must match exactly and the deployment must be live. Messages not arriving? Check the Page is subscribed to the app (`messages` field), the Instagram "Allow access to messages" toggle, and that the app is Live with Advanced Access.

### Can't sign in?

| What you see | Fix |
|---|---|
| "No admin account exists yet" | Click **Create the admin account** (or open `/setup`) |
| "NEXTAUTH_SECRET is not set / too short" | Add a random value of 32+ characters in Vercel → Settings → Environment Variables, then **Redeploy** (env changes need a redeploy) |
| "cannot connect to the database" / "tables have not been created" | Check `DATABASE_URL` / `DIRECT_URL` (correct password, pooler URL on 6543 with `?pgbouncer=true`), then redeploy |
| "Setup key is wrong" | Paste the exact `NEXTAUTH_SECRET` value — no spaces or quotes |
| "Invalid email or password" | Wrong password; another admin can reset it (Staff accounts), or run `npm run admin:create -- you@email ADMIN` |
| "Too many attempts" | Wait 15 minutes (brute-force protection) |
| Login "succeeds" but you land on /login again | You're on plain `http://` on a non-local address, or cookies are blocked — use the https Vercel URL |

## 16. Before going live — checklist

- [ ] Fill in return / exchange / refund / cancellation / warranty policies (Knowledge base) — or leave empty to always hand off
- [ ] Confirm Cash on Delivery wording; enable any other payment methods with official instructions
- [ ] Add estimated delivery times per zone (or leave empty) and the suburb/inside-Dhaka area lists
- [ ] Add business hours, support contact, Facebook page and WhatsApp number
- [ ] Verify products/variants/stock in Shopify are accurate (the AI trusts Shopify)
- [ ] Place a test order via /test-chat in **live** mode with *Order creation mode = draft only*, check it in Shopify, then choose the final mode
- [ ] Set up handoff notifications and make sure staff know the dashboard workflow
- [ ] Meta App Review (Advanced Access, Human Agent), Business Verification, WhatsApp number registration
- [ ] Set `CRON_SECRET` and confirm `/api/cron/maintenance` runs

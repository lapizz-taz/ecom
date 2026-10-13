# Fullfilio — Security Audit (Round 2)

Source-first security audit run with the Cloudflare `security-audit` skill
(reconnaissance → coverage-led hunting → validation → fix). Scope: the whole
`commerce/` application — React SPA, Cloudflare Worker, Supabase Postgres (RLS +
~970 SECURITY DEFINER functions), 22 Deno edge functions, the WooCommerce
plugin, and the VoiceDrive PBX gateway.

Method: an architecture + trust-boundary map, then five parallel hunters over 20
coverage units (RBAC, platform authz/approvals, tenancy, storefront checkout &
leakage, payment callbacks, courier/PBX webhooks, outbound SSRF, channels,
identity, staff edge handlers, API keys, worker/file access, telephony/SMS
spend, client-side/XSS, crypto, obvious exposures, supply chain, wildcard).
Findings were verified against source and, where useful, in an offline
sandbox (private Postgres built from the migrations); no live or deployed
endpoints were probed.

## Headline result

**No critical or high, source-confirmed, exploitable vulnerability was found.**
The multi-tenant model is implemented with real depth: every tenant table has a
RESTRICTIVE `tenant_isolation` policy, and because the business
`SECURITY DEFINER` functions are owned by `app_owner` (a `NOBYPASSRLS` role that
owns only functions, not tables), row-level security still applies *inside* those
functions. Webhook/HMAC checks are constant-time with timestamp-skew and
idempotency; payments are confirmed only after server-side gateway verification;
Clerk session JWTs are verified with a pinned RS256 key taken from the server's
own instance JWKS; signed file links are merchant-scoped with a hardening CSP.

One finding was medium; the rest were low or informational. All have been fixed
and deployed.

## Fixed in this round

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | medium | Public checkout **quote** started a *paid* BD-courier fraud lookup per phone; an anonymous flood could drain a store's courier credits and then make COD fraud screening fail-open for the rest of the month. | Quote reuses a cached check but no longer starts a new paid lookup; the authoritative lookup runs at order placement (low volume). `checkout-flow.ts` |
| 2 | low | `appBase()` built invite/password-reset link bases from the request `Origin` header when `APP_URL`/`PLATFORM_URL` were unset — a forged Origin could capture a one-time token. | Origin trusted only when allow-listed (`ALLOWED_ORIGINS`, never `*`). `storefront.ts` |
| 3 | low | `merchant_access_mode(uuid)` honoured a caller-supplied merchant id for anyone → a signed-in user could read another store's suspension/subscription state. | Caller-supplied id honoured only for system callers and platform staff; a merchant user resolves to their own merchant. (DB) |
| 4 | low | PBX click-to-call had no per-user limit → an order viewer could robo-dial arbitrary numbers at the merchant's minute cost. | Per-user rate limit on the call action. `pbx/handler.ts` |
| 5 | low | Merchant-settable outbound URLs (payment gateway, Steadfast, WooCommerce store, SMS gateway) lacked a private-host (SSRF) guard; WooCommerce accepted an `https://<private-IP>` store URL. | Shared `isPublicHttpUrl` guard (blocks RFC1918/loopback/link-local/metadata/IPv6/credentials) wired into every staff-settable sink; SMS uses it too. `net.ts`, `woocommerce.ts`, `payments/registry.ts`, `courier/registry.ts`, `sms/providers.ts`, `pbx.ts` |
| 6 | low | `sms_log_test` / `meta_account_save` per-merchant checks were implicit (relied on RLS). | Explicit `merchant_id = current_merchant_id()` so they are correct even for definer functions that bypass RLS. (DB) |
| 7 | low | `@clerk/clerk-react` 5.61.3 carried a HIGH advisory (GHSA-w24r-5266-9c3c). App authz is backend-enforced, so exposure was limited. | Bumped to 5.61.10; `npm audit --omit=dev` → 0 vulnerabilities. |
| 8 | info | `_vd_cfg()` / `_store_root_domain()` were PUBLIC-executable (non-secret config). | Revoked public/anon/authenticated execute. (DB) |
| 9 | info | `http` fraud provider was built without the usage meter. | Wrapped in the meter like `courier_history`, so it can never make unmetered paid calls. `fraud/service.ts` |

A prior finding (F-008: functions left PUBLIC-executable by a per-schema default)
was already remediated in migration `20261109002100` and confirmed live.

## Deploy

- **Database (live Supabase):** migration `20261109002600_security_hardening.sql`
  applied and verified; the approval-gated `_tenancy_own_functions()` L2
  re-ownership was **not** run. No new Supabase security advisory.
- **Worker (Cloudflare):** edge-code fixes shipped via the
  `claude/sweet-lovelace-ilswnx` build branch.

## Remaining (owner to decide / deployment facts outside source)

- A real **Content-Security-Policy** (`script-src`/`default-src`) is not yet set
  in `public/_headers` — recommended as defense-in-depth on the shared
  storefront/admin origin (needs runtime verification so it doesn't break
  Clerk/Sentry/Vite).
- Deployment facts to confirm: the Clerk instance verifies email ownership
  before marking an address verified; Supabase GoTrue password sign-up is
  disabled so Clerk is the sole credential path.
- The approval-gated L2 re-ownership (357 remaining postgres-owned functions →
  `app_owner`) still needs explicit owner approval before running on live.

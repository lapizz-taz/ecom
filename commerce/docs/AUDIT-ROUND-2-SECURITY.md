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

---

# Round 3 — Attack simulation (privilege escalation, frontend, DoS)

A second, offensive pass simulated a determined attacker across three fronts.
Scope and rules were unchanged: source-first, no live probing of deployed
endpoints, no real DoS against production, detailed repro kept out of the repo.

## Results by attack class

- **Privilege escalation to admin / cross-tenant:** none found. Staff handlers
  run service-role but filter by `merchant_id`; SECURITY DEFINER functions are
  `app_owner` (NOBYPASSRLS) so RLS still applies inside them; the
  platform-staff gates (`is_platform_staff()`, `is_system_context()`) hold. The
  round-2 `merchant_access_mode` / `sms_log_test` / `meta_account_save` gaps
  were already closed in `20261109002600`.
- **Frontend takeover / XSS:** none found. React escaping is intact, URL
  sanitisation is unconditional, and there is no `dangerouslySetInnerHTML` on
  untrusted input. The only gap was the absence of an enforced CSP — shipped
  **report-only** first so it can be validated live before enforcing (Clerk on
  the custom domain + direct-Supabase calls can't be exercised from the audit
  sandbox).
- **Denial of service:** no critical/high. The findings that were in scope for
  the live (Supabase-backed) product were fixed (below). Several theoretical DoS
  surfaces live only in the **staging-only** Cloudflare database engine
  (single Durable Object statement budget, realtime socket caps, upload quotas)
  and are tracked for the DB switch-over, not the live product.

## Fixes shipped this round

| # | sev | issue | fix |
|---|-----|-------|-----|
| 1 | low | PostgREST `select`/logic-tree could nest arbitrarily deep → stack/CPU burn in the single-threaded engine. | Depth cap (40) in `worker/db/rest/parse.ts`. |
| 2 | low | User-supplied regex (`match`/`imatch`, `regexp_*`) could backtrack catastrophically. | 1000-char pattern cap in `worker/db/pg/builtins.ts`. |
| 3 | low | PBX webhook read the Vault secret before validating the token's shape, so junk tokens forced a DB/Vault read each request. | Reject non-48-hex tokens before the read, in `pbx/handler.ts`. |
| 4 | medium | A storefront visitor rotating random `visitor_id`s could flood `checkout_leads` for one merchant (the upsert only dedupes a repeat of the *same* visitor). | Per-merchant cap on **new** lead rows (existing open leads still update) + supporting partial index. `capture_checkout_lead` (DB). |
| 5 | low | The public-facing coturn container received the whole gateway `.env`. | Narrowed to the three TURN variables only. `pbx-gateway/docker-compose.yml`. |

## Deploy (round 3)

- **Database (live Supabase):** `capture_checkout_lead` redefined and
  `checkout_leads_merchant_open_idx` created; function verified still
  `app_owner` + SECURITY DEFINER (RLS applies inside). No L2 re-ownership run.
- **Worker (Cloudflare):** parse/regex/PBX fixes + the report-only CSP shipped
  via the `claude/sweet-lovelace-ilswnx` build branch.
- **Regression:** 366 unit tests, app+worker typecheck, edge-function deno
  check, and the Cloudflare production build all pass. The 3 failing
  Cloudflare-DB replay tests are pre-existing engine feature gaps (cross-schema
  views, RLS-inside-definer), unchanged by this round and confirmed failing on a
  clean tree.

## Remaining (owner to decide)

- Flip the CSP from **report-only** to **enforcing** after a live console check
  shows no legitimate request is blocked.
- Staging-only Cloudflare-DB DoS surfaces (statement budget, realtime socket
  cap, per-merchant upload quota) to be handled at the DB switch-over (D1-8).
- The approval-gated L2 re-ownership still needs explicit owner approval.

---

# Round 4 — Full re-audit (cloudflare/security-audit-skill, run-2)

A second full pass with the installed security-audit skill: 5 isolated hunters
(DB tenancy/money, edge authz/cross-tenant, Cloudflare Worker PG engine,
integration SSRF/payments, frontend) over the whole app at commit 8d150a9,
building on run-1. Source-first, sandbox-only, no live probing. Every confirmed
finding was independently re-verified before fixing.

## Confirmed and fixed

| # | sev | finding | fix |
|---|-----|---------|-----|
| R2-01 | high | `domains/handler.ts` ran the shared Cloudflare/Vercel add/remove/check on the staffer-supplied domain BEFORE any merchant-ownership check — a merchant could detach another merchant's live custom domain (cross-tenant DoS). | New `store_domain_guard(domain, action)` (explicit `merchant_id = current_merchant_id()` check) called before every provider mutation; `add` claims via the global-unique domain so a domain held by another store is refused. (DB + handler) |
| R2-02 | high* | PostgREST logic-tree parser `parseLogicItem` used an ambiguous `(?:"[^"]*"|[^.])+?` alternation → catastrophic regex backtracking on a crafted `?or=("""…)` string (48 quotes ≈ 16 s), pinning the single-threaded engine before any auth check. | Replaced with a linear first-unquoted-dot scan (O(n); 100k quotes now < 3 ms). `worker/db/rest/parse.ts`. *Staging-only today (engine returns 503 in prod); live at the Cloudflare switch-over. |
| R2-03 | medium | `platform-admin/handler.ts` still derived the invite/reset link base from the raw `Origin` header (the run-1 Origin-hardening missed this one file). | Use the allow-listed `appBase(req)`, like the other handlers. |
| R2-04 | medium | WooCommerce client used `redirect:'follow'` on the merchant-controlled store URL — a 3xx to an internal address would be chased (SSRF); the per-hop re-validation believed fixed in round 2 was never actually implemented. | New `safeFetch` (manual redirects, each hop re-checked with the SSRF guard) wired into the Woo client. `net.ts`, `woocommerce.ts`. |
| R2-05 | low | `domain-check.ts` TLS probe hit `https://<merchant-domain>/` with no guard on the resolved IP — a domain pointed at an internal address became an SSRF oracle. | Skip the probe when the domain resolves (A/AAAA) to a private/loopback/ULA address (`isPrivateIp`). |
| R2-06 | low | Clerk token check enforced `azp` only when the claim was present and never required it. | Require `azp` present and allow-listed when authorized parties are configured. `clerk.ts`. |
| R2-07 | low | Theme-preview `theme-navigate` accepted a `//evil.com` path (protocol-relative open redirect; latent — nothing sends that message). | Reject `//` and `/\` paths. `theme.ts`. |

## Re-verified clean (no change needed)

- **DB:** all run-1 fixes confirmed present and complete (merchant_access_mode,
  sms_log_test, meta_account_save, `_vd_cfg`/`_store_root_domain` grants); the
  new `capture_checkout_lead` cap is sound; no cross-tenant SECURITY DEFINER
  path, no self-credit / unverified-paid / ledger-deletion money path, no
  merchant→platform_staff escalation, destructive RPCs properly gated.
- **Edge:** every service-role staff read carries a `merchant_id` filter; the
  external API refuses secret keys from a browser and enforces scopes; the new
  PBX webhook token gate is correct; all webhooks verify signatures (constant
  time) before privileged logic.
- **Worker engine:** no SQL injection (bound params throughout), no RLS-shadow
  bypass, `current_merchant_id` not caller-overridable, no JWT alg confusion.
- **Frontend:** no `dangerouslySetInnerHTML`/`eval`, print-frame re-serializes
  escaped DOM, postMessage origins pinned, the main.tsx fragment-strip holds,
  only public keys shipped, Sentry sends no tokens/PII.

## Deploy (round 4)

- **Database (live Supabase):** `store_domain_guard` applied; no L2 re-ownership
  run. Correct regardless of function ownership (explicit merchant comparison).
- **Worker/edge (Cloudflare):** parser, SSRF, Origin, azp and theme fixes via
  the `claude/sweet-lovelace-ilswnx` build branch.
- **Regression:** 366 unit tests, app+worker typecheck, edge deno check, and the
  Cloudflare production build all pass; the Cloudflare-DB replay shows only the
  3 pre-existing engine-gap failures (unchanged by this round).

## Remaining (owner / needs validation)

- Staging-only Worker-engine items for the DB switch-over: a regex *subject*-
  length / step budget (the pattern-length cap alone is incomplete, but no
  attacker-controlled-pattern path exists today), realtime concurrent-socket
  cap, and immediate-logout token revocation (currently matches Supabase's
  stateless model).
- The report-only CSP still awaits one live console check before enforcing.
- The approval-gated L2 re-ownership still needs explicit owner approval.

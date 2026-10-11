# Architecture

How the Fullfilio code is organised, where each kind of code belongs, and the
conventions that keep it that way. The rules marked **(checked)** are enforced
by `src/architecture.test.ts`, which runs with the unit tests.

## The pieces

| Part | Where | What it does |
|---|---|---|
| Web app | `src/` | One React app serving four audiences: the Fullfilio website, each business's online store, the merchant admin, and the Super Admin panel. |
| Database | `supabase/migrations/` | PostgreSQL with row-level security. All business rules live here as functions (order states, stock ledger, payments, fraud rules, permissions, audit log). |
| Edge functions | `supabase/functions/` | Deno functions for anything that needs a secret or talks to an outside service (payments, couriers, Shopify/WooCommerce, SMS, ads, domains, the public API). |
| PBX gateway | `pbx-gateway/` | Asterisk + controller for VoiceDrive calling (deployed separately). |
| WooCommerce plugin | `integrations/woocommerce/` | The "Fullfilio Connect" WordPress plugin (`npm run build:woo-plugin`). |
| Tests | `src/**/*.test.ts`, `supabase/functions/**/*.test.ts`, `supabase/tests/db/` | Unit tests, and database tests that run against a real Postgres. |

Which audience a visitor gets is decided once at start-up (`src/main.tsx` →
`storefront_resolve` / `storefront_resolve_slug`): the platform's own address
shows the website, `/s/<store>`, a store subdomain or a custom domain shows that
store, and an unknown store shows a "not available" page. `src/routes/router.tsx`
then builds the matching set of routes.

## Front-end layers

```
pages/        one file per route: layout of the screen, wiring only
  └─ features/  UI building blocks for one area (orders, couriers, website, site, …)
       └─ hooks/      shared React hooks (store config, staff names, URL state, …)
            └─ services/   all data access: one module per business area
                 └─ lib/       framework-free helpers: env, errors, formatting, supabase client
types/        shared types (generated database types in types/database.ts)
components/   design system: ui/ (shadcn primitives), common/ (page header, states, dialogs), brand/
layouts/      admin, Super Admin and storefront shells
routes/       the router and route guards
```

Rules:

- **Screens never talk to the database.** Pages, features, components, layouts
  and hooks call functions in `src/services/`; only services use the Supabase
  client for data. **(checked)**
- **Services are UI-free.** They don't import from pages, features, components
  or layouts, so they can be reused anywhere and tested on their own. **(checked)**
- **Business rules belong in the database**, not in React. A service calls a
  database function (RPC) that checks permissions and validates the change; the
  UI only decides what to show. Hiding a button is never the security boundary.
- `features/site/` is the product website (demos, mock-ups); `features/marketing/`
  is the merchant's own marketing tools (ads, tracking). Keep them apart.

## Data access (the API structure)

There are three ways the app reaches the backend, all wrapped by `src/services/`:

1. **Database functions (RPC)**: `supabase.rpc('name', args)`. The default for
   anything that changes data. Names say who may call them:
   `storefront_*` (anyone, store visitors), `admin_*` / plain names (staff,
   checked with `require_permission`), `platform_*` (Super Admin staff, checked
   with `_platform_require`).
2. **Tables and views**: `supabase.from(...)` for simple reads and edits that
   row-level security already limits to the caller's own business.
3. **Edge functions**: `invokeFunction(name, body)` from `src/lib/functions.ts`
   (adds the business id and turns error bodies into readable errors), or
   `functionsUrl(path)` from `src/lib/env.ts` when a full address is needed
   (webhooks, OAuth callbacks).

Adding a feature that needs data:

1. Write the migration (`supabase/migrations/<timestamp>_<name>.sql`): tables
   with RLS, a `SECURITY DEFINER` function that checks permissions, explicit
   `grant execute`. End with `select public._tenancy_own_functions();`.
2. Add a database test in `supabase/tests/db/` (permissions and the main paths).
3. Add a typed function to the right `src/services/<area>.ts` (and the RPC to
   `src/types/database.ts` if the types weren't regenerated).
4. Use it from the screen through TanStack Query (`useQuery` / `useMutation`).

Edge functions follow the same shape: `supabase/functions/<name>/index.ts`
handles HTTP, `_shared/` holds the logic (providers, schemas, HTTP helpers,
`env.ts` for secrets), and every request runs through `handle()` in
`_shared/http.ts`, which maps errors to clean JSON responses and reports
unexpected ones.

## State

| Kind of state | Where it lives | Tool |
|---|---|---|
| Data from the server | Cached per query key, refetched when stale or invalidated | TanStack Query (`src/lib/query-client.ts`) |
| Who is signed in, their business and permissions | `AuthProvider` | React context (`features/auth/auth-context.tsx`) |
| The visitor's cart | Persisted in the browser | Zustand (`features/cart/cart-store.ts`) |
| Filters, tabs, search on list pages | The address bar, so links and Back work | `useUrlState` (`hooks/use-url-state.ts`) |
| Store theme, phone (VoiceDrive), Super Admin scope | Their own providers | React context |
| Complex local screens (demos, editors) | One reducer per screen | `useReducer` |
| Simple form and UI state | The component | `useState`, React Hook Form + Zod for forms |

Don't copy server data into local state: read it from the query and invalidate
the query after a change.

## Errors

- Database functions raise `CODE: message` (e.g. `VALIDATION: …`,
  `PERMISSION_DENIED: …`). `toUserMessage()` in `src/lib/errors.ts` shows only
  the message and never raw SQL; unknown errors become a generic sentence.
- Failures are handled centrally in `src/lib/query-client.ts`: every failed
  query or save is reported, an expired session signs the person out cleanly,
  and a failed save (mutation) shows a toast with the readable message (pass
  `meta: { silent: true }` when the screen shows the error itself). Failed
  reads show `<ErrorState>` with a retry button on the screen.
- `reportError()` (`src/lib/monitoring.ts`) sends unexpected errors to Sentry
  (when `VITE_SENTRY_DSN` is set) and to the Super Admin system log. Expected
  outcomes (validation, permissions, not found, rate limits) are not reported.
- Routes have an `errorElement`, so a crash shows a recovery screen, not a
  blank page.
- Don't swallow errors. `.catch(() => {})` is only acceptable for genuinely
  best-effort work (closing audio, a background job that also runs on a
  timer), with a comment saying so.

## Configuration

- Browser settings are `VITE_*` variables, read **only** in `src/lib/env.ts`
  **(checked)** and typed in `src/env.d.ts`. See `.env.example`. They are
  public by nature, so they hold no secrets.
- Secrets (service-role key, provider credentials, webhook secrets) are edge
  function secrets, read through `supabase/functions/_shared/env.ts`.
  Merchant-entered credentials are stored encrypted in Vault, never in a
  readable table.
- Business settings that change at runtime (store domains, plans, SMS prices)
  live in the database (`settings`, `platform_settings`), not in code.

## Sign-in (Clerk)

Clerk handles sign-up, the 6-digit e-mail code, sign-in (password or e-mail
code), password resets and sessions on the Fullfilio site and the staff pages
(`/admin`, Super Admin). Shoppers on a merchant's store keep the store's own
customer sign-in, because stores run on many domains.

The database still works with Supabase Auth users: every row-level rule, role
and staff record is keyed by their ids. So a Clerk session is exchanged for the
matching Supabase session:

1. The browser signs in with Clerk's own boxes: `<SignIn>` on `/admin/login`
   and `/start/finish`, `<SignUp>` in step 2 of `/start`, and `<UserButton>` as
   the account menu in the admin header. Shoppers on a merchant's store keep
   the store's own customer sign-in.
2. `ClerkSessionSync` (`features/auth/clerk.tsx`) sends the Clerk session token
   to the `clerk-auth` edge function.
3. The function checks the token's signature with Clerk's keys, reads the
   user's verified e-mail from Clerk's Backend API, finds or creates the
   Supabase user with that e-mail (linking `app_metadata.clerk_user_id`) and
   returns a one-time sign-in hash, which the browser turns into a session.

Accounts from before Clerk were imported into Clerk with their passwords.
New staff (`admin-users`) and new owners added by Super Admin (`platform-admin`)
get their Clerk account at once (`ensureClerkAccount` in `_shared/clerk.ts`).
Clerk organizations are not used (Fullfilio has its own businesses); the
`clerk-auth` `setup` action turns off Clerk's "choose an organization" step.

Configuration: `VITE_CLERK_PUBLISHABLE_KEY` (browser; empty = built-in
sign-in) and Clerk's secret key on the server only, as the `CLERK_SECRET_KEY`
edge secret or the platform credential `auth.clerk` in Vault.

## Naming

- Files and folders: `kebab-case` (`order-search.ts`, `theme-editor-demo.tsx`). **(checked)**
- Components: `PascalCase`; hooks: `useSomething`; services: verbs
  (`listCoupons`, `saveCoupon`, `deleteCoupon`); constants: `UPPER_SNAKE`.
- Database: `snake_case`; RPC prefixes as above; migrations
  `YYYYMMDDHHMMSS_short_name.sql`.
- User-facing text is plain English: say what happened and what to do next.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript, strict, no unused code |
| `npm run test:unit` | Unit tests, including the architecture checks |
| `npm run test:db` | Database tests (needs `TEST_DATABASE_URL`) |
| `npm run functions:check` | Type-checks every edge function with Deno |
| `npm run build` | Production build |

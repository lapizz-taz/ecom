/// <reference types="vite/client" />

// The VITE_* variables the app reads (all public; see .env.example and src/lib/env.ts).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_SUPER_ADMIN_PATH?: string
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string
  readonly VITE_CLERK_PROXY_URL?: string
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_RELEASE?: string
  readonly VITE_FUNCTIONS_URL?: string
  readonly VITE_FILE_STORE?: string
  /** "cloudflare" after the switch-over: the database answers on the site's own address. */
  readonly VITE_DATABASE_BACKEND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** This build's version (vite.config.ts), e.g. "2026-11-10T06:30Z+abc1234". Undefined in unit tests. */
declare const __APP_RELEASE__: string | undefined

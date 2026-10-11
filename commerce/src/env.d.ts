/// <reference types="vite/client" />

// The VITE_* variables the app reads (all public; see .env.example and src/lib/env.ts).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_SUPER_ADMIN_PATH?: string
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

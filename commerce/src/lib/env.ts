// Browser configuration, read once from the VITE_* variables at build time
// (see .env.example). Everything here ends up in the public JavaScript, so
// only public values belong here: the Supabase URL and anon/publishable key
// are safe to ship. Secrets (service-role key, provider credentials) live in
// edge function secrets and never reach the browser.
//
// Read configuration through `env` only; nothing else touches import.meta.env.

const read = (value: unknown) => String(value ?? '').trim()

const supabaseUrl = read(import.meta.env.VITE_SUPABASE_URL).replace(/\/+$/, '')
const supabaseAnonKey = read(import.meta.env.VITE_SUPABASE_ANON_KEY)
const superAdminPath = read(import.meta.env.VITE_SUPER_ADMIN_PATH)
const clerkKey = read(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  /** Both Supabase values are set; without them the app shows a setup screen. */
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey),
  /** Secret entry path for the Super Admin panel ("/xyz…"), or null when unset or malformed. */
  superAdminPath: /^\/[A-Za-z0-9_-]{8,64}$/.test(superAdminPath) ? superAdminPath : null,
  /** Clerk publishable key (pk_test_… / pk_live_…). Set: staff sign in with Clerk; empty: the built-in sign-in. */
  clerkPublishableKey: /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(clerkKey) ? clerkKey : null,
  sentry: {
    dsn: read(import.meta.env.VITE_SENTRY_DSN) || null,
    environment: read(import.meta.env.VITE_SENTRY_ENVIRONMENT) || import.meta.env.MODE,
    release: read(import.meta.env.VITE_RELEASE) || undefined,
  },
  isDev: import.meta.env.DEV,
} as const

/** Address of an edge function (plus any path or query after its name). */
export function functionsUrl(path: string): string {
  return `${env.supabaseUrl}/functions/v1/${path.replace(/^\/+/, '')}`
}

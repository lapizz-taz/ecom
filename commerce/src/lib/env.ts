// Browser configuration, read once from the VITE_* variables at build time
// (see .env.example). Everything here ends up in the public JavaScript, so
// only public values belong here: the Supabase URL and anon/publishable key
// are safe to ship. Secrets (service-role key, provider credentials) live in
// edge function secrets and never reach the browser.
//
// Read configuration through `env` only; nothing else touches import.meta.env.

const read = (value: unknown) => String(value ?? '').trim()

// "cloudflare" after the switch-over: the database (rest, auth, realtime) answers on the
// site's own address, the Worker; otherwise Supabase's (VITE_SUPABASE_URL).
const databaseBackend = read(import.meta.env.VITE_DATABASE_BACKEND)
const supabaseUrl = (databaseBackend === 'cloudflare' && typeof window !== 'undefined'
  ? window.location.origin
  : read(import.meta.env.VITE_SUPABASE_URL)).replace(/\/+$/, '')
const supabaseAnonKey = read(import.meta.env.VITE_SUPABASE_ANON_KEY)
const superAdminPath = read(import.meta.env.VITE_SUPER_ADMIN_PATH)
const clerkKey = read(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)
// Unset: the old default (production keys through /__clerk). Empty: Clerk on its own DNS (clerk.<domain>).
const clerkProxy = import.meta.env.VITE_CLERK_PROXY_URL === undefined ? undefined : read(import.meta.env.VITE_CLERK_PROXY_URL)
// Cloudflare builds (.env.cloudflare): functions on the site's own Worker, uploads on R2.
const functionsBase = read(import.meta.env.VITE_FUNCTIONS_URL).replace(/\/+$/, '')
const fileStore = read(import.meta.env.VITE_FILE_STORE)

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  /** Both Supabase values are set; without them the app shows a setup screen. */
  isConfigured: Boolean(supabaseUrl && supabaseAnonKey),
  /** Secret entry path for the Super Admin panel ("/xyz…"), or null when unset or malformed. */
  superAdminPath: /^\/[A-Za-z0-9_-]{8,64}$/.test(superAdminPath) ? superAdminPath : null,
  /** Clerk publishable key (pk_test_… / pk_live_…). Set: staff sign in with Clerk; empty: the built-in sign-in. */
  clerkPublishableKey: /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(clerkKey) ? clerkKey : null,
  /** Clerk's Frontend API through this site ("/__clerk"); "" when Clerk has its own DNS; undefined: the default. */
  clerkProxyUrl: clerkProxy,
  sentry: {
    dsn: read(import.meta.env.VITE_SENTRY_DSN) || null,
    environment: read(import.meta.env.VITE_SENTRY_ENVIRONMENT) || import.meta.env.MODE,
    release: read(import.meta.env.VITE_RELEASE) || undefined,
  },
  isDev: import.meta.env.DEV,
  /** Where the backend functions answer: the Worker's /functions/v1 on Cloudflare, else Supabase. */
  functionsBase: functionsBase || `${supabaseUrl}/functions/v1`,
  /** Uploads go to Cloudflare R2 (through the Worker) instead of Supabase Storage. */
  filesOnR2: fileStore === 'r2',
} as const

/** Address of a backend function (plus any path or query after its name), always absolute. */
export function functionsUrl(path: string): string {
  const base = env.functionsBase.startsWith('/') && typeof window !== 'undefined' ? `${window.location.origin}${env.functionsBase}` : env.functionsBase
  return `${base}/${path.replace(/^\/+/, '')}`
}

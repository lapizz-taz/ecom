// Reads configuration from Deno (edge runtime) or Node (unit tests).
// Secrets only ever live in edge function environment variables.

type EnvReader = { get(name: string): string | undefined }

function reader(): EnvReader {
  const deno = (globalThis as { Deno?: { env: EnvReader } }).Deno
  if (deno) return deno.env
  const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
  return { get: (name) => proc?.env[name] }
}

export function env(name: string): string | undefined {
  const value = reader().get(name)
  return value === undefined || value === '' ? undefined : value
}

export function requireEnv(name: string): string {
  const value = env(name)
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

/**
 * Public address of the backend functions, for links handed to browsers,
 * payment gateways and webhook senders. On Cloudflare the functions run in the
 * site's own Worker, so FUNCTIONS_URL is https://<site>/functions/v1; on
 * Supabase it defaults to <SUPABASE_URL>/functions/v1.
 */
export function functionsBase(): string {
  const set = env('FUNCTIONS_URL')
  if (set) return set.replace(/\/+$/, '')
  return `${(env('PUBLIC_SUPABASE_URL') ?? requireEnv('SUPABASE_URL')).replace(/\/+$/, '')}/functions/v1`
}

/** Which runtime is serving this request (System health). */
export function runtimeVersion(): string {
  const deno = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno
  if (deno?.version?.deno) return `Deno ${deno.version.deno}`
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  return nav?.userAgent === 'Cloudflare-Workers' ? 'Cloudflare Workers' : 'unknown'
}

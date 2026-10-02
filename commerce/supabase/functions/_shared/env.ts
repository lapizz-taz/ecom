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

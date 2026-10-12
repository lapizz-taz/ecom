import { requireEnv } from './env.ts'

type Caller = (name: string, init: RequestInit) => Promise<Response>

let local: Caller | null = null

/**
 * The Cloudflare Worker runs every function in one place and registers an
 * in-process caller here: no network hop, and no Worker fetching its own
 * address (which Cloudflare does not route back to the Worker).
 */
export function setLocalCaller(caller: Caller | null): void {
  local = caller
}

/** Calls another backend function from this one (in-process on Cloudflare, over HTTP on Supabase). */
export function callFunction(name: string, init: RequestInit): Promise<Response> {
  if (local) return local(name, init)
  return fetch(`${requireEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/${name}`, init)
}

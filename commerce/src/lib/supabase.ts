import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { merchantFetch } from '@/lib/merchant'
import type { Database } from '@/types/database'

// Every request names the store (x-merchant-id): see lib/merchant.ts.
export const supabase = createClient<Database>(
  env.supabaseUrl || 'http://localhost:54321',
  env.supabaseAnonKey || 'missing-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: merchantFetch } },
)

export type TypedClient = typeof supabase

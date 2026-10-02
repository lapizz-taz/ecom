import { FunctionsHttpError } from '@supabase/supabase-js'
import { AppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

/** Calls an edge function and surfaces its `{ error: { code, message } }` body. */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null
      throw new AppError(payload?.error?.message ?? 'Request failed', payload?.error?.code ?? 'ERROR', payload?.error?.details)
    }
    throw new AppError(error.message || 'Network problem — please try again', 'NETWORK')
  }
  return data as T
}

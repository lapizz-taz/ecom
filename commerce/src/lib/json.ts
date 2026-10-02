import type { Json } from '@/types/database'

/** Typed payloads → jsonb RPC arguments. */
export function asJson<T>(value: T): Json {
  return value as unknown as Json
}

/** jsonb RPC results → the documented shape (see src/types/domain.ts). */
export function fromJson<T>(value: Json | null | undefined): T {
  return value as unknown as T
}

// Shared pieces for ported functions: reading JSON payloads the way Postgres cast
// them, store settings, and running as a function's owner.
import { DbError, raise } from '../errors.ts'
import { Q } from '../q.ts'
import type { WriteEnv } from '../writer.ts'

export type Json = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const invalid = (type: string, v: unknown): never => {
  throw new DbError('22P02', `invalid input syntax for type ${type}: "${String(v).slice(0, 80)}"`)
}

/** p ->> 'key': JSON value as Postgres text (null stays null). */
export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** nullif(p ->> 'key', '') */
export const nonEmpty = (v: unknown): string | null => {
  const t = text(v)
  return t === '' ? null : t
}

/** nullif(trim(p ->> 'key'), '') */
export const trimmed = (v: unknown): string | null => {
  const t = text(v)?.trim()
  return t ? t : null
}

/** (p ->> 'key')::numeric — null when missing; '' and other text fail like Postgres. */
export function numeric(v: unknown): number | null {
  const t = text(v)
  if (t === null) return null
  const n = Number(t.trim())
  if (t.trim() === '' || !Number.isFinite(n)) return invalid('numeric', t)
  return n
}

/** (p ->> 'key')::int */
export function int(v: unknown): number | null {
  const t = text(v)
  if (t === null) return null
  if (!/^\s*[-+]?\d+\s*$/.test(t)) return invalid('integer', t)
  return Number(t)
}

/** (p ->> 'key')::boolean */
export function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  const t = String(v).trim().toLowerCase()
  if (['t', 'true', 'y', 'yes', 'on', '1'].includes(t)) return true
  if (['f', 'false', 'n', 'no', 'off', '0'].includes(t)) return false
  return invalid('boolean', v)
}

/** (p ->> 'key')::uuid */
export function uuid(v: unknown): string | null {
  const t = text(v)
  if (t === null) return null
  if (!UUID.test(t)) return invalid('uuid', t)
  return t.toLowerCase()
}

/** array(select jsonb_array_elements_text(…)) */
export function textArray(v: unknown): Array<string | null> {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw new DbError('22023', 'cannot extract elements from a scalar')
  return v.map(text)
}

/** jsonb_typeof(v) = 'array' */
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v)

/** The same function context, writing as a function owner would. */
export function asOwner(env: WriteEnv, owner: 'app_owner' | 'postgres' = 'app_owner'): Q {
  return new Q({ ...env, role: owner === 'postgres' ? 'service_role' : 'app_owner' })
}

/** public.get_setting(key) #>> path, '' as null. */
export function settingValue(q: Q, key: string, path: string[]): unknown {
  let v: unknown = q.setting(key)
  for (const k of path) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Json)[k] : Array.isArray(v) && /^\d+$/.test(k) ? v[Number(k)] : undefined
  if (v === undefined || v === null || v === '') return null
  return v
}

export const settingBool = (q: Q, key: string, path: string[], fallback: boolean) => bool(settingValue(q, key, path)) ?? fallback
export const settingNumeric = (q: Q, key: string, path: string[], fallback: number) => numeric(settingValue(q, key, path)) ?? fallback
export const settingText = (q: Q, key: string, path: string[], fallback: string) => text(settingValue(q, key, path)) ?? fallback

/** public.slugify */
export const slugify = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export { raise }

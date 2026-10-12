// TypeScript versions of Postgres business triggers, by trigger function name. Empty:
// the PL/pgSQL interpreter (pg/engine.ts) runs every trigger as written in the
// migrations; a port here would take precedence and must then match it exactly.
import type { TriggerImpl } from '../writer.ts'

export const triggers: Record<string, TriggerImpl> = {}

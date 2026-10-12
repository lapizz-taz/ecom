// TypeScript ports of the Postgres business triggers, by trigger function name.
// A table whose trigger has no port here refuses writes (NOT_PORTED) instead of
// silently skipping the rule; each module stage adds its ports.
import type { TriggerImpl } from '../writer.ts'

export const triggers: Record<string, TriggerImpl> = {}

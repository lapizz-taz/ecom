// The ported database functions, by name. Each module stage adds its own file.
import type { RpcImpl } from './index.ts'
import { core } from './core.ts'

export const functions: Record<string, RpcImpl> = {
  ...core,
}

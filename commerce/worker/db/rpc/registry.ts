// The ported database functions, by name. Each module stage adds its own file.
import type { RpcImpl } from './index.ts'
import { catalog } from './catalog.ts'
import { core } from './core.ts'
import { channelJobEnqueue } from '../triggers/catalog.ts'
import { asOwner } from './helpers.ts'

export const functions: Record<string, RpcImpl> = {
  ...core,
  ...catalog,
  channel_job_enqueue: ({ env, args }) => channelJobEnqueue(asOwner(env), args.p_channel_id as string, String(args.p_kind), args.p_ref_id as string,
    (args.p_payload ?? {}) as Record<string, unknown>, (args.p_delay_seconds as number | undefined) ?? 0),
}

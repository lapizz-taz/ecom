// Local-only: the real Worker (site + the 22 backend functions + the Cloudflare database) with the
// e2e database's seed/count helpers on top, so a browser can run the storefront checkout end to end
// without any external service. Never deployed.
import main from '../../worker/index.ts'
import e2e, { Database } from '../../worker/db/e2e/worker.ts'

export { Database }

export default {
  async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/__')) return e2e.fetch(req, env as never)
    return (main as { fetch(r: Request, e: unknown, c: ExecutionContext): Promise<Response> }).fetch(req, env, ctx)
  },
}

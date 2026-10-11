// Clerk's Frontend API through the live site's own address.
//
// Clerk's production instance needs its Frontend API on a domain we control.
// The site runs on a vercel.app address (no DNS records of our own), so Clerk
// is set to "proxy" mode: the browser talks to <site>/__clerk/..., vercel.json
// rewrites that here, and this function forwards it to Clerk with our secret
// key. The key stays on this server.
//
// The public proxy address (CLERK_PROXY_URL, the "proxy_url" of the auth.clerk
// credential, or PLATFORM_URL + /__clerk) must match "Proxy URL" in Clerk → Domains.
import { CLERK_FAPI, clerkProxySetting, clerkSecret, proxyRequest, proxyResponse } from '../_shared/clerk.ts'
import { handle, HttpError } from '../_shared/http.ts'

async function proxyUrl(): Promise<string> {
  const url = await clerkProxySetting()
  if (!url) throw new HttpError(503, 'Sign-in is not set up yet: no Clerk proxy address', 'NOT_CONFIGURED')
  return url
}

Deno.serve(
  handle(async (req) => {
    const path = new URL(req.url).pathname.replace(/^(?:\/functions\/v1)?\/clerk-proxy\/?/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer()
    const [target, init] = proxyRequest(req, path, await proxyUrl(), await clerkSecret(), body)
    let res: Response
    try {
      res = await fetch(target, { ...init, signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new HttpError(502, `Could not reach ${new URL(CLERK_FAPI).host}`, 'UPSTREAM_ERROR')
    }
    return proxyResponse(res)
  }),
)

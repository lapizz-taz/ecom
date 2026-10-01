import { NextResponse } from "next/server";
import { LIMITS, clientIp, rateLimit } from "./security/rateLimit";
import { safeEqual } from "./security/signature";
import { integrationEnv } from "./integrations";
import type { Env } from "./env";

/**
 * Meta's verification handshake against a verify token from the dashboard or environment.
 * Tries the cached value first, then a fresh read — Meta calls this moments after a token is
 * saved on the Integrations page, possibly on another server instance.
 */
export async function verifyHandshakeFor(req: Request, pick: (e: Env) => string | undefined): Promise<Response> {
  const first = verifyHandshake(req, pick(await integrationEnv()));
  if (first.status === 200 || new URL(req.url).searchParams.get("hub.mode") !== "subscribe") return first;
  return verifyHandshake(req, pick(await integrationEnv({ fresh: true })));
}

/** GET verification handshake used by Meta (Messenger / Instagram / WhatsApp). */
export function verifyHandshake(req: Request, expectedToken: string | undefined): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge && safeEqual(token, expectedToken)) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function webhookIpLimit(req: Request): Promise<Response | null> {
  const ip = clientIp(req.headers);
  const rl = await rateLimit(`webhook-ip:${ip}`, LIMITS.webhookPerIpMinute.limit, LIMITS.webhookPerIpMinute.window);
  return rl.allowed ? null : NextResponse.json({ error: "Too many requests" }, { status: 429 });
}

/** Max accepted webhook body size (Meta batches are small). */
export const MAX_WEBHOOK_BYTES = 512 * 1024;

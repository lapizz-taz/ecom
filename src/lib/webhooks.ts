import { NextResponse } from "next/server";
import { LIMITS, clientIp, rateLimit } from "./security/rateLimit";
import { safeEqual } from "./security/signature";

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

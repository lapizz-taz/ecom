import { after, NextResponse } from "next/server";
import { integrationEnv } from "@/lib/integrations";
import { logger, errorInfo } from "@/lib/logger";
import { verifyMetaSignature } from "@/lib/security/signature";
import { parseMetaWebhook } from "@/lib/channels/meta";
import { processConversation, receiveEcho, receiveInbound } from "@/lib/conversation/service";
import { retryDueForwards } from "@/lib/orders/forward";
import { MAX_WEBHOOK_BYTES, verifyHandshakeFor, webhookIpLimit } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Instagram DM + Facebook Messenger webhook (object = "instagram" | "page"). */
export async function GET(req: Request) {
  return verifyHandshakeFor(req, (e) => e.META_VERIFY_TOKEN);
}

export async function POST(req: Request) {
  const limited = await webhookIpLimit(req);
  if (limited) return limited;

  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  // 1. Verify the request really comes from Meta.
  const sig = req.headers.get("x-hub-signature-256");
  // Messenger (and Page-linked Instagram) sign with the Meta app secret; "Instagram API with Instagram
  // Login" signs with the Instagram app secret. Accept either — both belong to the same Meta app. The body
  // is not parsed to pick one, so nothing unverified is read first.
  const matches = (e: Awaited<ReturnType<typeof integrationEnv>>) =>
    [e.META_APP_SECRET, e.INSTAGRAM_APP_SECRET].some((secret) => secret && verifyMetaSignature(raw, sig, secret));
  const valid =
    matches(await integrationEnv()) ||
    // A secret may have just been changed on the dashboard: retry once with uncached values.
    matches(await integrationEnv({ fresh: true }));
  if (!valid) {
    logger.warn("meta webhook signature rejected");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 2–4. Identify channel + customer, store message (idempotent).
  const parsed = parseMetaWebhook(body as Parameters<typeof parseMetaWebhook>[0]);
  const toProcess: { conversationId: string; messageId: string }[] = [];
  try {
    for (const msg of parsed.messages) {
      const r = await receiveInbound(msg);
      if (!r.duplicate && r.conversationId && r.messageId) toProcess.push({ conversationId: r.conversationId, messageId: r.messageId });
    }
    for (const echo of parsed.echoes) await receiveEcho(echo);
  } catch (err) {
    logger.error("meta webhook storage failed", errorInfo(err));
    return NextResponse.json({ error: "Temporary failure" }, { status: 500 }); // Meta will retry
  }

  // 5–10. Respond to Meta immediately; run the AI after the response is sent.
  if (toProcess.length) {
    after(async () => {
      await Promise.all([
        ...toProcess.map((p) =>
          processConversation(p.conversationId, p.messageId).catch((err) => logger.error("meta processing failed", { conversationId: p.conversationId, ...errorInfo(err) }))
        ),
        // Chat activity is also a chance to resend orders the order platform didn't take earlier.
        retryDueForwards({ limit: 3 }).catch((err) => logger.warn("order forward retry failed", errorInfo(err))),
      ]);
    });
  }
  return NextResponse.json({ status: "EVENT_RECEIVED" });
}

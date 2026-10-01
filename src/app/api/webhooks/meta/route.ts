import { after, NextResponse } from "next/server";
import { integrationEnv } from "@/lib/integrations";
import { logger, errorInfo } from "@/lib/logger";
import { verifyMetaSignature } from "@/lib/security/signature";
import { parseMetaWebhook } from "@/lib/channels/meta";
import { processConversation, receiveEcho, receiveInbound } from "@/lib/conversation/service";
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
  const valid =
    verifyMetaSignature(raw, sig, (await integrationEnv()).META_APP_SECRET) ||
    // The app secret may have just been changed on the dashboard: retry once with uncached values.
    verifyMetaSignature(raw, sig, (await integrationEnv({ fresh: true })).META_APP_SECRET);
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
      await Promise.all(
        toProcess.map((p) =>
          processConversation(p.conversationId, p.messageId).catch((err) => logger.error("meta processing failed", { conversationId: p.conversationId, ...errorInfo(err) }))
        )
      );
    });
  }
  return NextResponse.json({ status: "EVENT_RECEIVED" });
}

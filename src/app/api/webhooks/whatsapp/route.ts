import { after, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { logger, errorInfo } from "@/lib/logger";
import { verifyMetaSignature } from "@/lib/security/signature";
import { parseWhatsAppWebhook, WhatsAppAdapter } from "@/lib/channels/whatsapp";
import { processConversation, receiveInbound } from "@/lib/conversation/service";
import { requestHandoff } from "@/lib/handoff";
import { MAX_WEBHOOK_BYTES, verifyHandshake, webhookIpLimit } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  return verifyHandshake(req, env().WHATSAPP_VERIFY_TOKEN);
}

export async function POST(req: Request) {
  const limited = await webhookIpLimit(req);
  if (limited) return limited;
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const secret = env().WHATSAPP_APP_SECRET ?? env().META_APP_SECRET;
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    logger.warn("whatsapp webhook signature rejected");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseWhatsAppWebhook(body as Parameters<typeof parseWhatsAppWebhook>[0], env().WHATSAPP_PHONE_NUMBER_ID);
  const toProcess: { conversationId: string; messageId: string; waId: string }[] = [];
  try {
    for (const msg of parsed.messages) {
      const r = await receiveInbound(msg);
      if (!r.duplicate && r.conversationId && r.messageId) toProcess.push({ conversationId: r.conversationId, messageId: r.messageId, waId: msg.externalMessageId });
    }
    // Delivery status callbacks: surface failed deliveries to staff.
    for (const s of parsed.statuses) {
      if (s.status !== "failed") continue;
      const m = await prisma.message.findFirst({ where: { externalId: s.id } });
      if (m) {
        await prisma.message.update({ where: { id: m.id }, data: { deliveryStatus: "FAILED", deliveryError: s.errors?.[0]?.title?.slice(0, 300) ?? "failed" } });
        await requestHandoff(m.conversationId, "delivery_failed", `WhatsApp delivery failed${s.errors?.[0]?.code ? ` (code ${s.errors[0].code})` : ""}`);
      }
    }
  } catch (err) {
    logger.error("whatsapp webhook storage failed", errorInfo(err));
    return NextResponse.json({ error: "Temporary failure" }, { status: 500 });
  }

  if (toProcess.length) {
    after(async () => {
      const wa = new WhatsAppAdapter();
      await Promise.all(
        toProcess.map(async (p) => {
          await wa.markRead(p.waId).catch(() => undefined);
          await processConversation(p.conversationId, p.messageId).catch((err) =>
            logger.error("whatsapp processing failed", { conversationId: p.conversationId, ...errorInfo(err) })
          );
        })
      );
    });
  }
  return NextResponse.json({ status: "ok" });
}

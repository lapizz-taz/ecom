import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/signature";
import { getAdapter } from "@/lib/channels";
import { processConversation } from "@/lib/conversation/service";
import { logger, errorInfo } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled maintenance (Vercel Cron -> GET with "Authorization: Bearer $CRON_SECRET"):
 * - retry failed outbound messages (< 24h old, < 4 attempts)
 * - recover inbound messages whose background processing never ran
 * - expire stale draft orders
 * - prune idempotency / rate-limit rows
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || !safeEqual(auth, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const report = { retried: 0, retrySucceeded: 0, recovered: 0, draftsExpired: 0, eventsPruned: 0, rateLimitsPruned: 0 };
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  // 1. Retry failed outbound AI/human messages.
  const failed = await prisma.message.findMany({
    where: { deliveryStatus: "FAILED", sender: { in: ["AI", "HUMAN"] }, createdAt: { gte: dayAgo }, attempts: { lt: 4 } },
    include: { conversation: { include: { channelUser: true } } },
    take: 25,
  });
  for (const m of failed) {
    report.retried++;
    try {
      const r = await getAdapter(m.conversation.channel).send(m.conversation.channelUser.externalUserId, m.message, {
        humanAgent: m.sender === "HUMAN",
        lastCustomerMessageAt: m.conversation.lastCustomerMessageAt,
      });
      await prisma.message.update({
        where: { id: m.id },
        data: {
          attempts: { increment: 1 },
          deliveryStatus: r.ok ? "SENT" : "FAILED",
          deliveryError: r.ok ? null : r.error?.slice(0, 500),
          externalId: r.externalIds[0] ?? m.externalId,
        },
      });
      if (r.ok) report.retrySucceeded++;
    } catch (err) {
      logger.error("retry failed", { messageId: m.id, ...errorInfo(err) });
    }
  }

  // 2. Inbound messages never claimed by the AI (e.g. the function was killed) in AI_ACTIVE conversations.
  const stuck = await prisma.message.findMany({
    where: {
      sender: "CUSTOMER",
      processedAt: null,
      createdAt: { lte: new Date(Date.now() - 2 * 60_000), gte: new Date(Date.now() - 6 * 3600_000) },
      conversation: { status: "AI_ACTIVE", channel: { not: "TEST" } },
    },
    orderBy: { createdAt: "desc" },
    distinct: ["conversationId"],
    take: 10,
  });
  for (const m of stuck) {
    const res = await processConversation(m.conversationId, m.id, { debounceMs: 0 }).catch(() => null);
    if (res?.status === "replied") report.recovered++;
  }

  // 3–4. Housekeeping.
  report.draftsExpired = (
    await prisma.draftOrder.updateMany({ where: { status: "AWAITING_CONFIRMATION", createdAt: { lt: dayAgo } }, data: { status: "EXPIRED" } })
  ).count;
  report.eventsPruned = (await prisma.processedEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400_000) } } })).count;
  report.rateLimitsPruned = (await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: dayAgo } } })).count;

  logger.info("maintenance done", report);
  return NextResponse.json(report);
}

import type { Channel } from "@prisma/client";
import { prisma } from "../db";
import { getSettings } from "../config/settings";
import { track } from "../analytics";
import { notifyHandoff } from "./notify";
import { logger, errorInfo } from "../logger";

/**
 * Human handoff lifecycle:
 * AI_ACTIVE -> HUMAN_REQUIRED (AI paused, staff notified) -> HUMAN_ACTIVE (staff took over)
 * -> AI_ACTIVE (returned to AI) or RESOLVED.
 */
export async function requestHandoff(conversationId: string, reason: string, detail?: string | null) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { name: true } }, handoffs: { where: { resolvedAt: null }, take: 1 } },
  });
  if (!conv) return null;
  const settings = await getSettings();

  let handoff = conv.handoffs[0] ?? null;
  const isNew = !handoff;
  if (!handoff) {
    handoff = await prisma.handoff.create({ data: { conversationId, reason, detail: detail?.slice(0, 1000) ?? null } });
  }
  if (conv.status !== "HUMAN_ACTIVE") {
    await prisma.conversation.update({ where: { id: conversationId }, data: { status: "HUMAN_REQUIRED" } });
  }
  if (isNew) {
    await prisma.message.create({
      data: { conversationId, sender: "SYSTEM", message: `Handoff requested: ${reason}${detail ? ` — ${detail.slice(0, 300)}` : ""}`, deliveryStatus: "NOT_SENT" },
    });
    await track("handoff", { channel: conv.channel, conversationId, data: { reason } });
    if (conv.channel !== "TEST") {
      notifyHandoff({ settings, conversationId, channel: conv.channel, reason, customerName: conv.customer.name }).catch((err) =>
        logger.warn("notify failed", errorInfo(err))
      );
    }
  }
  return handoff;
}

export async function takeOver(conversationId: string, adminEmail: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { status: "HUMAN_ACTIVE", assignedTo: adminEmail } });
  await prisma.message.create({ data: { conversationId, sender: "SYSTEM", message: `${adminEmail} took over the conversation`, deliveryStatus: "NOT_SENT" } });
  await prisma.auditLog.create({ data: { actor: adminEmail, action: "conversation.take_over", target: conversationId } });
}

export async function returnToAi(conversationId: string, adminEmail: string) {
  await prisma.$transaction([
    prisma.handoff.updateMany({ where: { conversationId, resolvedAt: null }, data: { resolvedAt: new Date(), resolvedBy: adminEmail } }),
    prisma.conversation.update({ where: { id: conversationId }, data: { status: "AI_ACTIVE", assignedTo: null } }),
    prisma.message.create({ data: { conversationId, sender: "SYSTEM", message: `${adminEmail} returned the conversation to AI`, deliveryStatus: "NOT_SENT" } }),
    prisma.auditLog.create({ data: { actor: adminEmail, action: "conversation.return_to_ai", target: conversationId } }),
  ]);
}

export async function resolveConversation(conversationId: string, adminEmail: string) {
  await prisma.$transaction([
    prisma.handoff.updateMany({ where: { conversationId, resolvedAt: null }, data: { resolvedAt: new Date(), resolvedBy: adminEmail } }),
    prisma.conversation.update({ where: { id: conversationId }, data: { status: "RESOLVED" } }),
    prisma.message.create({ data: { conversationId, sender: "SYSTEM", message: `${adminEmail} marked the conversation resolved`, deliveryStatus: "NOT_SENT" } }),
    prisma.auditLog.create({ data: { actor: adminEmail, action: "conversation.resolve", target: conversationId } }),
  ]);
}

export async function markHumanRepliedInInbox(conversationId: string, channel: Channel) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { status: "HUMAN_ACTIVE" } });
  await track("human_message", { channel, conversationId, data: { source: "native_inbox" } });
}

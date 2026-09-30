import type { Channel, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { logger, errorInfo } from "../logger";

export type AnalyticsType =
  | "message_received"
  | "ai_response"
  | "human_message"
  | "handoff"
  | "order_created"
  | "order_failed"
  | "draft_created"
  | "product_requested"
  | "failed_query"
  | "duplicate_event"
  | "send_failed"
  | "rate_limited";

/** Fire-and-forget analytics. Never store message text or phone numbers here. */
export async function track(type: AnalyticsType, opts: { channel?: Channel; conversationId?: string; data?: Prisma.InputJsonValue } = {}) {
  try {
    await prisma.analyticsEvent.create({ data: { type, channel: opts.channel, conversationId: opts.conversationId, data: opts.data } });
  } catch (err) {
    logger.warn("analytics write failed", { type, ...errorInfo(err) });
  }
}

export interface DashboardStats {
  rangeDays: number;
  conversations: number;
  conversationsByChannel: Record<string, number>;
  messagesReceived: number;
  aiResponses: number;
  humanMessages: number;
  handoffs: number;
  handoffsByReason: Record<string, number>;
  ordersGenerated: number;
  conversionRate: number;
  failedQueries: number;
  avgResponseMs: number | null;
  topProducts: { title: string; count: number }[];
  topIntents: { intent: string; count: number }[];
  channelPerformance: { channel: string; conversations: number; orders: number; handoffs: number; conversion: number }[];
  openByStatus: Record<string, number>;
}

export async function getDashboardStats(rangeDays = 30): Promise<DashboardStats> {
  const since = new Date(Date.now() - rangeDays * 86400_000);
  const [convs, events, orders, statusCounts] = await Promise.all([
    prisma.conversation.findMany({ where: { createdAt: { gte: since }, channel: { not: "TEST" } }, select: { id: true, channel: true } }),
    prisma.analyticsEvent.findMany({ where: { createdAt: { gte: since }, channel: { not: "TEST" } }, select: { type: true, channel: true, data: true, conversationId: true } }),
    prisma.order.findMany({ where: { createdAt: { gte: since }, channel: { not: "TEST" } }, select: { conversationId: true, channel: true } }),
    prisma.conversation.groupBy({ by: ["status"], where: { channel: { not: "TEST" } }, _count: true }),
  ]);

  const count = (t: string) => events.filter((e) => e.type === t).length;
  const byChannel: Record<string, number> = {};
  for (const c of convs) byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1;

  const handoffsByReason: Record<string, number> = {};
  const products = new Map<string, number>();
  const intents = new Map<string, number>();
  const latencies: number[] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "handoff") handoffsByReason[String(d.reason ?? "unknown")] = (handoffsByReason[String(d.reason ?? "unknown")] ?? 0) + 1;
    if (e.type === "product_requested" && typeof d.title === "string") products.set(d.title, (products.get(d.title) ?? 0) + 1);
    if (e.type === "message_received" && Array.isArray(d.intents)) for (const i of d.intents) intents.set(String(i), (intents.get(String(i)) ?? 0) + 1);
    if (e.type === "ai_response" && typeof d.latencyMs === "number") latencies.push(d.latencyMs);
  }

  const convWithOrder = new Set(orders.map((o) => o.conversationId).filter(Boolean));
  const channels = ["INSTAGRAM", "MESSENGER", "WHATSAPP"];
  const channelPerformance = channels.map((ch) => {
    const cs = convs.filter((c) => c.channel === ch);
    const ords = cs.filter((c) => convWithOrder.has(c.id)).length;
    return {
      channel: ch,
      conversations: cs.length,
      orders: orders.filter((o) => o.channel === ch).length,
      handoffs: events.filter((e) => e.type === "handoff" && e.channel === ch).length,
      conversion: cs.length ? ords / cs.length : 0,
    };
  });

  return {
    rangeDays,
    conversations: convs.length,
    conversationsByChannel: byChannel,
    messagesReceived: count("message_received"),
    aiResponses: count("ai_response"),
    humanMessages: count("human_message"),
    handoffs: count("handoff"),
    handoffsByReason,
    ordersGenerated: orders.length,
    conversionRate: convs.length ? convs.filter((c) => convWithOrder.has(c.id)).length / convs.length : 0,
    failedQueries: count("failed_query"),
    avgResponseMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    topProducts: [...products.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([title, c]) => ({ title, count: c })),
    topIntents: [...intents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([intent, c]) => ({ intent, count: c })),
    channelPerformance,
    openByStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
  };
}

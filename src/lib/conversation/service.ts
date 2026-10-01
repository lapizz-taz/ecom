import { Prisma, type Channel, type Conversation, type Message } from "@prisma/client";
import { prisma } from "../db";
import { logger, errorInfo } from "../logger";
import { getSettings } from "../config/settings";
import { getKnowledge } from "../knowledge";
import { getShopify, type ShopifyMode, type ShopifyProvider } from "../shopify";
import { defaultLlm, type LlmClient } from "../ai/llm";
import { runAgent, type AgentResult } from "../ai/agent";
import { analyzeMessage, intentTags } from "../ai/guards";
import { detectLanguage } from "../ai/language";
import { fixedReply } from "../ai/replies";
import { scanSensitive, type SensitiveKind } from "../security/redact";
import { LIMITS, rateLimit } from "../security/rateLimit";
import { getAdapter, type EchoMessage, type InboundMessage } from "../channels";
import { requestHandoff, markHumanRepliedInInbox } from "../handoff";
import { track } from "../analytics";
import { normalizeBdPhone } from "../utils/phone";
import { integrationEnv } from "../integrations";

/**
 * Unified, channel-independent conversation pipeline.
 *
 *   webhook -> receiveInbound()  (verify done by route; idempotency, identity, store)
 *           -> processConversation() (human-mode check, rate limits, AI, send, store, handoff)
 */

export interface ReceiveResult {
  duplicate: boolean;
  conversationId?: string;
  messageId?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Returns true if this event id was already processed (idempotency). */
export async function claimEvent(channel: Channel, eventId: string): Promise<boolean> {
  try {
    await prisma.processedEvent.create({ data: { id: `${channel}:${eventId}`, channel } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function findOrCreateChannelUser(msg: InboundMessage) {
  const existing = await prisma.channelUser.findUnique({
    where: { channel_externalUserId: { channel: msg.channel, externalUserId: msg.externalUserId } },
    include: { customer: true },
  });
  if (existing) {
    if (msg.profileName && existing.name !== msg.profileName) {
      await prisma.channelUser.update({ where: { id: existing.id }, data: { name: msg.profileName } });
    }
    return existing;
  }

  let name = msg.profileName ?? null;
  let username: string | null = null;
  if (!name && msg.channel !== "TEST" && msg.channel !== "WHATSAPP") {
    const profile = await getAdapter(msg.channel).getProfile?.(msg.externalUserId).catch(() => null);
    name = profile?.name ?? null;
    username = profile?.username ?? null;
  }

  // Cross-channel identity: only merge on a channel-verified phone number (WhatsApp).
  const verifiedPhone = msg.verifiedPhone ? normalizeBdPhone(msg.verifiedPhone) : null;
  const mergeable = msg.channel === "WHATSAPP" && verifiedPhone; // never merge test identities into real customers
  let customer = mergeable ? await prisma.customer.findFirst({ where: { phone: verifiedPhone, phoneVerified: true } }) : null;
  if (!customer) {
    customer = await prisma.customer.create({ data: { name, phone: verifiedPhone, phoneVerified: Boolean(mergeable) } });
  }
  try {
    return await prisma.channelUser.create({
      data: { customerId: customer.id, channel: msg.channel, externalUserId: msg.externalUserId, name, username, phone: verifiedPhone },
      include: { customer: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Parallel webhook created it first.
    return prisma.channelUser.findUniqueOrThrow({
      where: { channel_externalUserId: { channel: msg.channel, externalUserId: msg.externalUserId } },
      include: { customer: true },
    });
  }
}

async function openConversation(channelUserId: string, customerId: string, channel: Channel): Promise<Conversation> {
  const open = await prisma.conversation.findFirst({
    where: { channelUserId, status: { not: "RESOLVED" } },
    orderBy: { updatedAt: "desc" },
  });
  if (open) return open;
  return prisma.conversation.create({ data: { channelUserId, customerId, channel } });
}

/** Steps 1–5: idempotency, identity, conversation, store incoming (redacted) message. Fast — runs inside the webhook request. */
export async function receiveInbound(msg: InboundMessage): Promise<ReceiveResult> {
  const fresh = await claimEvent(msg.channel, msg.externalMessageId);
  if (!fresh) {
    await track("duplicate_event", { channel: msg.channel });
    return { duplicate: true };
  }
  try {
    return await storeInbound(msg);
  } catch (err) {
    // Release the idempotency claim so the platform's retry can be processed.
    await prisma.processedEvent.delete({ where: { id: `${msg.channel}:${msg.externalMessageId}` } }).catch(() => undefined);
    throw err;
  }
}

async function storeInbound(msg: InboundMessage): Promise<ReceiveResult> {
  const user = await findOrCreateChannelUser(msg);
  const conv = await openConversation(user.id, user.customerId, msg.channel);

  const text = msg.text.slice(0, 4000);
  const sensitive = scanSensitive(text);
  const signals = analyzeMessage(sensitive.redacted);
  const lang = detectLanguage(sensitive.redacted);
  const intents = intentTags(sensitive.redacted);

  const message = await prisma.message.create({
    data: {
      conversationId: conv.id,
      sender: "CUSTOMER",
      message: sensitive.redacted,
      externalId: msg.externalMessageId,
      deliveryStatus: "RECEIVED",
      metadata: {
        sensitiveKinds: sensitive.kinds,
        negative: signals.negative,
        lang,
        attachments: msg.attachments?.map((a) => ({ type: a.type })) ?? [],
        platformTimestamp: msg.timestamp?.toISOString() ?? null,
      },
    },
  });
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: new Date(), lastCustomerMessageAt: new Date(), lastMessagePreview: sensitive.redacted.slice(0, 140) },
  });
  await track("message_received", { channel: msg.channel, conversationId: conv.id, data: { intents, lang } });
  return { duplicate: false, conversationId: conv.id, messageId: message.id };
}

/** A message typed by staff directly in Meta Business Suite / the Instagram app. */
export async function receiveEcho(echo: EchoMessage): Promise<"ignored" | "stored"> {
  const ownAppId = (await integrationEnv()).META_APP_ID;
  if (ownAppId && echo.appId === ownAppId) return "ignored"; // our own API send
  const already = await prisma.message.findFirst({ where: { externalId: echo.externalMessageId } });
  if (already) return "ignored";
  if (!(await claimEvent(echo.channel, `echo:${echo.externalMessageId}`))) return "ignored";
  const user = await prisma.channelUser.findUnique({
    where: { channel_externalUserId: { channel: echo.channel, externalUserId: echo.customerExternalId } },
  });
  if (!user) return "ignored";
  const conv = await openConversation(user.id, user.customerId, echo.channel);
  await prisma.message.create({
    data: {
      conversationId: conv.id,
      sender: "HUMAN",
      message: echo.text.slice(0, 4000),
      externalId: echo.externalMessageId,
      deliveryStatus: "SENT",
      sentBy: "native_inbox",
    },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(), lastMessagePreview: echo.text.slice(0, 140) } });
  // A person answered from the native inbox -> pause the AI so it doesn't talk over them.
  await markHumanRepliedInInbox(conv.id, echo.channel);
  return "stored";
}

export interface ProcessOptions {
  shopifyMode?: ShopifyMode;
  llm?: LlmClient | null;
  debounceMs?: number;
}

export interface ProcessResult {
  status: "replied" | "skipped" | "error";
  skipReason?: string;
  reply?: string | null;
  agent?: AgentResult;
  sent?: boolean;
  deliveryError?: string;
  conversationStatus?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function storeAndSend(
  conv: Conversation & { channelUser: { externalUserId: string } },
  text: string,
  metadata: Prisma.InputJsonValue
): Promise<{ message: Message; sent: boolean; error?: string }> {
  const adapter = getAdapter(conv.channel);
  const result = await adapter.send(conv.channelUser.externalUserId, text, { lastCustomerMessageAt: conv.lastCustomerMessageAt });
  const message = await prisma.message.create({
    data: {
      conversationId: conv.id,
      sender: "AI",
      message: text,
      externalId: result.externalIds[0] ?? null,
      deliveryStatus: result.ok ? "SENT" : "FAILED",
      deliveryError: result.ok ? null : result.error?.slice(0, 500),
      attempts: 1,
      metadata,
    },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 140) } });
  if (!result.ok) {
    logger.error("reply delivery failed", { conversationId: conv.id, channel: conv.channel, error: result.error });
    await track("send_failed", { channel: conv.channel, conversationId: conv.id, data: { retryable: Boolean(result.retryable) } });
  }
  return { message, sent: result.ok, error: result.error };
}

/** Steps 6–10: decide whether the AI should answer, run it, send via the original channel, store, hand off. */
export async function processConversation(conversationId: string, messageId: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const settings = await getSettings();
  let conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { channelUser: true, customer: true } });
  const inbound = await prisma.message.findUnique({ where: { id: messageId } });
  if (!conv || !inbound) return { status: "skipped", skipReason: "not_found" };

  // Human has taken over / is required -> AI stays silent.
  if (conv.status === "HUMAN_ACTIVE" || (conv.status === "HUMAN_REQUIRED" && settings.ai.handoff.pauseAiOnHandoff)) {
    return { status: "skipped", skipReason: "human_mode", conversationStatus: conv.status };
  }
  if (!settings.ai.enabled || !settings.ai.autoReply) {
    await requestHandoff(conv.id, "ai_disabled", "AI auto-reply is disabled in settings");
    return { status: "skipped", skipReason: "ai_disabled", conversationStatus: "HUMAN_REQUIRED" };
  }

  // Rate limits (spam / loops / abuse).
  const perMin = await rateLimit(`cust-min:${conv.channelUserId}`, LIMITS.customerPerMinute.limit, LIMITS.customerPerMinute.window);
  const perHour = await rateLimit(`cust-hour:${conv.channelUserId}`, LIMITS.customerPerHour.limit, LIMITS.customerPerHour.window);
  if (!perMin.allowed || !perHour.allowed) {
    await track("rate_limited", { channel: conv.channel, conversationId: conv.id });
    const firstOverflow = perMin.count === perMin.limit + 1 || perHour.count === perHour.limit + 1;
    if (firstOverflow) {
      const lang = detectLanguage(inbound.message);
      await storeAndSend(conv, fixedReply("rate_limited", lang), { guard: "rate_limited" });
      await requestHandoff(conv.id, "rate_limited", "Customer exceeded the message rate limit");
    }
    return { status: "skipped", skipReason: "rate_limited" };
  }

  // Coalesce bursts: if the customer keeps typing, only the latest message triggers a reply.
  const debounce = opts.debounceMs ?? settings.ai.debounceMs;
  if (debounce > 0) await sleep(debounce);
  const newer = await prisma.message.findFirst({
    where: { conversationId: conv.id, sender: "CUSTOMER", createdAt: { gt: inbound.createdAt }, id: { not: inbound.id } },
    select: { id: true },
  });
  if (newer) return { status: "skipped", skipReason: "superseded" };

  // Exactly-once claim of this inbound message (protects against parallel invocations).
  const claim = await prisma.message.updateMany({ where: { id: inbound.id, processedAt: null }, data: { processedAt: new Date() } });
  if (claim.count === 0) return { status: "skipped", skipReason: "already_processed" };

  const aiBudget = await rateLimit(`ai-conv:${conv.id}`, LIMITS.aiRepliesPerConversationHour.limit, LIMITS.aiRepliesPerConversationHour.window);
  if (!aiBudget.allowed) {
    await requestHandoff(conv.id, "rate_limited", "AI reply budget for this conversation exhausted (loop protection)");
    return { status: "skipped", skipReason: "ai_budget_exhausted" };
  }

  const [history, knowledge, pendingDraft] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: conv.id, createdAt: { lte: inbound.createdAt }, id: { not: inbound.id } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    getKnowledge(),
    prisma.draftOrder.findFirst({ where: { conversationId: conv.id, status: "AWAITING_CONFIRMATION" }, orderBy: { createdAt: "desc" } }),
  ]);
  history.reverse();

  let shopify: ShopifyProvider | null = null;
  try {
    shopify = await getShopify(settings.business.website, opts.shopifyMode ?? "live");
  } catch {
    shopify = null; // tools will report shopify_unavailable -> safe fallback
  }
  let llm: LlmClient | null = opts.llm === undefined ? null : opts.llm;
  if (opts.llm === undefined) {
    try {
      llm = await defaultLlm();
    } catch {
      llm = null;
    }
  }

  const md = (inbound.metadata ?? {}) as { sensitiveKinds?: SensitiveKind[] };
  const kinds = md.sensitiveKinds ?? [];
  const started = Date.now();
  let agent: AgentResult;
  try {
    agent = await runAgent({
      conversationId: conv.id,
      channel: conv.channel,
      customerId: conv.customerId,
      customerName: conv.customer.name ?? conv.channelUser.name,
      verifiedPhone: conv.channel === "WHATSAPP" || conv.channel === "TEST" ? conv.channelUser.phone : null,
      conversationLanguage: conv.language,
      inbound: { id: inbound.id, text: inbound.message, sensitive: { found: kinds.length > 0, kinds, redacted: inbound.message } },
      history: history.map((m) => ({ sender: m.sender, message: m.message, metadata: m.metadata })),
      pendingDraft: pendingDraft
        ? { id: pendingDraft.id, summary: ((pendingDraft.payload as { summaryLines?: string[] }).summaryLines ?? []).join("\n") }
        : null,
      settings,
      knowledge,
      shopify,
      llm,
    });
  } catch (err) {
    logger.error("agent crashed", { conversationId: conv.id, ...errorInfo(err) });
    await requestHandoff(conv.id, "other", "AI pipeline error");
    return { status: "error", skipReason: "agent_error" };
  }

  // Persist tool calls (inputs are validated/structured; outputs contain no other customers' data).
  if (agent.toolTraces.length) {
    await prisma.toolCallLog.createMany({
      data: agent.toolTraces.map((t) => ({
        conversationId: conv!.id,
        messageId: inbound.id,
        tool: t.name,
        input: (t.input ?? {}) as Prisma.InputJsonValue,
        output: (t.output ?? {}) as Prisma.InputJsonValue,
        success: t.ok,
        durationMs: t.durationMs,
      })),
    });
    for (const t of agent.toolTraces) {
      if (!t.ok) continue;
      const out = t.output as { product?: { title?: string }; products?: { title?: string }[]; product_title?: string };
      const titles = [out.product?.title, out.product_title, ...(t.name === "search_products" ? (out.products ?? []).slice(0, 3).map((p) => p.title) : [])].filter(Boolean);
      for (const title of titles) await track("product_requested", { channel: conv.channel, conversationId: conv.id, data: { title: title as string } });
    }
  }

  await prisma.conversation.update({ where: { id: conv.id }, data: { language: agent.lang } });

  // A human may have taken over while the model was thinking — don't talk over them.
  const latest = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { status: true } });
  if (latest?.status === "HUMAN_ACTIVE") {
    if (agent.reply) {
      await prisma.message.create({
        data: { conversationId: conv.id, sender: "SYSTEM", message: `AI reply suppressed (human active): ${agent.reply.slice(0, 500)}`, deliveryStatus: "NOT_SENT" },
      });
    }
    return { status: "skipped", skipReason: "human_took_over", agent };
  }

  let sent = false;
  let deliveryError: string | undefined;
  if (agent.reply && agent.reply.trim()) {
    const res = await storeAndSend(conv, agent.reply, {
      lang: agent.lang,
      guard: agent.guard,
      tools: agent.toolTraces.map((t) => t.name),
      validation: agent.validation,
      facts: agent.facts as unknown as Prisma.InputJsonValue,
      handoff: agent.handoff ?? undefined,
    } as Prisma.InputJsonValue);
    sent = res.sent;
    deliveryError = res.error;
    await track("ai_response", {
      channel: conv.channel,
      conversationId: conv.id,
      data: { latencyMs: Date.now() - inbound.createdAt.getTime(), agentMs: Date.now() - started, guard: agent.guard, tools: agent.toolTraces.length },
    });
  }

  if (agent.guard === "grounding_check" || agent.llmError || agent.toolTraces.some((t) => !t.ok)) {
    await track("failed_query", { channel: conv.channel, conversationId: conv.id, data: { guard: agent.guard, llmError: Boolean(agent.llmError) } });
  }
  if (agent.toolTraces.some((t) => t.name === "confirm_order" && t.ok)) {
    await track("order_created", { channel: conv.channel, conversationId: conv.id });
  }
  if (agent.toolTraces.some((t) => t.name === "confirm_order" && !t.ok && (t.output as { error?: string })?.error === "order_failed")) {
    await track("order_failed", { channel: conv.channel, conversationId: conv.id });
  }
  if (agent.toolTraces.some((t) => t.name === "create_draft_order" && t.ok)) {
    await track("draft_created", { channel: conv.channel, conversationId: conv.id });
  }
  if (agent.handoff) await requestHandoff(conv.id, agent.handoff.reason, agent.handoff.detail);
  if (!sent && agent.reply && conv.channel !== "TEST") {
    await requestHandoff(conv.id, "delivery_failed", `Reply could not be delivered: ${deliveryError ?? "unknown error"}`);
  }

  conv = await prisma.conversation.findUnique({ where: { id: conv.id }, include: { channelUser: true, customer: true } });
  return { status: "replied", reply: agent.reply, agent, sent, deliveryError, conversationStatus: conv?.status };
}

/** Full pipeline for one inbound message. */
export async function handleInbound(msg: InboundMessage, opts: ProcessOptions = {}) {
  const received = await receiveInbound(msg);
  if (received.duplicate || !received.conversationId || !received.messageId) return { received, result: null };
  const result = await processConversation(received.conversationId, received.messageId, opts);
  return { received, result };
}

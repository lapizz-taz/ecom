import type { Channel, KnowledgeEntry, Sender } from "@prisma/client";
import type { Settings } from "../config/settings";
import type { ShopifyProvider } from "../shopify";
import type { SensitiveScan } from "../security/redact";
import { logger, errorInfo } from "../logger";
import { detectLanguage, type Lang } from "./language";
import { analyzeMessage, type GuardSignals } from "./guards";
import { fixedReply, type ReplyKey } from "./replies";
import { buildSystemPrompt } from "./prompt";
import { executeTool, toolDefinitions, type ToolContext, type ToolTrace } from "./tools";
import { sanitizeReply, validateReply } from "./validate";
import type { LlmClient, LlmMessage } from "./llm";

export interface HistoryItem {
  sender: Sender;
  message: string;
  metadata?: unknown;
}

export interface AgentInput {
  conversationId: string;
  channel: Channel;
  customerId: string;
  customerName: string | null;
  verifiedPhone: string | null;
  conversationLanguage: string | null;
  inbound: { id: string; text: string; sensitive: SensitiveScan };
  history: HistoryItem[];
  pendingDraft: { id: string; summary: string } | null;
  settings: Settings;
  knowledge: KnowledgeEntry[];
  shopify: ShopifyProvider | null;
  llm: LlmClient | null;
}

export interface AgentFact {
  tool: string;
  data: unknown;
}

export interface AgentResult {
  reply: string | null;
  lang: Lang;
  guard: string | null;
  signals: GuardSignals;
  handoff: { reason: string; detail?: string } | null;
  toolTraces: ToolTrace[];
  validation: { ok: boolean; issues: string[] };
  facts: AgentFact[];
  modelReply: string | null;
  llmError: string | null;
}

const MAX_ROUNDS = 6;
const MAX_TOOL_CALLS = 12;
const FACT_TOOLS = new Set(["search_products", "get_product", "check_inventory", "get_order", "create_draft_order", "confirm_order", "get_delivery_info", "get_policy", "get_promotions"]);

function pickLanguage(input: AgentInput): Lang {
  const mode = input.settings.ai.languageMode;
  if (mode !== "auto") return mode;
  const detected = detectLanguage(input.inbound.text);
  const words = input.inbound.text.trim().split(/\s+/).length;
  // Very short messages ("ok", "yes", "1001") inherit the conversation's language.
  if (detected === "en" && words <= 2 && (input.conversationLanguage === "bn" || input.conversationLanguage === "banglish")) {
    return input.conversationLanguage;
  }
  return detected;
}

function meaningfulAfterRedaction(text: string): boolean {
  const stripped = text
    .replace(/\[REDACTED[^\]]*\]/g, " ")
    .replace(/\b(my|is|the|otp|pin|code|password|card|number|amar|apnar|holo|hocche|here|this|eta|ei|dilam|dicchi)\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return stripped.split(/\s+/).filter(Boolean).length >= 2;
}

function compact(data: unknown, max = 1500): unknown {
  const s = JSON.stringify(data);
  if (s.length <= max) return data;
  return s.slice(0, max) + "…";
}

/** Facts stored with earlier AI messages — re-used for grounding and conversation memory. */
export function factsFromHistory(history: HistoryItem[]): AgentFact[] {
  const facts: AgentFact[] = [];
  for (const h of history.slice(-12)) {
    const md = h.metadata as { facts?: AgentFact[] } | null | undefined;
    if (md?.facts) facts.push(...md.facts);
  }
  return facts.slice(-8);
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const lang = pickLanguage(input);
  const text = input.inbound.text;
  const signals = analyzeMessage(text);
  const h = input.settings.ai.handoff;
  const result: AgentResult = {
    reply: null,
    lang,
    guard: null,
    signals,
    handoff: null,
    toolTraces: [],
    validation: { ok: true, issues: [] },
    facts: [],
    modelReply: null,
    llmError: null,
  };
  const warning = input.inbound.sensitive.found ? fixedReply("sensitive_warning", lang) : null;
  const withWarning = (reply: string) => (warning ? `${warning}\n\n${reply}` : reply);

  const guardHandoff = (guard: string, reason: string, reply: ReplyKey, detail?: string): AgentResult => {
    result.guard = guard;
    result.handoff = { reason, detail };
    result.reply = withWarning(fixedReply(reply, lang));
    return result;
  };

  // ---- 1. Deterministic guards (never delegated to the model) ----
  if (warning && !meaningfulAfterRedaction(text)) {
    result.guard = "sensitive_data";
    result.reply = warning;
    return result;
  }
  if (signals.humanRequest) return guardHandoff("human_request", "customer_requested_human", "human_request");
  if (signals.anger && h.onAnger) return guardHandoff("anger", "angry_customer", "angry", text.slice(0, 200));
  if (signals.paymentProblem && h.onPaymentProblem) return guardHandoff("payment_problem", "payment_problem", "payment_problem", text.slice(0, 200));
  if (signals.refund && h.onRefundRequest) return guardHandoff("refund", "refund_request", "refund", text.slice(0, 200));
  if (signals.cancel && h.onCancelRequest && !input.pendingDraft) return guardHandoff("cancel", "cancellation_request", "cancel", text.slice(0, 200));
  if (signals.discountRequest && h.onDiscountRequest) return guardHandoff("discount", "discount_request", "discount", text.slice(0, 200));
  if (signals.negative) {
    const previousNegatives = input.history.filter(
      (m) => m.sender === "CUSTOMER" && (m.metadata as { negative?: boolean } | null)?.negative
    ).length;
    if (previousNegatives + 1 >= h.dissatisfactionThreshold) {
      return guardHandoff("repeated_dissatisfaction", "complaint", "dissatisfied", text.slice(0, 200));
    }
  }

  // ---- 2. Model with controlled tools ----
  if (!input.llm) {
    result.llmError = "llm_not_configured";
    return guardHandoff("ai_unavailable", "other", "ai_error", "AI model not configured");
  }

  const earlierFacts = factsFromHistory(input.history);
  const system = buildSystemPrompt({
    settings: input.settings,
    knowledge: input.knowledge,
    lang,
    channel: input.channel,
    customerName: input.customerName,
    verifiedPhone: input.verifiedPhone,
    pendingDraftSummary: input.pendingDraft ? `draft_id ${input.pendingDraft.id}\n${input.pendingDraft.summary}` : null,
    recentFacts: earlierFacts.length ? earlierFacts.map((f) => `${f.tool}: ${JSON.stringify(f.data)}`).join("\n").slice(0, 5000) : null,
  });

  const messages: LlmMessage[] = [{ role: "system", content: system }];
  const recent = input.history.filter((m) => m.sender !== "SYSTEM").slice(-input.settings.ai.historyMessages);
  for (const m of recent) {
    if (m.sender === "CUSTOMER") messages.push({ role: "user", content: m.message });
    else messages.push({ role: "assistant", content: m.message });
  }
  messages.push({ role: "user", content: text });

  const ctx: ToolContext = {
    conversationId: input.conversationId,
    customerId: input.customerId,
    channel: input.channel,
    inboundMessageId: input.inbound.id,
    inboundText: text,
    verifiedPhone: input.verifiedPhone,
    settings: input.settings,
    shopify: input.shopify,
    state: { handoff: null, shopifyFailed: false, orderFailed: false, orderConfirmed: null },
  };

  const tools = toolDefinitions();
  let finalText: string | null = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await input.llm.complete({ messages, tools });
      if (!res.toolCalls.length) {
        finalText = res.content;
        break;
      }
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const trace =
          result.toolTraces.length >= MAX_TOOL_CALLS
            ? { name: call.name, input: call.arguments, output: { error: "tool_call_limit_reached" }, ok: false, durationMs: 0 }
            : await executeTool(call.name, call.arguments, ctx);
        result.toolTraces.push(trace);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(trace.output) });
      }
    }
  } catch (err) {
    logger.error("llm failure", { conversationId: input.conversationId, ...errorInfo(err) });
    result.llmError = err instanceof Error ? err.message : String(err);
    // Never send a broken/empty message: fixed holding reply + handoff.
    return guardHandoff("ai_unavailable", "other", "ai_error", "AI model error");
  }

  result.modelReply = finalText;
  result.facts = result.toolTraces
    .filter((t) => t.ok && FACT_TOOLS.has(t.name))
    .map((t) => ({ tool: t.name, data: compact(t.output) }));

  // ---- 3. Deterministic outcomes that override the model ----
  if (ctx.state.orderFailed) {
    result.handoff = ctx.state.handoff ?? { reason: "order_failed" };
    result.reply = withWarning(fixedReply("order_failed", lang));
    return result;
  }
  if (ctx.state.shopifyFailed) {
    result.handoff = { reason: "shopify_unavailable", detail: "Shopify lookup failed during the AI turn" };
    result.reply = withWarning(fixedReply("shopify_down", lang));
    return result;
  }

  // ---- 4. Grounding validation ----
  const cleaned = finalText ? sanitizeReply(finalText) : "";
  const groundingSources: unknown[] = [
    ...result.toolTraces.filter((t) => t.ok).map((t) => t.output),
    ...earlierFacts.map((f) => f.data),
    input.settings.delivery,
    input.settings.payment,
    input.settings.business,
    input.knowledge.map((k) => k.content),
    input.pendingDraft?.summary ?? null,
  ];
  const validation = validateReply({
    reply: cleaned,
    groundingSources,
    customerText: text,
    orderConfirmedThisTurn: ctx.state.orderConfirmed?.mode === "complete",
  });
  result.validation = validation;
  if (!validation.ok) {
    logger.warn("reply blocked by grounding check", { conversationId: input.conversationId, issues: validation.issues });
    result.guard = "grounding_check";
    result.handoff = { reason: "low_confidence", detail: `AI reply blocked: ${validation.issues.join(", ")}` };
    result.reply = withWarning(fixedReply("confirm_fallback", lang));
    return result;
  }

  if (ctx.state.handoff) result.handoff = ctx.state.handoff;
  let reply = cleaned;
  if (reply.length > input.settings.ai.maxReplyChars * 2) reply = reply.slice(0, input.settings.ai.maxReplyChars * 2).replace(/\s+\S*$/, "") + "…";
  result.reply = withWarning(reply);
  return result;
}

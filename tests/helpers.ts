import { prisma } from "@/lib/db";
import { clearSettingsCache } from "@/lib/config/settings";
import { clearKnowledgeCache } from "@/lib/knowledge";
import { clearIntegrationCache } from "@/lib/integrations";
import { handleInbound } from "@/lib/conversation/service";
import { ScriptedLlm, type LlmMessage, type LlmResponse } from "@/lib/ai/llm";
import type { ShopifyMode } from "@/lib/shopify";
import type { Channel } from "@prisma/client";
import { setAdapterFactoryForTests, type SendResult } from "@/lib/channels";

export const sent: { channel: Channel; to: string; text: string }[] = [];
export let failSends = false;
export function setFailSends(v: boolean) {
  failSends = v;
}

export async function resetDb() {
  const tables = [
    "ToolCallLog", "Handoff", "DraftOrder", "Order", "Message", "Conversation", "ChannelUser", "Customer",
    "ProcessedEvent", "Setting", "KnowledgeEntry", "AnalyticsEvent", "RateLimit", "AuditLog", "AdminUser", "IntegrationSecret",
  ];
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
  clearSettingsCache();
  clearKnowledgeCache();
  clearIntegrationCache();
  sent.length = 0;
  failSends = false;
  setAdapterFactoryForTests((channel) => ({
    channel,
    maxLength: 2000,
    async send(to: string, text: string): Promise<SendResult> {
      if (failSends) return { ok: false, externalIds: [], error: "simulated Meta outage", retryable: true };
      sent.push({ channel, to, text });
      return { ok: true, externalIds: [`out-${sent.length}-${Date.now()}`] };
    },
  }));
  await prisma.knowledgeEntry.createMany({
    data: [
      { category: "POLICY", key: "policy.return", title: "Return policy", content: "" },
      { category: "FAQ", key: "faq.physical-store", title: "Do you have a physical shop?", content: "Isolation is online only — no physical outlet." },
    ],
  });
}

let counter = 0;
export function mid() {
  counter += 1;
  return `mid-${Date.now()}-${counter}`;
}

export type Step = LlmResponse | ((m: LlmMessage[]) => LlmResponse) | Error;

export function call(name: string, args: object, id = `call_${name}_${counter++}`): LlmResponse {
  return { content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}
export function say(content: string): LlmResponse {
  return { content, toolCalls: [] };
}

export async function turn(
  text: string,
  opts: { script?: Step[]; mode?: ShopifyMode; user?: string; channel?: Channel; verifiedPhone?: string | null; llm?: ScriptedLlm | null } = {}
) {
  const llm = opts.llm !== undefined ? opts.llm : new ScriptedLlm(opts.script ?? []);
  const { received, result } = await handleInbound(
    {
      channel: opts.channel ?? "MESSENGER",
      externalUserId: opts.user ?? "psid-1",
      externalMessageId: mid(),
      text,
      verifiedPhone: opts.verifiedPhone ?? null,
    },
    { llm, shopifyMode: opts.mode ?? "mock:normal", debounceMs: 0 }
  );
  return { received, result: result!, llm: llm! };
}

export function systemPrompt(messages: LlmMessage[]): string {
  return (messages[0] as { content: string }).content;
}

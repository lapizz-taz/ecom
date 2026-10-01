import { requirePageSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings, enabledPaymentMethods } from "@/lib/config/settings";
import { getKnowledge, POLICY_TOPICS } from "@/lib/knowledge";
import { integrationEnv } from "@/lib/integrations";
import { integrationHealth } from "@/lib/integrations/health";
import { orderDestination } from "@/lib/orders/forward";
import { AgentHub, type AgentOverview } from "@/components/AgentHub";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const LANGUAGE: Record<string, string> = { auto: "Same as the customer", en: "English", bn: "Bangla", banglish: "Banglish" };

export default async function AgentPage() {
  const session = await requirePageSession();
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  const [settings, knowledge, health, e, aiReplies, orders, handoffs, waiting, undelivered] = await Promise.all([
    getSettings({ fresh: true }),
    getKnowledge({ fresh: true }),
    integrationHealth(),
    integrationEnv(),
    prisma.message.count({ where: { sender: "AI", createdAt: { gte: weekAgo }, conversation: { channel: { not: "TEST" } } } }),
    prisma.order.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.handoff.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.conversation.count({ where: { status: "HUMAN_REQUIRED" } }),
    prisma.orderForward.count({ where: { status: { in: ["pending", "failed"] } } }),
  ]);

  const b = settings.business;
  const filled = (s: string | null | undefined) => Boolean(s?.trim());
  const active = knowledge.filter((k) => k.active && k.content.trim());
  const count = (category: string) => active.filter((k) => k.category === category).length;
  const businessTopics = [
    { label: "Brand name", done: filled(b.brandName) },
    { label: "Website", done: filled(b.website) },
    { label: "Contact details", done: filled(b.supportContact) },
    { label: "Business hours", done: filled(b.businessHours) },
    { label: "Social pages", done: filled(b.instagram) || filled(b.facebook) || filled(b.whatsapp) },
    { label: "Brand facts", done: count("BRAND") > 0 },
  ];
  const policies = POLICY_TOPICS.filter((t) => active.some((k) => k.key === `policy.${t}`));
  const instructions = filled(settings.ai.brandInstructions) || count("INSTRUCTION") > 0;

  const overview: AgentOverview = {
    isAdmin: session.role === "ADMIN",
    ai: settings.ai,
    health,
    stats: { aiReplies, orders, handoffs, waiting },
    teach: [
      {
        id: "business",
        title: "Business information",
        status: `${businessTopics.filter((t) => t.done).length} of ${businessTopics.length} topics filled`,
        detail: businessTopics.filter((t) => !t.done).length ? `Missing: ${businessTopics.filter((t) => !t.done).map((t) => t.label.toLowerCase()).join(", ")}` : "Contact details, hours and brand facts",
        done: businessTopics.every((t) => t.done),
        href: businessTopics.slice(0, 5).every((t) => t.done) ? "/admin/knowledge#brand" : "/admin/settings#business",
      },
      {
        id: "policies",
        title: "Policies",
        status: `${policies.length} of ${POLICY_TOPICS.length} written`,
        detail: policies.length < POLICY_TOPICS.length ? `Missing: ${POLICY_TOPICS.filter((t) => !policies.includes(t)).join(", ")}` : "Returns, exchanges, refunds, delivery and more",
        done: policies.length === POLICY_TOPICS.length,
        href: "/admin/knowledge#policy",
      },
      {
        id: "faq",
        title: "FAQs",
        status: count("FAQ") ? `${count("FAQ")} ${count("FAQ") === 1 ? "answer" : "answers"} added` : "No answers yet",
        detail: "Sizing, fabric, care, pre-orders — anything customers ask often",
        done: count("FAQ") > 0,
        href: "/admin/knowledge#faq",
      },
      {
        id: "delivery",
        title: "Delivery & payment",
        status: `${settings.delivery.zones.length} ${settings.delivery.zones.length === 1 ? "zone" : "zones"} · ${enabledPaymentMethods(settings).length} payment ${enabledPaymentMethods(settings).length === 1 ? "method" : "methods"}`,
        detail: enabledPaymentMethods(settings).map((m) => m.label).join(", ") || "No payment method is turned on",
        done: settings.delivery.zones.length > 0 && enabledPaymentMethods(settings).length > 0,
        href: "/admin/settings#delivery",
      },
      {
        id: "language",
        title: "Reply language",
        status: LANGUAGE[settings.ai.languageMode] ?? settings.ai.languageMode,
        detail: "Which language the agent answers in",
        done: true,
        href: "/admin/settings#ai",
      },
      {
        id: "voice",
        title: "Voice & instructions",
        status: instructions ? "Instructions added" : "Not added yet",
        detail: settings.ai.tone.trim() ? `Tone: ${settings.ai.tone.trim().slice(0, 90)}${settings.ai.tone.trim().length > 90 ? "…" : ""}` : "How the agent should sound, and what to always or never do",
        done: instructions,
        href: "/admin/settings#ai",
      },
      {
        id: "promotions",
        title: "Promotions",
        status: count("PROMOTION") ? `${count("PROMOTION")} active` : "None — no discounts are offered",
        detail: "Offers the agent may mention",
        done: true,
        href: "/admin/knowledge#promotion",
      },
      {
        id: "products",
        title: "Products & stock",
        status: health.shopify === "ok" ? "Live from Shopify" : health.shopify === "problem" ? "Shopify has a problem" : "Connect Shopify",
        detail: "Prices, sizes and stock are always checked live",
        done: health.shopify === "ok",
        href: health.shopify === "ok" ? "/admin/products" : "/admin/integrations#shopify",
      },
    ],
    orders: {
      destination: orderDestination(e),
      undelivered,
      paymentMethods: enabledPaymentMethods(settings).map((m) => m.label),
      zones: settings.delivery.zones.length,
    },
    // Email alerts only go out when an email service is set up (see sendStaffAlert).
    alerts: {
      email: e.RESEND_API_KEY && e.NOTIFY_FROM_EMAIL ? (settings.ai.handoff.notifyEmail ?? e.ADMIN_EMAIL ?? null) : null,
      webhook: Boolean(settings.ai.handoff.notifyWebhookUrl ?? e.HANDOFF_WEBHOOK_URL),
    },
  };

  return (
    <>
      <PageHeader
        title="AI sales agent"
        description="Your agent answers customers on Messenger, Instagram and WhatsApp, recommends products and takes orders. Teach it about your shop and choose what it may do."
      />
      <AgentHub overview={overview} />
    </>
  );
}

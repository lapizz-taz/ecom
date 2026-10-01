import { env } from "../env";
import { logger, errorInfo } from "../logger";
import type { Settings } from "../config/settings";

/**
 * Notify staff that a conversation needs a human. Sends only the reason, channel,
 * customer display name and a dashboard link — never the customer's messages or phone.
 */
export async function notifyHandoff(args: {
  settings: Settings;
  conversationId: string;
  channel: string;
  reason: string;
  customerName: string | null;
}) {
  const base = env().APP_URL?.replace(/\/$/, "") ?? "";
  const link = `${base}/admin/conversations/${args.conversationId}`;
  const text = `🔔 Isolation: human needed (${args.reason.replace(/_/g, " ")}) — ${args.channel.toLowerCase()}${
    args.customerName ? ` · ${args.customerName}` : ""
  }\n${link}`;
  await sendStaffAlert({ settings: args.settings, subject: `Isolation chat needs a human (${args.reason})`, text });
}

/** Send a short alert to the configured Slack/Discord webhook and/or notification email. */
export async function sendStaffAlert(args: { settings: Settings; subject: string; text: string }) {
  const e = env();
  const { text } = args;
  const tasks: Promise<unknown>[] = [];
  const webhook = args.settings.ai.handoff.notifyWebhookUrl ?? e.HANDOFF_WEBHOOK_URL;
  if (webhook) {
    // Compatible with Slack ("text") and Discord ("content") incoming webhooks.
    tasks.push(
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(5000),
      })
    );
  }
  const to = args.settings.ai.handoff.notifyEmail ?? e.ADMIN_EMAIL;
  if (e.RESEND_API_KEY && to && e.NOTIFY_FROM_EMAIL) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: e.NOTIFY_FROM_EMAIL, to: [to], subject: args.subject, text }),
        signal: AbortSignal.timeout(5000),
      })
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") logger.warn("staff notification failed", errorInfo(r.reason));
}

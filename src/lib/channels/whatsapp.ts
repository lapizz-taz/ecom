import { integrationEnv } from "../integrations";
import { normalizeBdPhone } from "../utils/phone";
import { graphRequest } from "./http";
import { describeAttachments, splitMessage, type ChannelAdapter, type InboundMessage, type SendResult } from "./types";

/** WhatsApp Business Cloud API adapter. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly maxLength = 4000;

  async send(to: string, text: string): Promise<SendResult> {
    const e = await integrationEnv();
    if (!e.WHATSAPP_PHONE_NUMBER_ID || !e.WHATSAPP_ACCESS_TOKEN) {
      return { ok: false, externalIds: [], error: "WhatsApp is not configured", retryable: false };
    }
    const url = `https://graph.facebook.com/${e.META_GRAPH_VERSION}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const ids: string[] = [];
    for (const part of splitMessage(text, this.maxLength)) {
      const r = await graphRequest<{ messages?: { id: string }[] }>(url, e.WHATSAPP_ACCESS_TOKEN, {
        body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body: part } },
      });
      if (!r.ok) {
        // 131047 = re-engagement required (outside 24h customer-service window) — needs an approved template.
        return { ok: false, externalIds: ids, error: r.error, retryable: r.retryable };
      }
      const id = r.data?.messages?.[0]?.id;
      if (id) ids.push(id);
    }
    return { ok: true, externalIds: ids };
  }

  async markRead(messageId: string): Promise<void> {
    const e = await integrationEnv();
    if (!e.WHATSAPP_PHONE_NUMBER_ID || !e.WHATSAPP_ACCESS_TOKEN) return;
    await graphRequest(
      `https://graph.facebook.com/${e.META_GRAPH_VERSION}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      e.WHATSAPP_ACCESS_TOKEN,
      { body: { messaging_product: "whatsapp", status: "read", message_id: messageId } },
      1
    );
  }
}

interface WaMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
}

interface WaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  errors?: { code?: number; title?: string }[];
}

interface WaWebhookBody {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: WaMessage[];
        statuses?: WaStatus[];
      };
    }[];
  }[];
}

export interface ParsedWhatsAppWebhook {
  messages: InboundMessage[];
  statuses: WaStatus[];
  ignored: number;
}

export function parseWhatsAppWebhook(body: WaWebhookBody, expectedPhoneNumberId?: string): ParsedWhatsAppWebhook {
  const out: ParsedWhatsAppWebhook = { messages: [], statuses: [], ignored: 0 };
  if (body.object !== "whatsapp_business_account") return out;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "messages" || !v) continue;
      if (expectedPhoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== expectedPhoneNumberId) {
        out.ignored++;
        continue;
      }
      for (const s of v.statuses ?? []) out.statuses.push(s);
      for (const m of v.messages ?? []) {
        const contact = v.contacts?.find((c) => c.wa_id === m.from);
        let text = "";
        if (m.type === "text") text = m.text?.body ?? "";
        else if (m.type === "button") text = m.button?.text ?? "";
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
        const caption = m.image?.caption ?? m.video?.caption ?? m.document?.caption;
        const attachments = ["image", "video", "audio", "document", "sticker", "location", "contacts"].includes(m.type) ? [{ type: m.type }] : [];
        text = [text, caption, describeAttachments(attachments)].filter(Boolean).join(" ").trim();
        if (!text) text = `[Customer sent: ${m.type}]`;
        out.messages.push({
          channel: "WHATSAPP",
          externalUserId: m.from,
          externalMessageId: m.id,
          text,
          attachments,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          profileName: contact?.profile?.name ?? null,
          verifiedPhone: normalizeBdPhone(m.from),
        });
      }
    }
  }
  return out;
}

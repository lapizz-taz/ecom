import type { Channel } from "@prisma/client";
import { env } from "../env";
import { graphRequest } from "./http";
import { describeAttachments, splitMessage, type ChannelAdapter, type EchoMessage, type InboundMessage, type SendOptions, type SendResult } from "./types";

/**
 * Facebook Messenger + Instagram DM adapter (Meta Graph API / Messenger Platform).
 * - Messenger: POST /me/messages with the Page access token.
 * - Instagram: either via the linked Facebook Page (same token, "Instagram API with Facebook Login")
 *   or with an Instagram-Login token (IG...) against graph.instagram.com.
 */
export class MetaAdapter implements ChannelAdapter {
  readonly maxLength: number;
  constructor(readonly channel: Extract<Channel, "MESSENGER" | "INSTAGRAM">) {
    this.maxLength = channel === "INSTAGRAM" ? 1000 : 2000;
  }

  private endpoint(): { base: string; token: string; path: string } {
    const e = env();
    if (this.channel === "INSTAGRAM" && e.INSTAGRAM_ACCESS_TOKEN) {
      const igLogin = e.INSTAGRAM_ACCESS_TOKEN.startsWith("IG");
      return {
        base: igLogin ? `https://graph.instagram.com/${e.META_GRAPH_VERSION}` : `https://graph.facebook.com/${e.META_GRAPH_VERSION}`,
        token: e.INSTAGRAM_ACCESS_TOKEN,
        path: igLogin ? `/${e.INSTAGRAM_ACCOUNT_ID ?? "me"}/messages` : `/${e.META_PAGE_ID ?? "me"}/messages`,
      };
    }
    if (!e.META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN is not configured");
    return { base: `https://graph.facebook.com/${e.META_GRAPH_VERSION}`, token: e.META_ACCESS_TOKEN, path: `/${e.META_PAGE_ID ?? "me"}/messages` };
  }

  async send(recipientId: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    let ep;
    try {
      ep = this.endpoint();
    } catch (err) {
      return { ok: false, externalIds: [], error: (err as Error).message, retryable: false };
    }
    const outside24h = opts.lastCustomerMessageAt ? Date.now() - opts.lastCustomerMessageAt.getTime() > 24 * 3600 * 1000 : false;
    const ids: string[] = [];
    for (const part of splitMessage(text, this.maxLength)) {
      const body: Record<string, unknown> = { recipient: { id: recipientId }, message: { text: part } };
      if (this.channel === "MESSENGER") {
        if (opts.humanAgent && outside24h) Object.assign(body, { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
        else body.messaging_type = "RESPONSE";
      } else if (opts.humanAgent && outside24h) {
        body.tag = "HUMAN_AGENT";
      }
      const r = await graphRequest<{ message_id?: string }>(`${ep.base}${ep.path}`, ep.token, { body });
      if (!r.ok) return { ok: false, externalIds: ids, error: r.error, retryable: r.retryable };
      if (r.data?.message_id) ids.push(r.data.message_id);
    }
    return { ok: true, externalIds: ids };
  }

  async getProfile(externalUserId: string) {
    let ep;
    try {
      ep = this.endpoint();
    } catch {
      return null;
    }
    const fields = this.channel === "INSTAGRAM" ? "name,username" : "first_name,last_name,name";
    const r = await graphRequest<{ name?: string; first_name?: string; last_name?: string; username?: string }>(
      `${ep.base}/${encodeURIComponent(externalUserId)}?fields=${fields}`,
      ep.token,
      { method: "GET" },
      1
    );
    if (!r.ok || !r.data) return null;
    const name = r.data.name || [r.data.first_name, r.data.last_name].filter(Boolean).join(" ") || null;
    return { name, username: r.data.username ?? null };
  }
}

// ---------- webhook payload parsing ----------

interface MetaMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    app_id?: number | string;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
    quick_reply?: { payload?: string };
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

interface MetaWebhookBody {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: MetaMessagingEvent[] }[];
}

export interface ParsedMetaWebhook {
  messages: InboundMessage[];
  echoes: EchoMessage[];
  ignored: number;
}

export function parseMetaWebhook(body: MetaWebhookBody): ParsedMetaWebhook {
  const out: ParsedMetaWebhook = { messages: [], echoes: [], ignored: 0 };
  const channel: Channel | null = body.object === "page" ? "MESSENGER" : body.object === "instagram" ? "INSTAGRAM" : null;
  if (!channel) return out;
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const ts = ev.timestamp ? new Date(ev.timestamp) : new Date();
      if (ev.message?.is_echo) {
        if (ev.recipient?.id && ev.message.mid) {
          out.echoes.push({
            channel,
            customerExternalId: ev.recipient.id,
            externalMessageId: ev.message.mid,
            text: ev.message.text ?? describeAttachments(ev.message.attachments?.map((a) => ({ type: a.type ?? "file" }))),
            appId: ev.message.app_id !== undefined ? String(ev.message.app_id) : null,
          });
        } else out.ignored++;
        continue;
      }
      if (ev.message && ev.sender?.id && ev.message.mid && !ev.message.is_deleted) {
        const attachments = (ev.message.attachments ?? []).map((a) => ({ type: a.type ?? "file", url: a.payload?.url ?? null }));
        const text = (ev.message.text ?? "").trim() || describeAttachments(attachments) || (ev.message.is_unsupported ? "[Customer sent an unsupported message]" : "");
        if (!text) {
          out.ignored++;
          continue;
        }
        out.messages.push({ channel, externalUserId: ev.sender.id, externalMessageId: ev.message.mid, text, attachments, timestamp: ts });
        continue;
      }
      if (ev.postback && ev.sender?.id) {
        const id = ev.postback.mid ?? `postback-${ev.sender.id}-${ev.timestamp}`;
        out.messages.push({ channel, externalUserId: ev.sender.id, externalMessageId: id, text: ev.postback.title || ev.postback.payload || "", timestamp: ts });
        continue;
      }
      out.ignored++; // reads, deliveries, reactions, etc.
    }
  }
  return out;
}

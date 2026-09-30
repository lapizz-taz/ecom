import type { Channel } from "@prisma/client";

export interface SendResult {
  ok: boolean;
  externalIds: string[];
  error?: string;
  retryable?: boolean;
}

export interface SendOptions {
  /** Human agent reply outside the 24h window (Messenger HUMAN_AGENT tag). */
  humanAgent?: boolean;
  lastCustomerMessageAt?: Date | null;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly maxLength: number;
  send(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  getProfile?(externalUserId: string): Promise<{ name: string | null; username?: string | null } | null>;
}

/** Normalized message coming from any channel. */
export interface InboundMessage {
  channel: Channel;
  externalUserId: string;
  externalMessageId: string;
  text: string;
  attachments?: { type: string; url?: string | null }[];
  timestamp?: Date;
  profileName?: string | null;
  /** Phone number proven by the channel itself (WhatsApp). */
  verifiedPhone?: string | null;
}

/** Message sent by a human from the native inbox (Meta Business Suite / IG app). */
export interface EchoMessage {
  channel: Channel;
  customerExternalId: string;
  externalMessageId: string;
  text: string;
  appId: string | null;
}

/** Split long replies at paragraph / sentence boundaries to respect platform limits. */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function describeAttachments(att: InboundMessage["attachments"]): string {
  if (!att?.length) return "";
  const kinds = [...new Set(att.map((a) => a.type))].join(", ");
  return `[Customer sent: ${kinds}]`;
}

import crypto from "node:crypto";
import type { Channel } from "@prisma/client";
import { prisma } from "../db";
import type { Env } from "../env";
import { integrationEnv } from "../integrations";
import { getSettings } from "../config/settings";
import { sendStaffAlert } from "../handoff/notify";
import { logger, errorInfo } from "../logger";
import { orderReference } from "./reference";

/**
 * Order platform forwarding (dashboard → Integrations → Order platform).
 *
 * Every order the assistant takes can be sent to another order management system as a signed JSON
 * POST — to the platform's API (with its API key header) or to a webhook (Zapier, Make, n8n, a custom
 * endpoint). Each delivery is stored in OrderForward, so a failed one is retried with the exact same
 * body and the same Idempotency-Key, and can be resent from the dashboard.
 */

export type OrderDestination = "shopify" | "platform" | "both";

/** Where confirmed orders go. Without an order platform address, everything stays in Shopify. */
export function orderDestination(e: Env): OrderDestination {
  if (!e.ORDER_WEBHOOK_URL) return "shopify";
  const d = e.ORDER_DESTINATION?.trim().toLowerCase();
  return d === "shopify" || d === "platform" ? d : "both";
}

export const ORDER_EVENT = "order.created";
export const MAX_ATTEMPTS = 6;
/** Wait before the next try, after attempt 1, 2, … (a sweep only runs when something triggers it). */
const RETRY_DELAY_MIN = [1, 5, 30, 120, 360];
const TIMEOUT_MS = 10_000;

export interface OrderLine {
  variantId: string;
  sku?: string | null;
  title: string;
  variantTitle: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderDetails {
  lines: OrderLine[];
  customer: { name: string; phone: string };
  address: { address1: string; city: string };
  zone: { id: string; label: string; fee: number };
  paymentMethod: { id: string; label: string };
  currency: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The JSON body sent to the order platform. Field names are stable — integrations map them once. */
export function buildOrderPayload(args: {
  orderId: string;
  createdAt: Date;
  channel: Channel | string;
  conversationId: string | null;
  details: OrderDetails;
  subtotal: number;
  deliveryFee: number;
  total: number;
  shopify: { orderId: string | null; orderName: string | null } | null;
  reviewRequired: boolean;
  appUrl?: string;
  test?: boolean;
}) {
  const d = args.details;
  const base = args.appUrl?.replace(/\/$/, "");
  const channel = String(args.channel).toLowerCase();
  return {
    event: args.test ? "order.test" : ORDER_EVENT,
    test: Boolean(args.test),
    id: args.orderId,
    reference: orderReference(args.orderId),
    created_at: args.createdAt.toISOString(),
    source: "isolation-ai",
    channel,
    review_required: args.reviewRequired,
    customer: { name: d.customer.name, phone: d.customer.phone },
    shipping: { address: d.address.address1, city: d.address.city, zone: d.zone.id, zone_label: d.zone.label, fee: round2(d.zone.fee) },
    items: d.lines.map((l) => ({
      title: l.title,
      variant: l.variantTitle || null,
      sku: l.sku ?? null,
      shopify_variant_id: l.variantId,
      quantity: l.quantity,
      unit_price: round2(l.unitPrice),
      total: round2(l.unitPrice * l.quantity),
    })),
    payment: { method: d.paymentMethod.id, label: d.paymentMethod.label },
    currency: d.currency,
    subtotal: round2(args.subtotal),
    delivery_fee: round2(args.deliveryFee),
    total: round2(args.total),
    shopify: args.shopify?.orderId || args.shopify?.orderName ? { order_id: args.shopify.orderId, order_name: args.shopify.orderName } : null,
    conversation_url: base && args.conversationId ? `${base}/admin/conversations/${args.conversationId}` : null,
    note: `Ordered through ${channel} chat with the Isolation AI assistant. Payment: ${d.paymentMethod.label}.`,
  };
}

export type OrderPayload = ReturnType<typeof buildOrderPayload>;

/** A made-up order for "Send a test order" and the sample on the Integrations page. */
export function sampleOrderPayload(appUrl?: string): OrderPayload {
  return buildOrderPayload({
    orderId: "cmtest0000000000000sample",
    createdAt: new Date(),
    channel: "messenger",
    conversationId: "sample",
    details: {
      lines: [{ variantId: "gid://shopify/ProductVariant/1234567890", sku: "ISO-TEE-BLK-M", title: "Classic Tee", variantTitle: "Black / M", quantity: 2, unitPrice: 850 }],
      customer: { name: "Test Customer", phone: "01700000000" },
      address: { address1: "House 1, Road 2, Dhanmondi", city: "Dhaka" },
      zone: { id: "inside_dhaka", label: "Inside Dhaka", fee: 80 },
      paymentMethod: { id: "cod", label: "Cash on delivery" },
      currency: "BDT",
    },
    subtotal: 1700,
    deliveryFee: 80,
    total: 1780,
    shopify: null,
    reviewRequired: false,
    appUrl,
    test: true,
  });
}

// ---------- sending ----------

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  /** Human explanation when it failed. */
  error: string | null;
  /** Order number / ID found in the platform's answer. */
  externalId: string | null;
  /** Worth trying again later (network problems, 5xx, 429, 408). */
  retryable: boolean;
}

function signature(secret: string, body: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

const ID_KEYS = ["order_number", "orderNumber", "order_name", "orderName", "order_id", "orderId", "reference", "number", "name", "id"];

/** Finds the platform's order number in its JSON answer: top level, or under data / order / result. */
export function extractExternalId(body: unknown): string | null {
  const look = (o: unknown): string | null => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const rec = o as Record<string, unknown>;
    for (const k of ID_KEYS) {
      const v = rec[k];
      if ((typeof v === "string" && v.trim() && v.length <= 80) || (typeof v === "number" && Number.isFinite(v))) return String(v).trim();
    }
    return null;
  };
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  return look(rec.order) ?? look(rec.data) ?? look(rec.result) ?? look(rec);
}

function describeHttpError(status: number, text: string): string {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const tail = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return `Your platform refused the request (HTTP ${status}) — check the API key header and value${tail}`;
  if (status === 404) return `Nothing was found at this address (HTTP 404) — check the URL${tail}`;
  if (status === 400 || status === 422) return `Your platform rejected the order data (HTTP ${status})${tail}`;
  if (status === 429) return `Your platform is rate limiting requests (HTTP 429)${tail}`;
  if (status >= 500) return `Your platform had an error (HTTP ${status})${tail}`;
  return `Your platform answered HTTP ${status}${tail}`;
}

/** One POST to the order platform. Never throws. */
export async function postToPlatform(e: Env, payload: unknown, opts: { deliveryId: string; idempotencyKey: string; event: string }): Promise<AttemptResult> {
  const url = e.ORDER_WEBHOOK_URL;
  if (!url) return { ok: false, status: null, error: "The order platform isn't connected (no address saved).", externalId: null, retryable: false };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Isolation-Orders/1.0",
    "X-Isolation-Event": opts.event,
    "X-Isolation-Delivery": opts.deliveryId,
    "X-Isolation-Timestamp": String(Math.floor(Date.now() / 1000)),
    "Idempotency-Key": opts.idempotencyKey,
  };
  if (e.ORDER_WEBHOOK_SECRET) headers["X-Isolation-Signature"] = signature(e.ORDER_WEBHOOK_SECRET, body);
  if (e.ORDER_WEBHOOK_AUTH_HEADER && e.ORDER_WEBHOOK_AUTH_VALUE) headers[e.ORDER_WEBHOOK_AUTH_HEADER] = e.ORDER_WEBHOOK_AUTH_VALUE;

  let res: Response;
  try {
    // No redirects: a POST turned into a GET would silently lose the order.
    res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = (err as Error).name;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "the platform";
      }
    })();
    const reason = name === "TimeoutError" || name === "AbortError" ? `${host} didn't answer within ${TIMEOUT_MS / 1000} seconds` : `Couldn't reach ${host}: ${errorCause(err)}`;
    return { ok: false, status: null, error: reason, externalId: null, retryable: true };
  }
  const text = await res.text().catch(() => "");
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    return { ok: false, status: res.status, error: `The address redirects${to ? ` to ${to.slice(0, 120)}` : ""} — paste the final address instead.`, externalId: null, retryable: false };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: describeHttpError(res.status, text), externalId: null, retryable: res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 401 || res.status === 403 };
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text.slice(0, 65_536)) : null;
  } catch {
    // Not JSON — fine, the order was accepted.
  }
  return { ok: true, status: res.status, error: null, externalId: extractExternalId(json), retryable: false };
}

function errorCause(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (err as Error).message ?? "network error";
}

// ---------- stored deliveries ----------

/** Store an order's delivery (idempotent per order + event) — call deliverForward() to send it. */
export async function queueForward(orderId: string, payload: OrderPayload) {
  return prisma.orderForward.upsert({
    where: { orderId_event: { orderId, event: ORDER_EVENT } },
    create: { orderId, event: ORDER_EVENT, payload: payload as object, nextAttemptAt: new Date() },
    update: {},
  });
}

async function recordHealth(ok: boolean, message: string) {
  const data = { ok, message: message.slice(0, 1000), notes: [], checkedAt: new Date(), checkedBy: "order delivery" };
  const previous = await prisma.integrationCheck.findUnique({ where: { service: "orders" }, select: { ok: true } });
  await prisma.integrationCheck.upsert({ where: { service: "orders" }, create: { service: "orders", ...data }, update: data });
  return previous?.ok !== false;
}

async function alert(subject: string, text: string) {
  const base = (await integrationEnv()).APP_URL?.replace(/\/$/, "") ?? "";
  await sendStaffAlert({ settings: await getSettings(), subject, text: `${text}\n${base}/admin/orders` }).catch((err) => logger.warn("order alert failed", errorInfo(err)));
}

export interface DeliveryOutcome {
  ok: boolean;
  /** Not sent this time because another attempt is running, it isn't due yet, or it was already sent. */
  skipped?: boolean;
  status: "pending" | "sent" | "failed";
  error: string | null;
  externalId: string | null;
}

/**
 * Send one stored delivery. `force` (dashboard Resend) ignores the retry schedule and revives a
 * delivery that gave up. A short lease stops two runs from sending the same order at once.
 */
export async function deliverForward(forwardId: string, opts: { force?: boolean; quickRetry?: boolean } = {}): Promise<DeliveryOutcome> {
  const now = new Date();
  const claim = await prisma.orderForward.updateMany({
    where: {
      id: forwardId,
      status: opts.force ? { in: ["pending", "failed"] } : "pending",
      ...(opts.force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }),
    },
    data: { nextAttemptAt: new Date(now.getTime() + 2 * 60_000), ...(opts.force ? { status: "pending" } : {}) },
  });
  const fwd = await prisma.orderForward.findUnique({ where: { id: forwardId }, include: { order: true } });
  if (!fwd) return { ok: false, skipped: true, status: "failed", error: "Delivery not found", externalId: null };
  if (claim.count === 0) {
    return { ok: fwd.status === "sent", skipped: true, status: fwd.status as DeliveryOutcome["status"], error: fwd.error, externalId: fwd.externalId };
  }

  const e = await integrationEnv();
  const send = () => postToPlatform(e, fwd.payload, { deliveryId: fwd.id, idempotencyKey: `${fwd.orderId}:${fwd.event}`, event: fwd.event });
  let r = await send();
  let attempts = fwd.attempts + 1;
  if (!r.ok && r.retryable && opts.quickRetry) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await send();
    attempts++;
  }
  const ref = fwd.order.platformOrderId ?? fwd.order.shopifyOrderName ?? orderReference(fwd.orderId);

  if (r.ok) {
    await prisma.$transaction([
      prisma.orderForward.update({
        where: { id: fwd.id },
        data: { status: "sent", attempts, responseCode: r.status, error: null, externalId: r.externalId, sentAt: new Date(), nextAttemptAt: null },
      }),
      prisma.order.update({
        where: { id: fwd.orderId },
        data: {
          platformOrderId: r.externalId ?? fwd.order.platformOrderId,
          ...(fwd.order.status === "platform_pending" ? { status: "sent_to_platform" } : {}),
        },
      }),
    ]);
    await recordHealth(true, `Order ${r.externalId ?? ref} was delivered to your order platform (HTTP ${r.status}).`);
    return { ok: true, status: "sent", error: null, externalId: r.externalId };
  }

  const gaveUp = attempts >= MAX_ATTEMPTS || !r.retryable;
  const delay = RETRY_DELAY_MIN[Math.min(attempts - 1, RETRY_DELAY_MIN.length - 1)]!;
  await prisma.orderForward.update({
    where: { id: fwd.id },
    data: {
      status: gaveUp ? "failed" : "pending",
      attempts,
      responseCode: r.status,
      error: r.error?.slice(0, 500) ?? null,
      nextAttemptAt: gaveUp ? null : new Date(Date.now() + delay * 60_000),
    },
  });
  const wasHealthy = await recordHealth(false, `Couldn't deliver order ${ref}: ${r.error}`);
  logger.warn("order forward failed", { forwardId: fwd.id, attempts, status: r.status, gaveUp });
  if (gaveUp) {
    await alert(
      "Isolation: an order didn't reach your order platform",
      `⚠️ Order ${ref} couldn't be sent to your order platform${attempts > 1 ? ` after ${attempts} tries` : ""}: ${r.error}\nAdd it by hand or fix the connection and click Resend.`
    );
  } else if (wasHealthy) {
    await alert("Isolation: order platform isn't answering", `⚠️ Order ${ref} couldn't be sent to your order platform yet: ${r.error}\nIt will be retried automatically.`);
  }
  return { ok: false, status: gaveUp ? "failed" : "pending", error: r.error, externalId: null };
}

/** Retry deliveries that are due (daily maintenance, after a successful delivery, and on new chat activity). */
export async function retryDueForwards(opts: { limit?: number; except?: string } = {}) {
  const due = await prisma.orderForward.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() }, ...(opts.except ? { id: { not: opts.except } } : {}) },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 10,
    select: { id: true },
  });
  const report = { retried: 0, sent: 0 };
  for (const d of due) {
    const r = await deliverForward(d.id);
    if (r.skipped) continue;
    report.retried++;
    if (r.ok) report.sent++;
    else if (r.status === "pending" && r.error) break; // still down — don't hammer it
  }
  return report;
}

/** "Send a test order" on the Integrations page — nothing is stored. */
export async function sendTestOrder(e: Env): Promise<AttemptResult> {
  const id = `test_${crypto.randomBytes(6).toString("hex")}`;
  return postToPlatform(e, sampleOrderPayload(e.APP_URL), { deliveryId: id, idempotencyKey: id, event: "order.test" });
}

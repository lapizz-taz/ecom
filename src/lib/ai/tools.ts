import { z } from "zod";
import type { Channel } from "@prisma/client";
import { prisma } from "../db";
import { logger, errorInfo } from "../logger";
import { enabledPaymentMethods, resolveDeliveryZone, type Settings } from "../config/settings";
import { byCategory, getPolicy, POLICY_TOPICS, searchFaq } from "../knowledge";
import {
  normalizeOrderNumber,
  ShopifyNotConfiguredError,
  ShopifyUnavailableError,
  type OrderInfo,
  type ProductInfo,
  type ShopifyProvider,
  type VariantInfo,
} from "../shopify";
import { normalizeBdPhone, phonesMatch } from "../utils/phone";
import { rateLimit } from "../security/rateLimit";
import { isAffirmative } from "./guards";
import type { LlmToolDef } from "./llm";

/**
 * Controlled tool layer. The model can ONLY act through these functions; every input
 * is validated with zod, every output is compact JSON with no private data of other customers.
 */

export interface ToolContext {
  conversationId: string;
  customerId: string;
  channel: Channel;
  inboundMessageId: string;
  inboundText: string;
  /** Phone proven by the channel itself (WhatsApp sender). */
  verifiedPhone: string | null;
  settings: Settings;
  shopify: ShopifyProvider | null;
  /** Side effects collected during the turn */
  state: {
    handoff: { reason: string; detail?: string } | null;
    shopifyFailed: boolean;
    orderFailed: boolean;
    orderConfirmed: { orderName: string | null; mode: "complete" | "draft" } | null;
  };
}

export interface ToolTrace {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  durationMs: number;
}

export const HANDOFF_REASONS = [
  "customer_requested_human",
  "angry_customer",
  "complaint",
  "refund_request",
  "exchange_request",
  "discount_request",
  "cancellation_request",
  "policy_unclear",
  "payment_problem",
  "delivery_problem",
  "order_failed",
  "order_lookup_unverified",
  "low_confidence",
  "other",
] as const;

// ---------- helpers ----------

function stockHint(v: VariantInfo): "in_stock" | "low_stock" | "out_of_stock" | "available_untracked" {
  if (!v.available) return "out_of_stock";
  if (!v.tracked || v.inventoryQuantity === null) return "available_untracked";
  if (v.inventoryQuantity <= 0) return "in_stock"; // sellable (continue-selling policy) but no counted stock
  return v.inventoryQuantity <= 3 ? "low_stock" : "in_stock";
}

function productView(p: ProductInfo, detail: "short" | "full") {
  const base = {
    product_id: p.id,
    title: p.title,
    url: p.url,
    price: p.priceMin === p.priceMax ? p.priceMin : { from: p.priceMin, to: p.priceMax },
    currency: p.currency,
    available: p.available,
    product_type: p.productType,
    options: p.options,
  };
  if (detail === "short") return base;
  return {
    ...base,
    description: p.description.slice(0, 500),
    image: p.image,
    tags: p.tags.slice(0, 15),
    variants: p.variants.map((v) => ({
      variant_id: v.id,
      title: v.title,
      options: v.options,
      price: v.price,
      compare_at_price: v.compareAtPrice,
      available: v.available,
      stock_hint: stockHint(v),
    })),
  };
}

function orderView(o: OrderInfo) {
  return {
    order_number: o.name,
    placed_on: o.createdAt.slice(0, 10),
    payment_status: o.financialStatus,
    fulfillment_status: o.fulfillmentStatus,
    cancelled: o.cancelled,
    total: o.total,
    currency: o.currency,
    items: o.items,
    tracking: o.tracking.filter((t) => t.number || t.url),
  };
}

function requireShopify(ctx: ToolContext): ShopifyProvider {
  if (!ctx.shopify) throw new ShopifyNotConfiguredError();
  return ctx.shopify;
}

function money(n: number) {
  return Math.round(n * 100) / 100;
}

// ---------- tool definitions ----------

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const shortText = (max: number) => z.string().trim().min(1).max(max);
const gid = (type: string) => z.string().trim().regex(new RegExp(`^gid://shopify/${type}/[\\w-]+$`), `must be a Shopify ${type} id`);

export const TOOLS = [
  tool({
    name: "search_products",
    description:
      "Search Isolation's live Shopify catalogue. Use English keywords (e.g. 'belt', 'rimless glasses', 'silver ring', 'wallet chain'). Returns only active products; by default only available ones.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords in English" },
        max_price: { type: "number", description: "Customer's budget in BDT, if stated" },
        only_available: { type: "boolean", description: "Default true" },
        limit: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    schema: z.object({
      query: shortText(100),
      max_price: z.number().positive().max(1_000_000).optional(),
      only_available: z.boolean().optional(),
      limit: z.number().int().min(1).max(8).optional(),
    }),
    async run(input, ctx) {
      const shopify = requireShopify(ctx);
      let products = await shopify.searchProducts(input.query, { limit: input.limit ?? 5, maxPrice: input.max_price });
      if (input.only_available !== false) products = products.filter((p) => p.available);
      return { count: products.length, budget_filter: input.max_price ?? null, products: products.map((p) => productView(p, "short")) };
    },
  }),

  tool({
    name: "get_product",
    description: "Get full live details of one product: variants (size/colour), prices, availability, link, image.",
    parameters: {
      type: "object",
      properties: { product_id: { type: "string", description: "Shopify product id (gid://shopify/Product/...) or product handle" } },
      required: ["product_id"],
      additionalProperties: false,
    },
    schema: z.object({ product_id: z.union([gid("Product"), z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,200}$/)]) }),
    async run(input, ctx) {
      const p = await requireShopify(ctx).getProduct(input.product_id);
      if (!p || p.status !== "ACTIVE") return { found: false };
      return { found: true, product: productView(p, "full") };
    },
  }),

  tool({
    name: "check_inventory",
    description: "Check live availability of a specific variant (size/colour) before confirming stock or ordering.",
    parameters: {
      type: "object",
      properties: { variant_id: { type: "string", description: "gid://shopify/ProductVariant/..." } },
      required: ["variant_id"],
      additionalProperties: false,
    },
    schema: z.object({ variant_id: gid("ProductVariant") }),
    async run(input, ctx) {
      const r = await requireShopify(ctx).getVariant(input.variant_id);
      if (!r) return { found: false };
      return {
        found: true,
        product_title: r.product.title,
        variant_title: r.variant.title,
        options: r.variant.options,
        price: r.variant.price,
        available: r.variant.available,
        stock_hint: stockHint(r.variant),
        url: r.product.url,
      };
    },
  }),

  tool({
    name: "get_delivery_info",
    description:
      "Delivery charges and (if configured) estimated delivery times per zone. Pass the customer's area/city to resolve their zone when it is configured.",
    parameters: {
      type: "object",
      properties: { area: { type: "string", description: "Customer's area/city, if known" } },
      additionalProperties: false,
    },
    schema: z.object({ area: z.string().trim().max(200).optional() }),
    async run(input, ctx) {
      const s = ctx.settings;
      const zones = s.delivery.zones.map((z) => ({
        zone: z.id,
        label: z.label,
        fee: z.fee,
        estimated_time: z.estimatedTime ?? "not_confirmed",
      }));
      const matched = input.area ? resolveDeliveryZone(s, { area: input.area }) : null;
      return {
        currency: s.business.currency,
        zones,
        matched_zone: matched ? matched.id : null,
        note: matched ? undefined : input.area ? "Area not in configured lists — ask whether it is inside Dhaka, a Dhaka suburb or outside Dhaka." : undefined,
        delivery_notes: s.delivery.notes,
      };
    },
  }),

  tool({
    name: "get_payment_methods",
    description: "Payment methods Isolation currently accepts, with official instructions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      return {
        methods: enabledPaymentMethods(ctx.settings).map((m) => ({ id: m.id, label: m.label, instructions: m.instructions })),
        notes: ctx.settings.payment.notes,
        never_ask_for: ["OTP", "PIN", "password", "full card number"],
      };
    },
  }),

  tool({
    name: "get_policy",
    description: "Official Isolation policy text. available=false means the policy is not confirmed — do not answer it yourself.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", enum: [...POLICY_TOPICS] } },
      required: ["topic"],
      additionalProperties: false,
    },
    schema: z.object({ topic: z.enum(POLICY_TOPICS) }),
    async run(input) {
      const p = await getPolicy(input.topic);
      return p ? { available: true, topic: input.topic, policy: p.content } : { available: false, topic: input.topic, instruction: "Tell the customer a team member will confirm, and call request_human with reason policy_unclear." };
    },
  }),

  tool({
    name: "get_faq",
    description: "Search the official Isolation FAQ.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    schema: z.object({ question: shortText(300) }),
    async run(input) {
      const results = await searchFaq(input.question);
      return { results };
    },
  }),

  tool({
    name: "get_promotions",
    description: "Currently active promotions/offers. Empty = no promotion; you cannot give discounts yourself.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    async run() {
      const promos = await byCategory("PROMOTION");
      return { active_promotions: promos.map((p) => ({ title: p.title, details: p.content })) };
    },
  }),

  tool({
    name: "get_order",
    description:
      "Look up an existing order's status. Requires the order number AND the phone number used on the order (phone alone is accepted only on WhatsApp when it is the sender's own number).",
    parameters: {
      type: "object",
      properties: {
        order_number: { type: "string", description: "e.g. #1234 or 1234" },
        phone: { type: "string", description: "Phone number used for the order" },
      },
      additionalProperties: false,
    },
    schema: z.object({ order_number: z.string().trim().max(30).optional(), phone: z.string().trim().max(30).optional() }),
    async run(input, ctx) {
      const shopify = requireShopify(ctx);
      const attempts = await rateLimit(`order-lookup:${ctx.conversationId}`, 6, 3600);
      if (!attempts.allowed) {
        return { status: "too_many_attempts", instruction: "Do not retry. Offer to connect the team (request_human, reason order_lookup_unverified)." };
      }
      const phone = input.phone ? normalizeBdPhone(input.phone) : null;
      if (input.phone && !phone) return { status: "invalid_phone", instruction: "Ask for the 11-digit Bangladeshi phone number used on the order." };

      if (input.order_number) {
        const orderNumber = normalizeOrderNumber(input.order_number);
        if (!orderNumber) return { status: "invalid_order_number" };
        const checkPhone = phone ?? ctx.verifiedPhone;
        if (!checkPhone) return { status: "need_phone", instruction: "Ask for the phone number used on this order to verify ownership." };
        const order = await shopify.findOrderByName(orderNumber);
        // Same response whether the order doesn't exist or the phone doesn't match (no enumeration).
        if (!order || !order.phones.some((p) => phonesMatch(p, checkPhone))) {
          return { status: "not_verified", instruction: "Say you couldn't match that order number with that phone number. Ask them to double-check, or offer the team." };
        }
        return { status: "found", orders: [orderView(order)] };
      }

      if (phone) {
        const channelVerified = (ctx.verifiedPhone && phonesMatch(phone, ctx.verifiedPhone)) || false;
        if (!channelVerified) return { status: "need_order_number", instruction: "Ask for the order number as well, to verify the order belongs to them." };
        const orders = await shopify.findOrdersByPhone(phone, 3);
        if (!orders.length) return { status: "not_found" };
        return { status: "found", orders: orders.map(orderView) };
      }
      return { status: "need_order_number_and_phone" };
    },
  }),

  tool({
    name: "create_draft_order",
    description:
      "Prepare an order for the customer's confirmation (does NOT place it). Prices are taken from live Shopify data. Returns summary_text to show the customer.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              variant_id: { type: "string", description: "gid://shopify/ProductVariant/..." },
              quantity: { type: "integer", minimum: 1 },
            },
            required: ["variant_id", "quantity"],
            additionalProperties: false,
          },
        },
        customer_name: { type: "string" },
        phone: { type: "string" },
        address: { type: "string", description: "Full delivery address (house, road, area)" },
        city: { type: "string", description: "Area / city / district" },
        delivery_zone: { type: "string", description: "Zone id from BUSINESS DATA, only if clear" },
        payment_method: { type: "string", description: "Payment method id, e.g. cod" },
      },
      required: ["items", "customer_name", "phone", "address", "city", "payment_method"],
      additionalProperties: false,
    },
    schema: z.object({
      items: z.array(z.object({ variant_id: gid("ProductVariant"), quantity: z.number().int().min(1).max(100) })).min(1).max(10),
      customer_name: z.string().trim().min(2).max(100),
      phone: z.string().trim().min(6).max(30),
      address: z.string().trim().min(8).max(500),
      city: z.string().trim().min(2).max(100),
      delivery_zone: z.string().trim().max(40).optional(),
      payment_method: z.string().trim().max(40),
    }),
    async run(input, ctx) {
      const s = ctx.settings;
      if (!s.ai.allowOrderCreation) {
        return { ok: false, error: "order_creation_disabled", instruction: "Tell the customer the team will place the order, and call request_human with reason other." };
      }
      const phone = normalizeBdPhone(input.phone);
      if (!phone) return { ok: false, error: "invalid_phone", instruction: "Ask for a valid 11-digit Bangladeshi mobile number (01XXXXXXXXX)." };
      const method = enabledPaymentMethods(s).find((m) => m.id === input.payment_method.toLowerCase());
      if (!method) {
        return { ok: false, error: "payment_method_not_available", available_methods: enabledPaymentMethods(s).map((m) => ({ id: m.id, label: m.label })) };
      }
      // A configured area list beats the model's guess.
      const byArea = resolveDeliveryZone(s, { area: `${input.city} ${input.address}` });
      const zone = byArea ?? resolveDeliveryZone(s, { zone: input.delivery_zone });
      if (!zone) {
        return { ok: false, error: "delivery_zone_unclear", zones: s.delivery.zones.map((z) => ({ zone: z.id, label: z.label, fee: z.fee })), instruction: "Ask the customer which zone applies." };
      }

      const shopify = requireShopify(ctx);
      const lines: { variantId: string; title: string; variantTitle: string; quantity: number; unitPrice: number }[] = [];
      for (const item of input.items) {
        if (item.quantity > s.ai.maxQuantityPerItem) {
          return { ok: false, error: "quantity_too_large", max: s.ai.maxQuantityPerItem, instruction: "For bulk orders call request_human." };
        }
        const r = await shopify.getVariant(item.variant_id);
        if (!r || r.product.status !== "ACTIVE") return { ok: false, error: "variant_not_found", variant_id: item.variant_id };
        if (!r.variant.available) return { ok: false, error: "out_of_stock", product: r.product.title, variant: r.variant.title };
        if (r.variant.tracked && r.variant.inventoryQuantity !== null && r.variant.inventoryQuantity > 0 && r.variant.inventoryQuantity < item.quantity) {
          return { ok: false, error: "insufficient_stock", product: r.product.title, variant: r.variant.title, available_quantity: r.variant.inventoryQuantity };
        }
        lines.push({
          variantId: r.variant.id,
          title: r.product.title,
          variantTitle: r.variant.title === "Default Title" ? "" : r.variant.title,
          quantity: item.quantity,
          unitPrice: r.variant.price,
        });
      }
      const subtotal = money(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
      const deliveryFee = money(zone.fee);
      const total = money(subtotal + deliveryFee);
      const cur = s.business.currencySymbol;

      const summaryLines = [
        ...lines.map((l) => `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}${l.quantity > 1 ? ` x${l.quantity}` : ""} — ${cur}${money(l.unitPrice * l.quantity)}`),
        `Delivery (${zone.label}) — ${cur}${deliveryFee}`,
        `Total — ${cur}${total}`,
        `Name: ${input.customer_name}`,
        `Phone: ${phone}`,
        `Address: ${input.address}, ${input.city}`,
        `Payment: ${method.label}`,
      ];

      await prisma.draftOrder.updateMany({
        where: { conversationId: ctx.conversationId, status: "AWAITING_CONFIRMATION" },
        data: { status: "CANCELLED" },
      });
      const draft = await prisma.draftOrder.create({
        data: {
          conversationId: ctx.conversationId,
          createdFromMessageId: ctx.inboundMessageId,
          subtotal,
          deliveryFee,
          total,
          payload: {
            lines,
            customer: { name: input.customer_name, phone },
            address: { address1: input.address, city: input.city },
            zone: { id: zone.id, label: zone.label, fee: deliveryFee },
            paymentMethod: { id: method.id, label: method.label },
            currency: s.business.currency,
            summaryLines,
          },
        },
      });
      // Remember the phone the customer gave on their profile (unverified).
      await prisma.customer.updateMany({ where: { id: ctx.customerId, phone: null }, data: { phone, name: input.customer_name } });

      return {
        ok: true,
        draft_id: draft.id,
        subtotal,
        delivery_fee: deliveryFee,
        total,
        currency: s.business.currency,
        summary_text: summaryLines.join("\n"),
        instruction: "Show summary_text and ask the customer to confirm. The order is NOT placed yet.",
      };
    },
  }),

  tool({
    name: "confirm_order",
    description:
      "Place the order in Shopify. ONLY call after the customer explicitly confirmed the summary in their latest message.",
    parameters: {
      type: "object",
      properties: { draft_id: { type: "string" } },
      required: ["draft_id"],
      additionalProperties: false,
    },
    schema: z.object({ draft_id: z.string().trim().min(5).max(40) }),
    async run(input, ctx) {
      const s = ctx.settings;
      const draft = await prisma.draftOrder.findFirst({ where: { id: input.draft_id, conversationId: ctx.conversationId } });
      if (!draft) return { ok: false, error: "draft_not_found" };
      if (draft.status !== "AWAITING_CONFIRMATION") return { ok: false, error: `draft_${draft.status.toLowerCase()}` };
      if (draft.createdFromMessageId === ctx.inboundMessageId) {
        return { ok: false, error: "customer_has_not_seen_summary", instruction: "Show the summary first and wait for the customer's confirmation." };
      }
      if (!isAffirmative(ctx.inboundText)) {
        return { ok: false, error: "no_explicit_confirmation", instruction: "Ask the customer to reply 'confirm' (or yes) to place the order." };
      }
      if (Date.now() - draft.createdAt.getTime() > 24 * 3600 * 1000) {
        await prisma.draftOrder.update({ where: { id: draft.id }, data: { status: "EXPIRED" } });
        return { ok: false, error: "draft_expired", instruction: "Re-check stock and prices, create a new draft." };
      }
      // Atomic transition prevents double orders from duplicate/parallel confirmations.
      const lock = await prisma.draftOrder.updateMany({ where: { id: draft.id, status: "AWAITING_CONFIRMATION" }, data: { status: "PROCESSING" } });
      if (lock.count === 0) return { ok: false, error: "already_processing" };

      const payload = draft.payload as {
        lines: { variantId: string; title: string; variantTitle: string; quantity: number; unitPrice: number }[];
        customer: { name: string; phone: string };
        address: { address1: string; city: string };
        zone: { id: string; label: string; fee: number };
        paymentMethod: { id: string; label: string };
        currency: string;
      };

      const fail = async (error: string) => {
        await prisma.draftOrder.update({ where: { id: draft.id }, data: { status: "FAILED", error: error.slice(0, 500) } });
        ctx.state.orderFailed = true;
        ctx.state.handoff = { reason: "order_failed", detail: `Order could not be created automatically (draft ${draft.id}): ${error.slice(0, 200)}` };
        return { ok: false, error: "order_failed", instruction: "Tell the customer the order could not be completed automatically and the team will finish it. Do NOT say it is confirmed." };
      };

      try {
        const shopify = requireShopify(ctx);
        const result = await shopify.createOrder({
          items: payload.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, title: l.title, unitPrice: l.unitPrice })),
          customer: payload.customer,
          address: { address1: payload.address.address1, city: payload.address.city, zoneLabel: payload.zone.label },
          shipping: { title: `Delivery — ${payload.zone.label}`, fee: payload.zone.fee },
          currency: payload.currency,
          paymentMethod: payload.paymentMethod,
          note: `Created by Isolation AI assistant via ${ctx.channel.toLowerCase()} chat. Payment: ${payload.paymentMethod.label}.`,
          tags: ["isolation-ai", `channel-${ctx.channel.toLowerCase()}`, `payment-${payload.paymentMethod.id}`],
          mode: s.ai.orderCreationMode,
        });
        if (!result.ok) return fail(result.error);

        await prisma.draftOrder.update({ where: { id: draft.id }, data: { status: "CONFIRMED", shopifyDraftId: result.draftId } });
        await prisma.order.create({
          data: {
            customerId: ctx.customerId,
            conversationId: ctx.conversationId,
            shopifyOrderId: result.orderId,
            shopifyOrderName: result.orderName,
            shopifyDraftId: result.draftId,
            status: result.mode === "complete" ? "created" : "draft_pending_review",
            total: draft.total,
            channel: ctx.channel,
          },
        });
        ctx.state.orderConfirmed = { orderName: result.orderName, mode: result.mode };
        if (result.mode === "draft") {
          return {
            ok: true,
            mode: "draft",
            status: "received_pending_team_review",
            instruction: "Tell the customer their order request is received and the team will confirm it shortly. Do NOT say it is confirmed.",
          };
        }
        return {
          ok: true,
          mode: "complete",
          order_number: result.orderName,
          total: Number(draft.total),
          payment: payload.paymentMethod.label,
          instruction: "Tell the customer the order is placed, with the order number. Keep it short and warm.",
        };
      } catch (err) {
        if (err instanceof ShopifyUnavailableError || err instanceof ShopifyNotConfiguredError) {
          ctx.state.shopifyFailed = true;
        }
        logger.error("confirm_order failed", { draftId: draft.id, ...errorInfo(err) });
        return fail(err instanceof Error ? err.message : "unknown error");
      }
    },
  }),

  tool({
    name: "cancel_draft_order",
    description: "Discard the order summary awaiting confirmation (nothing was placed yet) when the customer no longer wants it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      const r = await prisma.draftOrder.updateMany({
        where: { conversationId: ctx.conversationId, status: "AWAITING_CONFIRMATION" },
        data: { status: "CANCELLED" },
      });
      return { ok: true, cancelled_drafts: r.count, note: "Nothing had been placed in Shopify." };
    },
  }),

  tool({
    name: "request_human",
    description: "Hand the conversation to the Isolation team. The AI stops replying until a human returns it.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: [...HANDOFF_REASONS] },
        summary: { type: "string", description: "One-line summary for the team" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    schema: z.object({ reason: z.enum(HANDOFF_REASONS), summary: z.string().trim().max(500).optional() }),
    async run(input, ctx) {
      ctx.state.handoff = { reason: input.reason, detail: input.summary };
      return { ok: true, instruction: "Tell the customer briefly that a team member will reply here. Do not promise a specific time or outcome." };
    },
  }),

  tool({
    name: "get_customer_history",
    description: "This customer's own previous orders placed through chat and whether they are a returning customer.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      const [orders, conversations] = await Promise.all([
        prisma.order.findMany({ where: { customerId: ctx.customerId }, orderBy: { createdAt: "desc" }, take: 3 }),
        prisma.conversation.count({ where: { customerId: ctx.customerId } }),
      ]);
      return {
        returning_customer: conversations > 1 || orders.length > 0,
        orders_via_chat: orders.map((o) => ({ order_number: o.shopifyOrderName, status: o.status, date: o.createdAt.toISOString().slice(0, 10) })),
      };
    },
  }),
] as const;

type AnyTool = ToolDef<z.ZodTypeAny>;
const REGISTRY = new Map<string, AnyTool>((TOOLS as unknown as readonly AnyTool[]).map((t) => [t.name, t]));

export function toolDefinitions(): LlmToolDef[] {
  return (TOOLS as unknown as readonly AnyTool[]).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

const SHOPIFY_TOOLS = new Set(["search_products", "get_product", "check_inventory", "get_order", "create_draft_order", "confirm_order"]);

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolTrace> {
  const started = Date.now();
  const def = REGISTRY.get(name);
  let input: unknown = rawArgs;
  const done = (output: unknown, ok: boolean): ToolTrace => ({ name, input, output, ok, durationMs: Date.now() - started });

  if (!def) return done({ error: "unknown_tool" }, false);
  try {
    input = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return done({ error: "invalid_json_arguments" }, false);
  }
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) {
    return done({ error: "invalid_arguments", details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, false);
  }
  try {
    const output = await def.run(parsed.data, ctx);
    const ok = !(output && typeof output === "object" && "ok" in output && (output as { ok: unknown }).ok === false);
    return done(output, ok);
  } catch (err) {
    if (err instanceof ShopifyUnavailableError || err instanceof ShopifyNotConfiguredError) {
      if (SHOPIFY_TOOLS.has(name)) ctx.state.shopifyFailed = true;
      logger.warn("shopify tool failure", { tool: name, ...errorInfo(err) });
      return done({ error: "shopify_unavailable", instruction: "Do not guess. The system will tell the customer the team will confirm." }, false);
    }
    logger.error("tool failure", { tool: name, ...errorInfo(err) });
    return done({ error: "tool_error" }, false);
  }
}

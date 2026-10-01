import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { clearIntegrationCache, describeIntegrations, integrationEnv, IntegrationValueError, normalizeValue, saveIntegrationValues } from "@/lib/integrations";
import { testConnection } from "@/lib/integrations/connect";
import { checkAllConfigured, integrationHealth } from "@/lib/integrations/health";
import {
  buildOrderPayload, deliverForward, extractExternalId, MAX_ATTEMPTS, orderDestination, queueForward, retryDueForwards, sampleOrderPayload,
} from "@/lib/orders/forward";
import { MockShopifyProvider } from "@/lib/shopify";
import type { LlmMessage } from "@/lib/ai/llm";
import { call, resetDb, say, systemPrompt, turn } from "./helpers";

const URL_ = "https://oms.example.com/api/orders?token=s3cr3t-path";
const ALERT_HOOK = "https://hooks.example.com/alerts";

interface Hit { url: string; headers: Record<string, string>; body: string }

/** The order platform answers with `answer` (status + JSON); staff alerts are recorded separately. */
function platform(answer: { status: number; json?: unknown } | (() => { status: number; json?: unknown }) | Error) {
  const hits: Hit[] = [];
  const alerts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith(ALERT_HOOK)) {
      alerts.push(JSON.parse(String(init?.body)).text);
      return new Response("ok");
    }
    hits.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
    if (answer instanceof Error) throw answer;
    const a = typeof answer === "function" ? answer() : answer;
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), { status: a.status });
  });
  return { hits, alerts };
}

async function connect(values: Record<string, string> = {}) {
  await saveIntegrationValues({ ORDER_WEBHOOK_URL: URL_, ...values }, "admin@test");
}

async function makeOrder(status = "platform_pending") {
  const customer = await prisma.customer.create({ data: { name: "Rahim" } });
  return prisma.order.create({ data: { customerId: customer.id, status, total: 879 } });
}

beforeEach(async () => {
  await resetDb();
  MockShopifyProvider.createdOrders = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HANDOFF_WEBHOOK_URL;
  resetEnvCache();
  clearIntegrationCache();
});

describe("order platform settings", () => {
  it("validates what admins type", () => {
    expect(() => normalizeValue("ORDER_WEBHOOK_URL", "http://oms.example.com/hook")).toThrow(/https/);
    expect(() => normalizeValue("ORDER_WEBHOOK_URL", "oms.example.com")).toThrow(IntegrationValueError);
    expect(normalizeValue("ORDER_WEBHOOK_URL", " https://oms.example.com/hook ")).toBe("https://oms.example.com/hook");
    expect(() => normalizeValue("ORDER_WEBHOOK_AUTH_HEADER", "X API Key")).toThrow();
    expect(() => normalizeValue("ORDER_WEBHOOK_AUTH_HEADER", "Content-Type")).toThrow(/set automatically/);
    expect(normalizeValue("ORDER_WEBHOOK_AUTH_HEADER", "X-API-Key")).toBe("X-API-Key");
    // "Bearer <token>" has a space, which is fine for the key itself — line breaks are not.
    expect(normalizeValue("ORDER_WEBHOOK_AUTH_VALUE", "Bearer abc123")).toBe("Bearer abc123");
    expect(() => normalizeValue("ORDER_WEBHOOK_AUTH_VALUE", "Bearer abc\n123")).toThrow(/line breaks/);
    expect(normalizeValue("ORDER_DESTINATION", "Platform")).toBe("platform");
    expect(() => normalizeValue("ORDER_DESTINATION", "erp")).toThrow();
  });

  it("chooses where orders go", async () => {
    expect(orderDestination(await integrationEnv())).toBe("shopify");
    await connect();
    expect(orderDestination(await integrationEnv({ fresh: true }))).toBe("both");
    await saveIntegrationValues({ ORDER_DESTINATION: "platform" }, "admin@test");
    expect(orderDestination(await integrationEnv({ fresh: true }))).toBe("platform");
  });

  it("never shows the saved address, only its host", async () => {
    await connect({ ORDER_WEBHOOK_AUTH_VALUE: "Bearer topsecret" });
    const { fields, status } = await describeIntegrations();
    expect(fields.ORDER_WEBHOOK_URL.value).toBeNull();
    expect(fields.ORDER_WEBHOOK_URL.hint).toBe("oms.example.com …path");
    expect(fields.ORDER_WEBHOOK_AUTH_VALUE.value).toBeNull();
    expect(status.orders).toBe(true);
  });
});

describe("sending an order", () => {
  it("signs the body and sends the API key and a stable idempotency key", async () => {
    await connect({ ORDER_WEBHOOK_AUTH_HEADER: "X-API-Key", ORDER_WEBHOOK_AUTH_VALUE: "k_live_1", ORDER_WEBHOOK_SECRET: "whsec_test" });
    const { hits } = platform({ status: 201, json: { data: { order_number: "OMS-77" } } });
    const order = await makeOrder();
    const fwd = await queueForward(order.id, sampleOrderPayload());
    const r = await deliverForward(fwd.id);

    expect(r).toMatchObject({ ok: true, status: "sent", externalId: "OMS-77" });
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.url).toBe(URL_);
    expect(h.headers["x-api-key"]).toBe("k_live_1");
    expect(h.headers["idempotency-key"]).toBe(`${order.id}:order.created`);
    expect(h.headers["x-isolation-signature"]).toBe(`sha256=${crypto.createHmac("sha256", "whsec_test").update(h.body).digest("hex")}`);
    expect(JSON.parse(h.body)).toMatchObject({ items: [{ sku: "ISO-TEE-BLK-M", quantity: 2 }], total: 1780 });

    const saved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved).toMatchObject({ status: "sent_to_platform", platformOrderId: "OMS-77" });
    expect(await prisma.integrationCheck.findUnique({ where: { service: "orders" } })).toMatchObject({ ok: true });
  });

  it("retries later when the platform is down, and alerts staff once", async () => {
    process.env.HANDOFF_WEBHOOK_URL = ALERT_HOOK;
    resetEnvCache();
    await connect();
    const { hits, alerts } = platform({ status: 503, json: { error: "maintenance" } });
    const a = await queueForward((await makeOrder()).id, sampleOrderPayload());
    const r = await deliverForward(a.id);
    expect(r).toMatchObject({ ok: false, status: "pending" });
    expect(r.error).toMatch(/HTTP 503/);
    const row = await prisma.orderForward.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/retried automatically/);
    expect((await integrationHealth()).orders).toBe("problem");

    // Not due yet: a sweep leaves it alone.
    expect(await retryDueForwards()).toEqual({ retried: 0, sent: 0 });
    expect(hits).toHaveLength(1);

    // A second order failing doesn't repeat the alert.
    const b = await queueForward((await makeOrder()).id, sampleOrderPayload());
    await deliverForward(b.id);
    expect(alerts).toHaveLength(1);
  });

  it("gives up after the last attempt and on answers that won't change", async () => {
    process.env.HANDOFF_WEBHOOK_URL = ALERT_HOOK;
    resetEnvCache();
    await connect();
    const { alerts } = platform({ status: 422, json: { message: "phone is invalid" } });
    const fwd = await queueForward((await makeOrder()).id, sampleOrderPayload());
    const r = await deliverForward(fwd.id);
    expect(r).toMatchObject({ ok: false, status: "failed" });
    expect(r.error).toMatch(/rejected the order data \(HTTP 422\): {"message":"phone is invalid"}/);
    expect(alerts.at(-1)).toMatch(/couldn't be sent/);

    vi.restoreAllMocks();
    platform({ status: 500 });
    const late = await queueForward((await makeOrder()).id, sampleOrderPayload());
    await prisma.orderForward.update({ where: { id: late.id }, data: { attempts: MAX_ATTEMPTS - 1 } });
    expect(await deliverForward(late.id)).toMatchObject({ status: "failed" });
  });

  it("Resend revives a delivery that gave up", async () => {
    await connect();
    platform({ status: 404 });
    const fwd = await queueForward((await makeOrder()).id, sampleOrderPayload());
    expect(await deliverForward(fwd.id)).toMatchObject({ status: "failed" });
    // A normal retry run ignores it…
    expect(await deliverForward(fwd.id)).toMatchObject({ skipped: true });
    vi.restoreAllMocks();
    platform({ status: 200, json: { id: 991 } });
    // …but staff can resend it.
    expect(await deliverForward(fwd.id, { force: true })).toMatchObject({ ok: true, externalId: "991" });
  });

  it("never sends the same order twice at once", async () => {
    await connect();
    const { hits } = platform({ status: 200, json: {} });
    const fwd = await queueForward((await makeOrder()).id, sampleOrderPayload());
    await Promise.all([deliverForward(fwd.id), deliverForward(fwd.id), retryDueForwards()]);
    expect(hits).toHaveLength(1);
  });

  it("explains network problems", async () => {
    await connect();
    platform(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    const fwd = await queueForward((await makeOrder()).id, sampleOrderPayload());
    expect((await deliverForward(fwd.id)).error).toBe("Couldn't reach oms.example.com: ENOTFOUND");
  });

  it("finds the platform's order number in common answer shapes", () => {
    expect(extractExternalId({ order: { name: "#1042" } })).toBe("#1042");
    expect(extractExternalId({ orderNumber: 5531, id: "x" })).toBe("5531");
    expect(extractExternalId({ success: true })).toBeNull();
    expect(extractExternalId([1, 2])).toBeNull();
  });

  it("builds the payload from the confirmed draft", () => {
    const p = buildOrderPayload({
      orderId: "ord_1abcdef",
      createdAt: new Date("2026-10-01T10:00:00Z"),
      channel: "INSTAGRAM",
      conversationId: "conv_1",
      details: {
        lines: [{ variantId: "gid://shopify/ProductVariant/1", sku: null, title: "Belt", variantTitle: "", quantity: 3, unitPrice: 333.33 }],
        customer: { name: "Rahim", phone: "01712345678" },
        address: { address1: "House 12", city: "Dhaka" },
        zone: { id: "dhaka", label: "Inside Dhaka", fee: 80 },
        paymentMethod: { id: "cod", label: "Cash on delivery" },
        currency: "BDT",
      },
      subtotal: 999.99,
      deliveryFee: 80,
      total: 1079.99,
      shopify: { orderId: null, orderName: null },
      reviewRequired: false,
      appUrl: "https://shop.example.com/",
    });
    expect(p).toMatchObject({
      event: "order.created",
      test: false,
      reference: "ISO-ABCDEF",
      channel: "instagram",
      items: [{ title: "Belt", variant: null, quantity: 3, unit_price: 333.33, total: 999.99 }],
      shopify: null,
      conversation_url: "https://shop.example.com/admin/conversations/conv_1",
    });
  });
});

describe("connection test", () => {
  it("sends a marked test order and points out an unprotected address", async () => {
    await connect();
    const { hits } = platform({ status: 200, json: { id: "T-1" } });
    const r = await testConnection("orders");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/accepted a test order \(HTTP 200\) and answered with order T-1/);
    expect(r.notes?.join(" ")).toMatch(/fake orders/);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ event: "order.test", test: true });
    expect(hits[0]!.headers["x-isolation-event"]).toBe("order.test");
  });

  it("says what to fix when the key is refused", async () => {
    await connect({ ORDER_WEBHOOK_AUTH_HEADER: "Authorization", ORDER_WEBHOOK_AUTH_VALUE: "Bearer wrong" });
    platform({ status: 401, json: { error: "unauthorized" } });
    const r = await testConnection("orders");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/check the API key header and value/);
  });

  it("is not re-tested automatically (that would send test orders every day)", async () => {
    await connect();
    const { hits } = platform({ status: 200 });
    const report = await checkAllConfigured("maintenance");
    expect(report.checked).not.toContain("orders");
    expect(hits.filter((h) => h.url === URL_)).toHaveLength(0);
  });
});

describe("orders from chat", () => {
  const draftArgs = {
    items: [{ variant_id: "gid://shopify/ProductVariant/mock-kdwb-115", quantity: 1 }],
    customer_name: "Rahim Uddin",
    phone: "01712345678",
    address: "House 12, Road 5, Mirpur 10",
    city: "Dhaka",
    delivery_zone: "dhaka",
    payment_method: "cod",
  };
  const draftId = (m: LlmMessage[]) => /draft_id (\w+)/.exec(systemPrompt(m))![1];
  const output = (m: LlmMessage[]) => JSON.parse((m.filter((x) => x.role === "tool").at(-1) as { content: string }).content);

  async function draft() {
    await turn("Rahim Uddin, 01712345678, House 12 Road 5 Mirpur 10, Dhaka. COD", {
      script: [call("create_draft_order", draftArgs), say("Please confirm: Total ৳879")],
    });
  }

  it("sends the order only to the order platform and gives the customer its number", async () => {
    await connect({ ORDER_DESTINATION: "platform" });
    const { hits } = platform({ status: 200, json: { order_number: "OMS-1201" } });
    await draft();
    const { result } = await turn("haa confirm", {
      script: [(m) => call("confirm_order", { draft_id: draftId(m) }), (m) => say(`Order ${output(m).order_number} confirmed! COD te ৳879 pay korben.`)],
    });

    expect(MockShopifyProvider.createdOrders).toHaveLength(0);
    expect(result.reply).toBe("Order OMS-1201 confirmed! COD te ৳879 pay korben.");
    expect(result.agent!.validation.ok).toBe(true);
    const order = await prisma.order.findFirstOrThrow({ include: { forwards: true } });
    expect(order).toMatchObject({ status: "sent_to_platform", platformOrderId: "OMS-1201", shopifyOrderId: null, channel: "MESSENGER" });
    expect(order.forwards[0]).toMatchObject({ status: "sent", attempts: 1 });
    const body = JSON.parse(hits[0]!.body);
    expect(body).toMatchObject({
      event: "order.created",
      id: order.id,
      customer: { name: "Rahim Uddin", phone: "01712345678" },
      shipping: { city: "Dhaka", zone: "dhaka", fee: 80 },
      items: [{ quantity: 1, unit_price: 799, total: 799, shopify_variant_id: "gid://shopify/ProductVariant/mock-kdwb-115" }],
      payment: { method: "cod" },
      subtotal: 799,
      delivery_fee: 80,
      total: 879,
      shopify: null,
    });
    expect(body.items[0].sku).toBeDefined();
  });

  it("tells the customer it's received (not confirmed) when the platform is down", async () => {
    await connect({ ORDER_DESTINATION: "platform" });
    platform({ status: 502 });
    await draft();
    const { result } = await turn("yes confirm", {
      script: [
        (m) => call("confirm_order", { draft_id: draftId(m) }),
        (m) => {
          expect(output(m)).toMatchObject({ ok: true, mode: "draft", status: "received_pending_team_review" });
          return say("Your order is confirmed!");
        },
      ],
    });
    // Claiming "confirmed" is blocked: the platform hasn't taken it yet.
    expect(result.agent!.validation.issues).toContain("unverified_order_confirmation_claim");
    const order = await prisma.order.findFirstOrThrow({ include: { forwards: true } });
    expect(order.status).toBe("platform_pending");
    expect(order.forwards[0]).toMatchObject({ status: "pending", attempts: 2 }); // one quick retry in the same turn
  });

  it("places the order in Shopify and sends a copy to the platform", async () => {
    await connect();
    const { hits } = platform({ status: 202 });
    await draft();
    const { result } = await turn("confirm", {
      script: [(m) => call("confirm_order", { draft_id: draftId(m) }), (m) => say(`Order ${output(m).order_number} confirmed.`)],
    });
    expect(result.reply).toBe("Order #MOCK-1001 confirmed.");
    expect(MockShopifyProvider.createdOrders).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body).shopify).toEqual({ order_id: expect.any(String), order_name: "#MOCK-1001" });
    const order = await prisma.order.findFirstOrThrow({ include: { forwards: true } });
    expect(order.status).toBe("created");
    expect(order.forwards[0]!.status).toBe("sent");
  });

  it("keeps the Shopify order when the copy to the platform fails", async () => {
    await connect();
    platform({ status: 500 });
    await draft();
    const { result } = await turn("confirm", {
      script: [(m) => call("confirm_order", { draft_id: draftId(m) }), (m) => say(`Order ${output(m).order_number} confirmed.`)],
    });
    expect(result.reply).toBe("Order #MOCK-1001 confirmed.");
    expect((await prisma.orderForward.findFirstOrThrow()).status).toBe("pending");
  });
});

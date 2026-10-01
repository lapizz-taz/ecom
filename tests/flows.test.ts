import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ScriptedLlm, LlmUnavailableError, type LlmMessage } from "@/lib/ai/llm";
import { receiveInbound, processConversation, receiveEcho } from "@/lib/conversation/service";
import { returnToAi, takeOver } from "@/lib/handoff";
import { updateSettings, defaultSettings } from "@/lib/config/settings";
import { MockShopifyProvider } from "@/lib/shopify";
import { call, mid, resetDb, say, sent, setFailSends, systemPrompt, turn } from "./helpers";

const BELT = "gid://shopify/Product/mock-korean-double-whammy-belt";
const BELT_VARIANT = "gid://shopify/ProductVariant/mock-kdwb-115";

function toolOutput(messages: LlmMessage[], index = -1): Record<string, unknown> {
  const tools = messages.filter((m) => m.role === "tool") as { content: string }[];
  return JSON.parse(tools.at(index)!.content);
}

async function conversationFor(user = "psid-1") {
  const u = await prisma.channelUser.findFirstOrThrow({ where: { externalUserId: user } });
  return prisma.conversation.findFirstOrThrow({ where: { channelUserId: u.id }, orderBy: { createdAt: "desc" } });
}

beforeEach(async () => {
  await resetDb();
  MockShopifyProvider.createdOrders = [];
});

describe("product questions", () => {
  it("answers price from live Shopify data (Banglish)", async () => {
    const { result } = await turn("belt ta koto?", {
      script: [
        call("search_products", { query: "belt" }),
        (m) => {
          const out = toolOutput(m) as { products: { price: number; title: string }[] };
          return say(`৳${out.products[0]!.price} ভাই. ${out.products[0]!.title} — 115cm. 🔥`);
        },
      ],
    });
    expect(result.reply).toBe("৳799 ভাই. Korean Double Whammy Belt — 115cm. 🔥");
    expect(sent).toEqual([{ channel: "MESSENGER", to: "psid-1", text: result.reply }]);
    expect(result.agent!.lang).toBe("banglish");
    expect(result.agent!.handoff).toBeNull();
    const conv = await conversationFor();
    expect(conv.status).toBe("AI_ACTIVE");
    expect(await prisma.toolCallLog.count()).toBe(1);
  });

  it("blocks a hallucinated price and hands off", async () => {
    const { result } = await turn("How much is the Korean belt?", { script: [say("It's ৳650 today!")] });
    expect(result.reply).toBe("Let me get that confirmed for you — a team member will reply here shortly.");
    expect(result.agent!.validation.issues).toContain("ungrounded_amount:650");
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
  });

  it("does not invent colours that Shopify doesn't list", async () => {
    const { result, llm } = await turn("Do you have black?", {
      script: [call("get_product", { product_id: BELT }), say("Colour options aren't listed for this belt right now — I'll have a team member confirm black for you.")],
    });
    const out = toolOutput(llm.calls[1]!) as { product: { options: { name: string; values: string[] }[] } };
    expect(out.product.options.map((o) => o.name)).toEqual(["Size"]);
    expect(result.reply).toContain("team member confirm");
  });

  it("does not recommend out-of-stock products", async () => {
    const { llm } = await turn("Do you have something similar?", {
      mode: "mock:out_of_stock",
      script: [call("search_products", { query: "belt" }), say("Nothing similar in stock right now — I'll ask the team to confirm restocks.")],
    });
    expect(toolOutput(llm.calls[1]!)).toMatchObject({ count: 0 });
  });

  it("says it will confirm when the information doesn't exist", async () => {
    const { result } = await turn("Do you sell perfume?", {
      script: [call("search_products", { query: "perfume" }), call("request_human", { reason: "low_confidence", summary: "Asked for perfume" }), say("Let me get that confirmed for you — our team will reply here.")],
    });
    expect(result.agent!.handoff?.reason).toBe("low_confidence");
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
  });
});

describe("delivery", () => {
  it("answers delivery charges from configuration", async () => {
    const { result } = await turn("Dhakar delivery charge koto?", { script: [say("Dhaka ৳80, outside Dhaka ৳120.")] });
    expect(result.reply).toBe("Dhaka ৳80, outside Dhaka ৳120.");
  });

  it("uses updated charges after an admin changes them", async () => {
    const s = defaultSettings();
    s.delivery.zones[0]!.fee = 70;
    await updateSettings("delivery", s.delivery, "test");
    const bad = await turn("How much delivery to Dhaka?", { script: [say("Dhaka delivery is ৳80.")] });
    expect(bad.result.agent!.validation.ok).toBe(false);
    await returnToAi(bad.received.conversationId!, "test");
    const good = await turn("How much delivery to Dhaka?", { script: [say("Dhaka delivery is ৳70.")] });
    expect(good.result.reply).toBe("Dhaka delivery is ৳70.");
  });

  it("never invents a delivery time", async () => {
    const { result } = await turn("How long does delivery take?", { script: [say("Usually 2-3 days inside Dhaka.")] });
    expect(result.agent!.validation.issues).toContain("ungrounded_duration:2");
    expect(result.agent!.handoff?.reason).toBe("low_confidence");
  });

  it("states delivery time when it is configured", async () => {
    const s = defaultSettings();
    s.delivery.zones[0]!.estimatedTime = "2-3 days";
    await updateSettings("delivery", s.delivery, "test");
    const { result } = await turn("How long does delivery take?", { script: [say("Inside Dhaka usually 2-3 days.")] });
    expect(result.agent!.validation.ok).toBe(true);
  });
});

describe("order flow", () => {
  const draftArgs = {
    items: [{ variant_id: BELT_VARIANT, quantity: 1 }],
    customer_name: "Rahim Uddin",
    phone: "01712345678",
    address: "House 12, Road 5, Mirpur 10",
    city: "Dhaka",
    delivery_zone: "dhaka",
    payment_method: "cod",
  };

  it("collects details, shows summary, and only places the order after explicit confirmation", async () => {
    // Turn 1: details -> draft + summary. The model even tries to confirm in the same turn: rejected.
    const t1 = await turn("Rahim Uddin, 01712345678, House 12 Road 5 Mirpur 10, Dhaka. COD", {
      script: [
        call("create_draft_order", draftArgs),
        (m) => call("confirm_order", { draft_id: (toolOutput(m) as { draft_id: string }).draft_id }),
        (m) => {
          expect(toolOutput(m)).toMatchObject({ ok: false, error: "customer_has_not_seen_summary" });
          const draft = toolOutput(m, -2) as { summary_text: string };
          return say(`Perfect! Just confirming your order:\n${draft.summary_text}\nShould I confirm this order?`);
        },
      ],
    });
    expect(t1.result.reply).toContain("Korean Double Whammy Belt (115 cm) — ৳799");
    expect(t1.result.reply).toContain("Delivery (Inside Dhaka) — ৳80");
    expect(t1.result.reply).toContain("Total — ৳879");
    expect(MockShopifyProvider.createdOrders).toHaveLength(0);

    // Turn 2: an unrelated question — confirm_order must refuse.
    const t2 = await turn("what's the total?", {
      script: [
        (m) => call("confirm_order", { draft_id: /draft_id (\w+)/.exec(systemPrompt(m))![1] }),
        (m) => {
          expect(toolOutput(m)).toMatchObject({ ok: false, error: "no_explicit_confirmation" });
          return say("Total ৳879. Reply confirm to place it.");
        },
      ],
    });
    expect(t2.result.agent!.validation.ok).toBe(true);
    expect(MockShopifyProvider.createdOrders).toHaveLength(0);

    // Turn 3: explicit confirmation -> real order.
    const t3 = await turn("haa confirm koren", {
      script: [
        (m) => call("confirm_order", { draft_id: /draft_id (\w+)/.exec(systemPrompt(m))![1] }),
        (m) => say(`Done 🔥 Order ${(toolOutput(m) as { order_number: string }).order_number} confirmed. COD te ৳879 pay korben.`),
      ],
    });
    expect(t3.result.reply).toMatch(/Order #MOCK-1001 confirmed/);
    expect(MockShopifyProvider.createdOrders).toHaveLength(1);
    expect(MockShopifyProvider.createdOrders[0]!.input.shipping.fee).toBe(80);
    expect(MockShopifyProvider.createdOrders[0]!.input.items[0]!.unitPrice).toBe(799);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.shopifyOrderName).toBe("#MOCK-1001");
    expect(Number(order.total)).toBe(879);
    expect((await prisma.draftOrder.findFirstOrThrow({ where: { status: "CONFIRMED" } })).id).toBeTruthy();

    // A duplicate confirmation can't create a second order.
    const t4 = await turn("confirm", {
      script: [
        call("confirm_order", { draft_id: order.id }),
        say("Your order is already placed."),
      ],
    });
    expect(MockShopifyProvider.createdOrders).toHaveLength(1);
    expect(t4.result.agent!.toolTraces[0]!.ok).toBe(false);
  });

  it("never claims an order is confirmed without a successful Shopify operation", async () => {
    const { result } = await turn("I want to order the belt", { script: [say("Your order is confirmed! 🎉")] });
    expect(result.agent!.validation.issues).toContain("unverified_order_confirmation_claim");
    expect(result.reply).not.toContain("confirmed!");
  });

  it("hands off when Shopify order creation fails", async () => {
    await turn("Rahim Uddin, 01712345678, House 12 Road 5 Mirpur 10, Dhaka. COD", {
      mode: "mock:order_fails",
      script: [call("create_draft_order", draftArgs), say("Please confirm: Total ৳879")],
    });
    const { result } = await turn("yes", {
      mode: "mock:order_fails",
      script: [(m) => call("confirm_order", { draft_id: /draft_id (\w+)/.exec(systemPrompt(m))![1] }), say("Your order is confirmed!")],
    });
    expect(result.reply).toBe("Sorry — I couldn't complete the order automatically. I've passed your details to our team and they'll finish it and confirm here.");
    expect(result.agent!.handoff?.reason).toBe("order_failed");
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
    expect(await prisma.draftOrder.count({ where: { status: "FAILED" } })).toBe(1);
  });

  it("refuses out-of-stock items and invalid phone numbers", async () => {
    const oos = await turn("order", { mode: "mock:out_of_stock", script: [call("create_draft_order", draftArgs), say("Sorry, it's out of stock right now.")] });
    expect(oos.result.agent!.toolTraces[0]!.output).toMatchObject({ ok: false, error: "out_of_stock" });
    const bad = await turn("order", { user: "psid-2", script: [call("create_draft_order", { ...draftArgs, phone: "0171234" }), say("Please share a valid 11-digit number.")] });
    expect(bad.result.agent!.toolTraces[0]!.output).toMatchObject({ ok: false, error: "invalid_phone" });
  });

  it("only accepts enabled payment methods", async () => {
    const { result } = await turn("order with card", { script: [call("create_draft_order", { ...draftArgs, payment_method: "online" }), say("Right now we take Cash on Delivery.")] });
    expect(result.agent!.toolTraces[0]!.output).toMatchObject({ ok: false, error: "payment_method_not_available" });
  });
});

describe("existing orders & privacy", () => {
  it("requires order number + matching phone and never leaks another customer's order", async () => {
    const wrong = await turn("Order #1001, phone 01799999999", {
      script: [call("get_order", { order_number: "#1001", phone: "01799999999" }), say("I couldn't match that order with this number. Can you double-check?")],
    });
    const out = wrong.result.agent!.toolTraces[0]!.output as Record<string, unknown>;
    expect(out.status).toBe("not_verified");
    expect(JSON.stringify(out)).not.toContain("Korean");

    const noPhone = await turn("where is order 1001?", { user: "psid-2", script: [call("get_order", { order_number: "1001" }), say("Share the phone number used on the order please.")] });
    expect(noPhone.result.agent!.toolTraces[0]!.output).toMatchObject({ status: "need_phone" });

    const phoneOnly = await turn("my number 01711111111, where is my order?", { user: "psid-3", script: [call("get_order", { phone: "01711111111" }), say("Please share your order number too.")] });
    expect(phoneOnly.result.agent!.toolTraces[0]!.output).toMatchObject({ status: "need_order_number" });

    const right = await turn("Order #1001, phone 01711111111", {
      user: "psid-4",
      script: [call("get_order", { order_number: "#1001", phone: "01711111111" }), (m) => say(`Order #1001 is ${(toolOutput(m) as { orders: { fulfillment_status: string }[] }).orders[0]!.fulfillment_status.toLowerCase()} — tracking MOCK123.`)],
    });
    const found = right.result.agent!.toolTraces[0]!.output as { status: string; orders: Record<string, unknown>[] };
    expect(found.status).toBe("found");
    expect(JSON.stringify(found)).not.toContain("01711111111"); // phone never returned
    expect(right.result.reply).toContain("fulfilled");
  });

  it("allows phone-only lookup when the channel verified the phone (WhatsApp)", async () => {
    const { result } = await turn("where is my order?", {
      channel: "WHATSAPP",
      user: "8801711111111",
      verifiedPhone: "01711111111",
      script: [call("get_order", { phone: "01711111111" }), say("Your order #1001 has been shipped.")],
    });
    expect(result.agent!.toolTraces[0]!.output).toMatchObject({ status: "found" });
  });

  it("escalates repeated dissatisfaction about delivery", async () => {
    await turn("My order hasn't arrived", { script: [say("Sorry! Share your order number and phone please.")] });
    const { result } = await turn("still not received, 10 din hoye gelo", { script: [] });
    expect(result.agent!.guard).toBe("repeated_dissatisfaction");
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
  });
});

describe("support & handoff", () => {
  it.each([
    ["I want a refund.", "refund", "refund_request"],
    ["I want to cancel", "cancel", "cancellation_request"],
    ["Give me a discount", "discount", "discount_request"],
    ["human den.", "human_request", "customer_requested_human"],
    ["I want to talk to a human", "human_request", "customer_requested_human"],
    ["you people are fraud", "anger", "angry_customer"],
    ["bkash payment dilam but taka kete geche order hoyni", "payment_problem", "payment_problem"],
  ])("%s -> deterministic handoff", async (text, guard, reason) => {
    const llm = new ScriptedLlm([]);
    const { result } = await turn(text, { llm });
    expect(llm.calls).toHaveLength(0); // model never consulted
    expect(result.agent!.guard).toBe(guard);
    const conv = await conversationFor();
    expect(conv.status).toBe("HUMAN_REQUIRED");
    const h = await prisma.handoff.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(h.reason).toBe(reason);
  });

  it("answers exchange questions only from the official policy", async () => {
    const { result } = await turn("I want an exchange.", {
      script: [call("get_policy", { topic: "exchange" }), call("request_human", { reason: "policy_unclear" }), say("I'll connect you with our team so they can check this for you.")],
    });
    expect(result.agent!.toolTraces[0]!.output).toMatchObject({ available: false });
    expect(result.agent!.handoff?.reason).toBe("policy_unclear");
  });

  it("replies to handoff in the customer's language", async () => {
    const bn = await turn("মানুষের সাথে কথা বলতে চাই", { llm: new ScriptedLlm([]) });
    expect(bn.result.reply).toMatch(/টিম/);
    const banglish = await turn("admin er sathe kotha bolbo", { user: "psid-2", llm: new ScriptedLlm([]) });
    expect(banglish.result.reply).toMatch(/team er ekjon/);
  });

  it("stops AI replies after handoff, lets a human take over and return to AI", async () => {
    const first = await turn("human den", { llm: new ScriptedLlm([]) });
    const convId = first.received.conversationId!;
    const second = await turn("hello?", { llm: new ScriptedLlm([say("should not be sent")]) });
    expect(second.result.status).toBe("skipped");
    expect(second.result.skipReason).toBe("human_mode");

    await takeOver(convId, "staff@isolation");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: convId } })).status).toBe("HUMAN_ACTIVE");
    const third = await turn("still there?", { llm: new ScriptedLlm([say("nope")]) });
    expect(third.result.skipReason).toBe("human_mode");

    await returnToAi(convId, "staff@isolation");
    const fourth = await turn("delivery charge?", { script: [say("Dhaka ৳80, outside Dhaka ৳120.")] });
    expect(fourth.result.status).toBe("replied");
    expect(await prisma.handoff.count({ where: { conversationId: convId, resolvedAt: null } })).toBe(0);
  });

  it("pauses the AI when staff reply from the native Meta inbox", async () => {
    const { received } = await turn("hi", { script: [say("Hey! How can I help?")] });
    await receiveEcho({ channel: "MESSENGER", customerExternalId: "psid-1", externalMessageId: "echo-1", text: "Hi, this is Tania from Isolation", appId: "12345" });
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: received.conversationId! } });
    expect(conv.status).toBe("HUMAN_ACTIVE");
    // Echo of our own API message is ignored.
    expect(await receiveEcho({ channel: "MESSENGER", customerExternalId: "psid-1", externalMessageId: "echo-2", text: "x", appId: "999" })).toBe("ignored");
  });
});

describe("safety", () => {
  it("never stores or forwards an OTP", async () => {
    const llm = new ScriptedLlm([]);
    const { result, received } = await turn("my OTP is 482913", { llm });
    expect(llm.calls).toHaveLength(0);
    expect(result.reply).toContain("Isolation will never ask for them");
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: received.messageId! } });
    expect(stored.message).not.toContain("482913");
  });

  it("redacts sensitive data but still answers the rest of the message", async () => {
    const { result, llm } = await turn("bkash pin 5566. btw delivery charge koto outside dhaka?", { script: [say("Outside Dhaka ৳120.")] });
    expect(JSON.stringify(llm.calls)).not.toContain("5566");
    expect(result.reply).toMatch(/^Please OTP, PIN/);
    expect(result.reply).toContain("Outside Dhaka ৳120.");
  });

  it("uses the fixed outage message when Shopify is down", async () => {
    const { result } = await turn("black available?", {
      mode: "mock:unavailable",
      script: [call("search_products", { query: "belt" }), say("Yes, black is available for ৳799!")],
    });
    expect(result.reply).toBe("One moment — I'm having trouble checking that right now. I'll get our team to confirm it.");
    expect(result.agent!.handoff?.reason).toBe("shopify_unavailable");
  });

  it("uses the Banglish outage message for Banglish customers", async () => {
    const { result } = await turn("vai black ta ache?", { mode: "mock:unavailable", script: [call("search_products", { query: "belt black" }), say("Ache!")] });
    expect(result.reply).toBe("Ektu wait korun — ei muhurte check korte problem hocche. Amader team confirm kore janabe.");
  });

  it("hands off (and keeps the message for retry) when Meta delivery fails", async () => {
    setFailSends(true);
    const { result } = await turn("delivery charge?", { script: [say("Dhaka ৳80, outside Dhaka ৳120.")] });
    expect(result.sent).toBe(false);
    const msg = await prisma.message.findFirstOrThrow({ where: { sender: "AI" } });
    expect(msg.deliveryStatus).toBe("FAILED");
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
  });

  it("never sends a broken message when the model fails", async () => {
    const { result } = await turn("Is this available in black?", { script: [new LlmUnavailableError("timeout")] });
    expect(result.reply).toBe("Thanks for your message! Our team will get back to you here shortly.");
    expect(result.agent!.handoff).toBeTruthy();
    expect((await conversationFor()).status).toBe("HUMAN_REQUIRED");
  });

  it("handles a model that returns an empty reply", async () => {
    const { result } = await turn("hello", { script: [say("")] });
    expect(result.agent!.validation.issues).toContain("empty_reply");
    expect(result.reply).toContain("confirmed");
  });

  it("rejects invalid tool arguments", async () => {
    const { result } = await turn("check stock", { script: [call("check_inventory", { variant_id: "'; DROP TABLE x;--" }), say("Let me get that confirmed for you.")] });
    expect(result.agent!.toolTraces[0]!.output).toMatchObject({ error: "invalid_arguments" });
  });

  it("is idempotent for duplicate webhook events", async () => {
    const msg = { channel: "INSTAGRAM" as const, externalUserId: "ig-1", externalMessageId: "dup-mid-1", text: "delivery charge?" };
    const a = await receiveInbound(msg);
    const b = await receiveInbound(msg);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    await processConversation(a.conversationId!, a.messageId!, { llm: new ScriptedLlm([say("Dhaka ৳80, outside Dhaka ৳120.")]), debounceMs: 0, shopifyMode: "mock:normal" });
    // Re-processing the same message (e.g. a retried background job) must not reply twice.
    const again = await processConversation(a.conversationId!, a.messageId!, { llm: new ScriptedLlm([say("dup")]), debounceMs: 0, shopifyMode: "mock:normal" });
    expect(again.skipReason).toBe("already_processed");
    expect(await prisma.message.count({ where: { sender: "AI" } })).toBe(1);
  });

  it("coalesces message bursts into a single reply", async () => {
    const m1 = await receiveInbound({ channel: "MESSENGER", externalUserId: "burst", externalMessageId: mid(), text: "vai" });
    const m2 = await receiveInbound({ channel: "MESSENGER", externalUserId: "burst", externalMessageId: mid(), text: "belt ta koto?" });
    const r1 = await processConversation(m1.conversationId!, m1.messageId!, { llm: new ScriptedLlm([say("x")]), debounceMs: 0, shopifyMode: "mock:normal" });
    expect(r1.skipReason).toBe("superseded");
  });

  it("rate-limits message floods", async () => {
    let skipped = 0;
    // 30 > 2 × the 12/min limit, so a minute boundary mid-test still trips it.
    for (let i = 0; i < 30; i++) {
      const r = await turn(`spam ${i}`, { user: "spammer", script: [say("ok")] });
      if (r.result.skipReason === "rate_limited" || r.result.skipReason === "human_mode") skipped++;
    }
    expect(skipped).toBeGreaterThan(0);
  });

  it("merges identities only on a channel-verified phone", async () => {
    await turn("hi", { channel: "WHATSAPP", user: "8801712345678", verifiedPhone: "01712345678", script: [say("Hey!")] });
    await turn("hi", { channel: "WHATSAPP", user: "8801712345678-dup", verifiedPhone: "01712345678", script: [say("Hey!")] });
    await turn("my number is 01712345678", { channel: "INSTAGRAM", user: "ig-9", script: [say("Thanks!")] });
    const customers = await prisma.customer.findMany({ include: { channelUsers: true } });
    expect(customers).toHaveLength(2);
    expect(customers.find((c) => c.channelUsers.length === 2)?.phoneVerified).toBe(true);
  });
});

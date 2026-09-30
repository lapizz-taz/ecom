import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { scanSensitive, redactObject, maskPhone } from "@/lib/security/redact";
import { normalizeBdPhone, phonesMatch } from "@/lib/utils/phone";
import { detectLanguage } from "@/lib/ai/language";
import { analyzeMessage, isAffirmative } from "@/lib/ai/guards";
import { validateReply, extractMoney, sanitizeReply } from "@/lib/ai/validate";
import { verifyMetaSignature } from "@/lib/security/signature";
import { parseMetaWebhook } from "@/lib/channels/meta";
import { parseWhatsAppWebhook } from "@/lib/channels/whatsapp";
import { splitMessage } from "@/lib/channels/types";
import { defaultSettings, resolveDeliveryZone } from "@/lib/config/settings";

describe("sensitive data detection", () => {
  it("redacts OTPs, PINs, passwords and card numbers", () => {
    expect(scanSensitive("my OTP is 482913").redacted).not.toContain("482913");
    expect(scanSensitive("bkash pin 12345").kinds).toContain("pin");
    expect(scanSensitive("password: Hunter2!").redacted).not.toContain("Hunter2");
    const card = scanSensitive("card 4111 1111 1111 1111 exp 12/28");
    expect(card.kinds).toContain("card_number");
    expect(card.redacted).not.toContain("4111");
  });
  it("does not treat phone numbers / order numbers as sensitive", () => {
    expect(scanSensitive("my number 01712345678").found).toBe(false);
    expect(scanSensitive("+8801712345678").found).toBe(false);
    expect(scanSensitive("order #1001").found).toBe(false);
    expect(scanSensitive("I forgot my password").found).toBe(false);
  });
  it("redacts secrets in log objects", () => {
    const r = redactObject({ access_token: "abc", nested: { apiKey: "x", msg: "Bearer EAAB123456789012345678901234" } });
    expect(JSON.stringify(r)).not.toContain("abc");
    expect(JSON.stringify(r)).not.toContain("EAAB1234567890");
    expect(maskPhone("01712345678")).toBe("017******78");
  });
});

describe("phone helpers", () => {
  it("normalizes Bangladeshi numbers", () => {
    expect(normalizeBdPhone("+880 1712-345678")).toBe("01712345678");
    expect(normalizeBdPhone("8801712345678")).toBe("01712345678");
    expect(normalizeBdPhone("০১৭১২৩৪৫৬৭৮")).toBe("01712345678");
    expect(normalizeBdPhone("12345")).toBeNull();
    expect(phonesMatch("+8801712345678", "01712345678")).toBe(true);
    expect(phonesMatch("01712345678", "01712345679")).toBe(false);
  });
});

describe("language detection", () => {
  it("detects English, Bangla and Banglish", () => {
    expect(detectLanguage("Is this available in black?")).toBe("en");
    expect(detectLanguage("vai belt ta available?")).toBe("banglish");
    expect(detectLanguage("belt ta koto?")).toBe("banglish");
    expect(detectLanguage("Dhakar delivery charge koto?")).toBe("banglish");
    expect(detectLanguage("বেল্টের দাম কত?")).toBe("bn");
    expect(detectLanguage("How much delivery to Dhaka?")).toBe("en");
  });
});

describe("guards", () => {
  it("detects handoff triggers", () => {
    expect(analyzeMessage("human den.").humanRequest).toBe(true);
    expect(analyzeMessage("I want to talk to a human").humanRequest).toBe(true);
    expect(analyzeMessage("Admin vai belt ta koto?").humanRequest).toBe(false);
    expect(analyzeMessage("I want a refund").refund).toBe(true);
    expect(analyzeMessage("Give me a discount").discountRequest).toBe(true);
    expect(analyzeMessage("any offer running?").discountRequest).toBe(false);
    expect(analyzeMessage("you are a fraud").anger).toBe(true);
    expect(analyzeMessage("I want to cancel").cancel).toBe(true);
    expect(analyzeMessage("My order hasn't arrived").negative).toBe(true);
  });
  it("requires explicit confirmation", () => {
    for (const t of ["yes", "confirm", "haa confirm koren", "হ্যাঁ", "ok vai", "Confirm my order"]) expect(isAffirmative(t)).toBe(true);
    for (const t of ["no", "confirm koren na", "wait", "what is the total?", "ha but change address"]) expect(isAffirmative(t)).toBe(false);
  });
});

describe("grounding validator", () => {
  it("allows grounded prices, sums and quantities", () => {
    const r = validateReply({ reply: "৳799 ভাই. Delivery ৳80, total ৳879. 2 ta nile ৳1598", groundingSources: [{ price: 799 }, { fee: 80 }], customerText: "", orderConfirmedThisTurn: false });
    expect(r.ok).toBe(true);
  });
  it("blocks invented prices, discounts, durations and order claims", () => {
    expect(validateReply({ reply: "It's ৳650 now", groundingSources: [{ price: 799 }], customerText: "", orderConfirmedThisTurn: false }).ok).toBe(false);
    expect(validateReply({ reply: "20% off today!", groundingSources: [], customerText: "", orderConfirmedThisTurn: false }).ok).toBe(false);
    expect(validateReply({ reply: "Delivery takes 2-3 days", groundingSources: [], customerText: "", orderConfirmedThisTurn: false }).ok).toBe(false);
    expect(validateReply({ reply: "Your order is confirmed!", groundingSources: [], customerText: "", orderConfirmedThisTurn: false }).ok).toBe(false);
    expect(validateReply({ reply: "Your order is confirmed!", groundingSources: [], customerText: "", orderConfirmedThisTurn: true }).ok).toBe(true);
  });
  it("does not let the customer's own number ground a price", () => {
    expect(validateReply({ reply: "Yes, ৳500 only", groundingSources: [{ price: 799 }], customerText: "is it 500 tk?", orderConfirmedThisTurn: false }).ok).toBe(false);
    expect(validateReply({ reply: "Sorry it's been 10 days", groundingSources: [], customerText: "10 din hoye gelo", orderConfirmedThisTurn: false }).ok).toBe(true);
  });
  it("extracts BDT amounts in many formats", () => {
    expect(extractMoney("৳799, 80 tk, Tk. 120, ১০০ টাকা, 500/-")).toEqual([799, 120, 80, 100, 500]);
  });
  it("sanitizes markdown and internal ids", () => {
    expect(sanitizeReply("**Belt** gid://shopify/Product/123 [link](https://x.y)")).toBe("Belt  link: https://x.y");
  });
});

describe("webhooks", () => {
  it("verifies Meta signatures", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, null, "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, sig, undefined)).toBe(false);
  });
  it("parses Messenger / Instagram payloads incl. echoes", () => {
    const p = parseMetaWebhook({
      object: "instagram",
      entry: [{ messaging: [
        { sender: { id: "IGSID1" }, recipient: { id: "ME" }, timestamp: 1, message: { mid: "m1", text: "belt ta koto?" } },
        { sender: { id: "ME" }, recipient: { id: "IGSID1" }, timestamp: 2, message: { mid: "m2", text: "hi", is_echo: true, app_id: 123 } },
        { sender: { id: "IGSID1" }, recipient: { id: "ME" }, timestamp: 3, message: { mid: "m3", attachments: [{ type: "image", payload: { url: "https://x" } }] } },
      ] }],
    });
    expect(p.messages.map((m) => [m.channel, m.text])).toEqual([["INSTAGRAM", "belt ta koto?"], ["INSTAGRAM", "[Customer sent: image]"]]);
    expect(p.echoes[0]).toMatchObject({ customerExternalId: "IGSID1", appId: "123" });
  });
  it("parses WhatsApp payloads and ignores other phone numbers", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "PN1" },
        contacts: [{ wa_id: "8801712345678", profile: { name: "Rahim" } }],
        messages: [{ from: "8801712345678", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "delivery charge?" } }],
      } }] }],
    };
    const p = parseWhatsAppWebhook(body, "PN1");
    expect(p.messages[0]).toMatchObject({ channel: "WHATSAPP", text: "delivery charge?", profileName: "Rahim", verifiedPhone: "01712345678" });
    expect(parseWhatsAppWebhook(body, "OTHER").messages).toHaveLength(0);
  });
  it("splits long messages under platform limits", () => {
    const parts = splitMessage("a".repeat(900) + "\n" + "b".repeat(900), 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
  });
});

describe("delivery zones", () => {
  it("resolves configured zones and areas", () => {
    const s = defaultSettings();
    expect(resolveDeliveryZone(s, { zone: "dhaka" })?.fee).toBe(80);
    expect(resolveDeliveryZone(s, { zone: "outside_dhaka" })?.fee).toBe(120);
    expect(resolveDeliveryZone(s, { zone: "suburb" })?.fee).toBe(100);
    // Nothing is assumed about areas until the team configures them.
    expect(resolveDeliveryZone(s, { area: "Mirpur 10, Dhaka" })).toBeNull();
    s.delivery.zones[0]!.areas = ["dhaka", "mirpur"];
    s.delivery.zones[1]!.areas = ["savar", "gazipur"];
    expect(resolveDeliveryZone(s, { area: "Mirpur 10, Dhaka" })?.id).toBe("dhaka");
    expect(resolveDeliveryZone(s, { area: "Savar, Dhaka" })?.id).toBe("suburb");
    expect(resolveDeliveryZone(s, { area: "Sylhet" })).toBeNull();
  });
});

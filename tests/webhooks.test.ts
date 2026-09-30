import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

// Run `after()` callbacks inline so the test can observe the AI reply.
const pending: Promise<unknown>[] = [];
vi.mock("next/server", async (orig) => {
  const mod = await orig<typeof import("next/server")>();
  return { ...mod, after: (fn: () => Promise<unknown>) => pending.push(fn()) };
});

import { prisma } from "@/lib/db";
import { resetDb, sent } from "./helpers";
import { GET as metaGet, POST as metaPost } from "@/app/api/webhooks/meta/route";
import { POST as waPost } from "@/app/api/webhooks/whatsapp/route";
import { signSession, verifySession } from "@/lib/auth/session";

function signed(body: object, secret = "test-meta-app-secret") {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("http://localhost/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": sig, "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: raw,
  });
}

const igEvent = (mid: string, text: string) => ({
  object: "instagram",
  entry: [{ id: "IGBIZ", time: Date.now(), messaging: [{ sender: { id: "IGSID-77" }, recipient: { id: "IGBIZ" }, timestamp: Date.now(), message: { mid, text } }] }],
});

beforeEach(async () => {
  await resetDb();
  pending.length = 0;
  await prisma.setting.create({ data: { key: "ai", value: { debounceMs: 0 } } });
});

describe("Meta webhook route", () => {
  it("answers the verification handshake only with the right token", async () => {
    const ok = await metaGet(new Request("http://localhost/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const bad = await metaGet(new Request("http://localhost/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345"));
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned / wrongly signed requests", async () => {
    const res = await metaPost(signed(igEvent("m-1", "hi"), "wrong-secret"));
    expect(res.status).toBe(401);
    expect(await prisma.message.count()).toBe(0);
  });

  it("stores the message, replies once, and ignores a duplicate delivery", async () => {
    const r1 = await metaPost(signed(igEvent("m-dup", "human den")));
    const r2 = await metaPost(signed(igEvent("m-dup", "human den")));
    await Promise.all(pending);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await prisma.message.count({ where: { sender: "CUSTOMER" } })).toBe(1);
    expect(await prisma.message.count({ where: { sender: "AI" } })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe("INSTAGRAM");
    const conv = await prisma.conversation.findFirstOrThrow();
    expect(conv.status).toBe("HUMAN_REQUIRED");
  });
});

describe("WhatsApp webhook route", () => {
  it("verifies signature and creates a verified-phone customer", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "PN1" },
        contacts: [{ wa_id: "8801812345678", profile: { name: "Karim" } }],
        messages: [{ from: "8801812345678", id: "wamid.X1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "human den" } }],
      } }] }],
    };
    const res = await waPost(signed(body));
    await Promise.all(pending);
    expect(res.status).toBe(200);
    const customer = await prisma.customer.findFirstOrThrow();
    expect(customer).toMatchObject({ name: "Karim", phone: "01812345678", phoneVerified: true });
    expect(sent[0]).toMatchObject({ channel: "WHATSAPP", to: "8801812345678" });
  });
});

describe("admin sessions", () => {
  it("signs and verifies session tokens; rejects tampering", async () => {
    const token = await signSession({ sub: "u1", email: "a@b.co", role: "AGENT" });
    expect(await verifySession(token)).toMatchObject({ sub: "u1", role: "AGENT" });
    expect(await verifySession(token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifySession(undefined)).toBeNull();
  });
});

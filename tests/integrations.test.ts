import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import {
  clearIntegrationCache, describeIntegrations, integrationEnv, IntegrationValueError, normalizeValue, saveIntegrationValues, statusOf,
} from "@/lib/integrations";
import { missingShopifyScopes, setupWebhooks, testConnection } from "@/lib/integrations/connect";
import { GET as metaGet, POST as metaPost } from "@/app/api/webhooks/meta/route";
import { resetDb } from "./helpers";

const SECRET = process.env.NEXTAUTH_SECRET!;

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.NEXTAUTH_SECRET = SECRET;
  resetEnvCache();
  clearIntegrationCache();
});

describe("credential encryption", () => {
  it("round-trips, and refuses tampered values or a different NEXTAUTH_SECRET", () => {
    const stored = encryptSecret("sk-live-abc123");
    expect(stored).not.toContain("sk-live");
    expect(decryptSecret(stored)).toBe("sk-live-abc123");

    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(decryptSecret(parts.join("."))).toBeNull();
    expect(decryptSecret("not-a-value")).toBeNull();

    process.env.NEXTAUTH_SECRET = "a-completely-different-secret-of-sufficient-length";
    resetEnvCache();
    expect(decryptSecret(stored)).toBeNull();
  });
});

describe("dashboard credentials", () => {
  it("override environment variables, and removing them falls back to the environment", async () => {
    expect((await integrationEnv()).META_VERIFY_TOKEN).toBe("test-verify-token");
    await saveIntegrationValues({ META_VERIFY_TOKEN: "dash-token", OPENAI_API_KEY: "sk-dash-1234" }, "owner@iso.test");
    const e = await integrationEnv();
    expect(e.META_VERIFY_TOKEN).toBe("dash-token");
    expect(e.OPENAI_API_KEY).toBe("sk-dash-1234");
    expect(statusOf(e).openai).toBe(true);

    await saveIntegrationValues({ META_VERIFY_TOKEN: null, OPENAI_API_KEY: "" }, "owner@iso.test");
    const back = await integrationEnv();
    expect(back.META_VERIFY_TOKEN).toBe("test-verify-token");
    expect(back.OPENAI_API_KEY).toBeUndefined();
  });

  it("stores values encrypted and audits key names only", async () => {
    await saveIntegrationValues({ SHOPIFY_ACCESS_TOKEN: "shpat_supersecret9999" }, "owner@iso.test");
    const row = await prisma.integrationSecret.findUniqueOrThrow({ where: { key: "SHOPIFY_ACCESS_TOKEN" } });
    expect(row.value).not.toContain("supersecret");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "integrations.update" } });
    expect(audit.target).toBe("SHOPIFY_ACCESS_TOKEN");
    expect(JSON.stringify(audit)).not.toContain("supersecret");
  });

  it("describes fields without ever returning a secret", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAsecretpagetokenWXYZ", META_PAGE_ID: "12345" }, "owner@iso.test");
    const { fields, status } = await describeIntegrations();
    expect(fields.META_ACCESS_TOKEN).toEqual({ source: "dashboard", value: null, hint: "WXYZ", unreadable: false });
    expect(fields.META_PAGE_ID).toMatchObject({ source: "dashboard", value: "12345" });
    expect(fields.META_APP_SECRET).toEqual({ source: "env", value: null, hint: "cret", unreadable: false });
    expect(fields.META_VERIFY_TOKEN).toMatchObject({ source: "env", value: "test-verify-token" });
    expect(fields.OPENAI_API_KEY.source).toBe("none");
    expect(status.meta).toBe(true);
    expect(JSON.stringify(fields)).not.toContain("EAAsecret");
  });

  it("flags values that can no longer be decrypted instead of using them", async () => {
    await prisma.integrationSecret.create({ data: { key: "OPENAI_API_KEY", value: "v1.AAAA.BBBB.CCCC" } });
    const { fields } = await describeIntegrations();
    expect(fields.OPENAI_API_KEY).toMatchObject({ source: "none", unreadable: true });
    expect((await integrationEnv({ fresh: true })).OPENAI_API_KEY).toBeUndefined();
  });

  it("normalises and validates what staff paste in", () => {
    expect(normalizeValue("SHOPIFY_STORE_DOMAIN", " https://Isolation-Store.myshopify.com/admin ")).toBe("isolation-store.myshopify.com");
    expect(() => normalizeValue("SHOPIFY_STORE_DOMAIN", "isolationpvt.shop")).toThrow(IntegrationValueError);
    expect(() => normalizeValue("META_PAGE_ID", "my-page")).toThrow(/numbers/);
    expect(() => normalizeValue("OPENAI_API_KEY", "sk-abc def")).toThrow(/spaces/);
    expect(normalizeValue("OPENAI_MODEL", "gpt-4.1-mini")).toBe("gpt-4.1-mini");
  });

  it("rejects an invalid value without saving any of the batch", async () => {
    await expect(saveIntegrationValues({ OPENAI_API_KEY: "sk-ok", SHOPIFY_STORE_DOMAIN: "isolationpvt.shop" }, "owner@iso.test")).rejects.toThrow(IntegrationValueError);
    expect(await prisma.integrationSecret.count()).toBe(0);
  });
});

describe("webhooks use dashboard credentials", () => {
  it("answers Meta's handshake with a token saved moments ago, even if another instance's cache is stale", async () => {
    await integrationEnv(); // warm the cache with the environment token
    await prisma.integrationSecret.create({ data: { key: "META_VERIFY_TOKEN", value: encryptSecret("fresh-token") } });
    const ok = await metaGet(new Request("http://localhost/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=fresh-token&hub.challenge=777"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
  });

  it("verifies signatures with an app secret saved on the dashboard", async () => {
    await saveIntegrationValues({ META_APP_SECRET: "dashboard-app-secret" }, "owner@iso.test");
    const raw = JSON.stringify({ object: "page", entry: [] });
    const sign = (secret: string) => "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const req = (secret: string) =>
      new Request("http://localhost/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": sign(secret), "x-forwarded-for": "9.9.9.9" }, body: raw });
    expect((await metaPost(req("dashboard-app-secret"))).status).toBe(200);
    expect((await metaPost(req("test-meta-app-secret"))).status).toBe(401);
  });
});

describe("connection checks and automatic webhook setup", () => {
  function mockGraph(responses: Record<string, unknown>) {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const match = Object.keys(responses).find((k) => url.includes(k));
      return new Response(JSON.stringify(match ? responses[match] : { error: { message: "unexpected call", code: 100 } }), { status: match ? 200 : 400 });
    });
    return calls;
  }

  it("names the missing Shopify permissions", () => {
    expect(missingShopifyScopes(["read_products", "write_inventory", "write_orders", "read_customers", "write_draft_orders"])).toEqual([]);
    expect(missingShopifyScopes(["read_products"])).toEqual(["read_inventory", "read_orders", "read_customers", "write_draft_orders"]);
  });

  it("reports the Page name and warns when the Page isn't subscribed to the app", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAApagetoken" }, "owner@iso.test");
    const calls = mockGraph({ "/me?fields=id,name": { id: "55", name: "Isolation" }, "/me/subscribed_apps": { data: [{ id: "other-app" }] } });
    const r = await testConnection("messenger");
    expect(r).toMatchObject({ ok: true, message: 'Connected to the Facebook Page "Isolation".' });
    expect(r.notes?.[0]).toMatch(/isn't subscribed/);
    expect(calls[0].auth).toBe("Bearer EAApagetoken");
    // Tokens travel in the Authorization header — except to /debug_token, whose API takes input_token in the query.
    expect(calls.filter((c) => !c.url.includes("/debug_token")).every((c) => !c.url.includes("EAApagetoken"))).toBe(true);
  });

  it("refuses to register webhooks on a non-public address", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await setupWebhooks("messenger", "http://localhost:3000", "owner@iso.test");
    expect(r.ok).toBe(false);
    expect(r.steps[0].message).toMatch(/public https/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("registers the callback with the app and subscribes the Page", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAApagetoken", META_PAGE_ID: "55", META_VERIFY_TOKEN: null }, "owner@iso.test");
    const calls = mockGraph({ "/999/subscriptions": { success: true }, "/55/subscribed_apps": { success: true } });
    const r = await setupWebhooks("messenger", "https://shop.example.com/", "owner@iso.test");
    expect(r.ok).toBe(true);
    // The one GET is the "is this a Page token?" probe (/me/accounts) — a Page token has no Pages, so nothing is swapped.
    const posts = calls.filter((c) => c.method === "POST");
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([expect.stringContaining("/me/accounts")]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      method: "POST",
      auth: "Bearer 999|test-meta-app-secret",
      body: { object: "page", callback_url: "https://shop.example.com/api/webhooks/meta", verify_token: "test-verify-token", fields: "messages,messaging_postbacks,message_echoes" },
    });
    expect(posts[1]).toMatchObject({ method: "POST", auth: "Bearer EAApagetoken", body: { subscribed_fields: "messages,messaging_postbacks,message_echoes" } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "integrations.webhooks", target: "messenger" } });
    expect(audit.detail).toMatchObject({ ok: true, steps: [{ ok: true }, { ok: true, label: "Subscribe your Facebook Page" }] });
  });

  it("creates a WhatsApp verify token when none exists and reports Meta's error per step", async () => {
    const before = (await integrationEnv()).WHATSAPP_VERIFY_TOKEN;
    await saveIntegrationValues({ WHATSAPP_VERIFY_TOKEN: null, WHATSAPP_ACCESS_TOKEN: "EAAwa", WHATSAPP_BUSINESS_ACCOUNT_ID: "777" }, "owner@iso.test");
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    resetEnvCache();
    const calls = mockGraph({ "/777/subscribed_apps": { success: true } });
    const r = await setupWebhooks("whatsapp", "https://shop.example.com", "owner@iso.test");
    process.env.WHATSAPP_VERIFY_TOKEN = before;
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.ok)).toEqual([false, true]);
    expect(r.steps[0].message).toContain("unexpected call");
    const token = (calls[0].body as { verify_token: string }).verify_token;
    expect(token).toMatch(/^iso_/);
    expect((await integrationEnv({ fresh: true })).WHATSAPP_VERIFY_TOKEN).toBe(token);
  });
});

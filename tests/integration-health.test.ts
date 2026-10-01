import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { clearIntegrationCache, integrationEnv, saveIntegrationValues } from "@/lib/integrations";
import { inspectMetaToken, testConnection } from "@/lib/integrations/connect";
import { checkAllConfigured, integrationHealth, runCheck, servicesOverview } from "@/lib/integrations/health";
import { resetDb } from "./helpers";

/** Answers fetch() by URL substring; anything unlisted gets a Graph-style error. Records every call. */
function mockFetch(responses: Record<string, unknown | ((url: string) => unknown)>) {
  const calls: { url: string; body?: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), { status: 400 });
    const v = responses[key];
    return new Response(JSON.stringify(typeof v === "function" ? (v as (u: string) => unknown)(url) : v), { status: 200 });
  });
  return calls;
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HANDOFF_WEBHOOK_URL;
  resetEnvCache();
  clearIntegrationCache();
});

describe("Meta token inspection", () => {
  it("fails a check for a revoked token and flags expiry, wrong app and missing permissions", async () => {
    const e = await integrationEnv();
    mockFetch({ "input_token=dead": { data: { is_valid: false } } });
    expect((await inspectMetaToken(e, "dead", "messenger")).invalid).toMatch(/no longer valid/);

    vi.restoreAllMocks();
    const soon = Math.floor(Date.now() / 1000) + 3 * 86400;
    mockFetch({ "input_token=short": { data: { is_valid: true, app_id: "123", expires_at: soon, scopes: ["pages_messaging"] } } });
    const { invalid, notes } = await inspectMetaToken(e, "short", "messenger");
    expect(invalid).toBeUndefined();
    expect(notes.join(" ")).toMatch(/different Meta app \(ID 123\)/);
    expect(notes.join(" ")).toMatch(/expires in 3 days/);
    expect(notes.join(" ")).toMatch(/missing these permissions: pages_manage_metadata/);
  });

  it("is quiet about a permanent token with every permission", async () => {
    mockFetch({ debug_token: { data: { is_valid: true, app_id: "999", expires_at: 0, scopes: ["pages_messaging", "pages_manage_metadata"] } } });
    expect(await inspectMetaToken(await integrationEnv(), "good", "messenger")).toEqual({ notes: [] });
  });

  it("turns an expired Page token into a failed Messenger check", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAexpired" }, "owner@iso.test");
    mockFetch({ "/me?fields=id,name": { id: "55", name: "Isolation" }, debug_token: { data: { is_valid: false } } });
    expect(await testConnection("messenger")).toMatchObject({ ok: false, message: expect.stringMatching(/no longer valid/) });
  });
});

describe("stored health", () => {
  it("remembers check results and forgets them when the keys change", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAgood" }, "owner@iso.test");
    mockFetch({ "/me?fields=id,name": { id: "55", name: "Isolation" }, "/me/subscribed_apps": { data: [{ id: "999" }] } });
    await runCheck("messenger", "owner@iso.test");
    let overview = await servicesOverview();
    expect(overview.messenger.check).toMatchObject({ ok: true, message: 'Connected to the Facebook Page "Isolation".', checkedBy: "owner@iso.test" });
    expect(overview.messenger.lastChange?.by).toBe("owner@iso.test");

    await saveIntegrationValues({ META_PAGE_ID: "55" }, "owner@iso.test");
    overview = await servicesOverview();
    expect(overview.messenger.check).toBeNull(); // Page ID feeds the Messenger check
    expect(await prisma.integrationCheck.count()).toBe(0);
  });

  it("shows when the last customer message arrived on each channel", async () => {
    const customer = await prisma.customer.create({ data: { name: "A" } });
    const user = await prisma.channelUser.create({ data: { customerId: customer.id, channel: "INSTAGRAM", externalUserId: "ig-1" } });
    const at = new Date(Date.now() - 5 * 60_000);
    await prisma.conversation.create({ data: { channelUserId: user.id, customerId: customer.id, channel: "INSTAGRAM", lastCustomerMessageAt: at } });
    const overview = await servicesOverview();
    expect(overview.instagram.lastInbound).toBe(at.toISOString());
    expect(overview.messenger.lastInbound).toBeNull();
  });

  it("re-tests configured services, alerts staff once when one breaks, and marks it in the sidebar", async () => {
    process.env.HANDOFF_WEBHOOK_URL = "https://hooks.example.com/alert";
    resetEnvCache();
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAArevoked" }, "owner@iso.test");
    const calls = mockFetch({
      "/999?fields=id,name": { id: "999", name: "Isolation App" },
      "hooks.example.com": { ok: true },
    });

    const first = await checkAllConfigured("maintenance", { alert: true });
    // Environment + dashboard configure the Meta app, Messenger and Instagram; OpenAI, Shopify and WhatsApp aren't set up.
    expect(first.checked.sort()).toEqual(["instagram", "messenger", "meta"]);
    expect(first.failed.sort()).toEqual(["instagram", "messenger"]);
    const alerts = calls.filter((c) => c.url.includes("hooks.example.com"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toMatch(/2 connections stopped working/);
    expect(alerts[0].body).toMatch(/Facebook Messenger/);
    expect(alerts[0].body).not.toMatch(/EAArevoked/);

    await checkAllConfigured("maintenance", { alert: true });
    expect(calls.filter((c) => c.url.includes("hooks.example.com"))).toHaveLength(1); // still broken — no repeat alert

    const health = await integrationHealth();
    expect(health).toMatchObject({ meta: "problem", instagram: "problem", openai: "off", shopify: "off", whatsapp: "off" });
    expect((await prisma.integrationCheck.findUniqueOrThrow({ where: { service: "meta" } })).ok).toBe(true);
  });

  it("skips a check that doesn't answer in time instead of calling it broken", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAslow" }, "owner@iso.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    const r = await checkAllConfigured("maintenance", { timeoutMs: 50 });
    expect(r.failed).toEqual([]);
    expect(r.skipped.sort()).toEqual(["instagram", "messenger", "meta"]);
    expect(await prisma.integrationCheck.count()).toBe(0);
  });
});

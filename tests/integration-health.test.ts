import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { clearIntegrationCache, integrationEnv, saveIntegrationValues } from "@/lib/integrations";
import { inspectMetaToken, registerWhatsAppNumber, setupWebhooks, testConnection } from "@/lib/integrations/connect";
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

describe("Page tokens and the Meta app secret", () => {
  it("swaps a pasted System User token for the Page's own token", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAsystemuser" }, "owner@iso.test");
    const calls = mockFetch({
      "/me/accounts": { data: [{ id: "4455", name: "Isolation", access_token: "EAApage4455" }] },
      "/4455?fields=id,name": { id: "4455", name: "Isolation" },
      "/4455/subscribed_apps": { data: [{ id: "999" }] },
      debug_token: { data: { is_valid: true, app_id: "999", expires_at: 0, scopes: ["pages_messaging", "pages_manage_metadata"] } },
    });
    const r = await testConnection("messenger", "owner@iso.test");
    expect(r).toMatchObject({ ok: true, message: 'Connected to the Facebook Page "Isolation".' });
    expect(r.notes?.[0]).toMatch(/swapped for the Page access token of "Isolation"/);
    const e = await integrationEnv({ fresh: true });
    expect(e.META_ACCESS_TOKEN).toBe("EAApage4455");
    expect(e.META_PAGE_ID).toBe("4455");
    // Everything after the swap uses the Page token.
    expect(calls.find((c) => c.url.includes("/4455?fields=id,name"))).toBeTruthy();
  });

  it("asks which Page to use when the token manages several, and explains a token with no Pages", async () => {
    await saveIntegrationValues({ META_ACCESS_TOKEN: "EAAsystemuser" }, "owner@iso.test");
    mockFetch({ "/me/accounts": { data: [{ id: "1", name: "Isolation", access_token: "a" }, { id: "2", name: "Isolation Outlet", access_token: "b" }] } });
    expect((await testConnection("messenger")).message).toMatch(/several Pages.*Isolation \(1\), Isolation Outlet \(2\)/);

    vi.restoreAllMocks();
    mockFetch({ "/me/accounts": { data: [] } });
    expect((await testConnection("messenger")).message).toMatch(/doesn't manage any Facebook Page/);
    expect((await integrationEnv({ fresh: true })).META_ACCESS_TOKEN).toBe("EAAsystemuser"); // nothing swapped
  });

  it("fails channel checks clearly when the App secret is missing", async () => {
    const secret = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    resetEnvCache();
    try {
      await saveIntegrationValues({ META_ACCESS_TOKEN: "EAApage", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
      const calls = mockFetch({ "/1234567890?fields": { id: "1234567890", display_phone_number: "+880 1711-000000" } });
      for (const s of ["messenger", "instagram"] as const) {
        expect(await testConnection(s)).toMatchObject({ ok: false, message: expect.stringMatching(/App secret/) });
      }
      expect(calls).toHaveLength(0);
      // WhatsApp still looks up the number first, so that part is done once the secret is added.
      expect(await testConnection("whatsapp")).toMatchObject({ ok: false, message: expect.stringMatching(/App secret/) });
    } finally {
      process.env.META_APP_SECRET = secret;
    }
  });

  it("says how to fix a token that can't reach any WhatsApp number", async () => {
    await saveIntegrationValues({ WHATSAPP_PHONE_NUMBER_ID: "777", WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    mockFetch({ "/777?fields": { id: "777" }, debug_token: { data: { is_valid: true, app_id: "999", expires_at: 0, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } } });
    const r = await testConnection("whatsapp");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Couldn't find a WhatsApp number this token can use.*Assign assets/);
  });

  it("shows a failed check as a problem in the sidebar even before everything is configured", async () => {
    await prisma.integrationCheck.create({ data: { service: "whatsapp", ok: false, message: "App secret missing" } });
    expect((await integrationHealth()).whatsapp).toBe("problem");
  });
});

describe("WhatsApp: finding the number from the token", () => {
  const NUMBER = { id: "111222333", display_phone_number: "+880 1711-000000", verified_name: "Isolation", platform_type: "CLOUD_API", status: "CONNECTED", code_verification_status: "VERIFIED" };
  const tokenInfo = (granular?: { scope: string; target_ids?: string[] }[]) => ({
    data: { is_valid: true, app_id: "999", expires_at: 0, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"], granular_scopes: granular },
  });
  const assigned = tokenInfo([
    { scope: "whatsapp_business_management", target_ids: ["555"] },
    { scope: "whatsapp_business_messaging", target_ids: ["555"] },
  ]);

  it("fills in the Phone number ID and account ID when only the token is pasted", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    mockFetch({ "/555/phone_numbers": { data: [NUMBER] }, "/555?fields=name": { name: "Isolation WA" }, "/111222333?fields": NUMBER, debug_token: assigned });
    const r = await testConnection("whatsapp", "owner@iso.test");
    expect(r).toMatchObject({ ok: true, message: "Connected to +880 1711-000000 (Isolation). The number was found from your token and its IDs saved for you." });
    expect(r.notes).toBeUndefined();
    const e = await integrationEnv({ fresh: true });
    expect(e.WHATSAPP_PHONE_NUMBER_ID).toBe("111222333");
    expect(e.WHATSAPP_BUSINESS_ACCOUNT_ID).toBe("555");
  });

  it("replaces a phone number typed into the Phone number ID box", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa", WHATSAPP_PHONE_NUMBER_ID: "8801711000000" }, "owner@iso.test");
    mockFetch({ "/555/phone_numbers": { data: [NUMBER] }, "/555?fields=name": { name: "Isolation WA" }, "/111222333?fields": NUMBER, debug_token: assigned });
    const r = await testConnection("whatsapp");
    expect(r.ok).toBe(true);
    expect(r.notes?.[0]).toMatch(/\(8801711000000\) isn't one of your WhatsApp numbers, so it was replaced with the ID of \+880 1711-000000/);
    expect((await integrationEnv({ fresh: true })).WHATSAPP_PHONE_NUMBER_ID).toBe("111222333");
  });

  it("lets staff choose when the token can use several numbers", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    const second = { ...NUMBER, id: "444", display_phone_number: "+880 1811-000000", verified_name: "Isolation Outlet" };
    mockFetch({ "/555/phone_numbers": { data: [NUMBER, second] }, "/555?fields=name": { name: "Isolation WA" }, debug_token: assigned });
    const r = await testConnection("whatsapp");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can use 2 WhatsApp numbers/);
    expect(r.choices).toEqual([
      { label: "+880 1711-000000", detail: "Isolation · account “Isolation WA”", values: { WHATSAPP_PHONE_NUMBER_ID: "111222333", WHATSAPP_BUSINESS_ACCOUNT_ID: "555" } },
      { label: "+880 1811-000000", detail: "Isolation Outlet · account “Isolation WA”", values: { WHATSAPP_PHONE_NUMBER_ID: "444", WHATSAPP_BUSINESS_ACCOUNT_ID: "555" } },
    ]);
    expect((await integrationEnv({ fresh: true })).WHATSAPP_PHONE_NUMBER_ID).toBeUndefined();
  });

  it("finds the account through the business when the token isn't limited to one", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    mockFetch({
      "/me/businesses": { data: [{ id: "b1" }] },
      "/b1/owned_whatsapp_business_accounts": { data: [{ id: "555" }] },
      "/b1/client_whatsapp_business_accounts": { data: [] },
      "/555/phone_numbers": { data: [NUMBER] },
      "/555?fields=name": { name: "Isolation WA" },
      "/111222333?fields": NUMBER,
      debug_token: tokenInfo(),
    });
    expect((await testConnection("whatsapp")).ok).toBe(true);
    expect((await integrationEnv({ fresh: true })).WHATSAPP_BUSINESS_ACCOUNT_ID).toBe("555");
  });

  it("saves the number even before the App secret is added", async () => {
    const secret = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    resetEnvCache();
    try {
      await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
      mockFetch({ "/555/phone_numbers": { data: [NUMBER] }, "/555?fields=name": { name: "Isolation WA" }, "/111222333?fields": NUMBER, debug_token: assigned });
      const r = await testConnection("whatsapp");
      expect(r.message).toMatch(/App secret/);
      expect(r.notes?.[0]).toMatch(/\+880 1711-000000 was found and saved/);
      expect((await integrationEnv({ fresh: true })).WHATSAPP_PHONE_NUMBER_ID).toBe("111222333");
    } finally {
      process.env.META_APP_SECRET = secret;
    }
  });

  it("explains an account without a number", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    mockFetch({ "/555/phone_numbers": { data: [] }, "/555?fields=name": { name: "Isolation WA" }, debug_token: assigned });
    const r = await testConnection("whatsapp");
    expect(r.message).toMatch(/“Isolation WA” doesn't have a phone number yet.*Add phone number/);
    expect((await integrationEnv({ fresh: true })).WHATSAPP_BUSINESS_ACCOUNT_ID).toBe("555");
  });

  it("spots a number that still needs registering, and registers it with a PIN", async () => {
    const pending = { ...NUMBER, platform_type: "NOT_APPLICABLE" };
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa" }, "owner@iso.test");
    const calls = mockFetch({
      "/111222333/register": { success: true },
      "/555/phone_numbers": { data: [pending] },
      "/555?fields=name": { name: "Isolation WA" },
      "/111222333?fields": pending,
      debug_token: assigned,
    });
    const r = await testConnection("whatsapp");
    expect(r.ok).toBe(true);
    expect(r.notes?.[0]).toMatch(/isn't registered for the WhatsApp Cloud API yet/);

    const reg = await registerWhatsAppNumber("123456", "owner@iso.test");
    expect(reg.ok).toBe(true);
    expect(JSON.parse(calls.find((c) => c.url.includes("/register"))!.body!)).toEqual({ messaging_product: "whatsapp", pin: "123456" });
  });

  it("webhook setup finds a missing account ID by itself", async () => {
    await saveIntegrationValues({ WHATSAPP_ACCESS_TOKEN: "EAAwa", WHATSAPP_PHONE_NUMBER_ID: "111222333" }, "owner@iso.test");
    const calls = mockFetch({
      "/999/subscriptions": { success: true },
      "/555/subscribed_apps": { success: true },
      "/555/phone_numbers": { data: [NUMBER] },
      "/555?fields=name": { name: "Isolation WA" },
      debug_token: assigned,
    });
    const r = await setupWebhooks("whatsapp", "https://shop.example.com", "owner@iso.test");
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.label)).toContain("Subscribe your WhatsApp Business Account");
    expect(calls.some((c) => c.url.includes("/555/subscribed_apps"))).toBe(true);
  });
});

describe("Instagram Login", () => {
  it("needs the Instagram app secret, then fills in the account ID and spots a missing subscription", async () => {
    await saveIntegrationValues({ INSTAGRAM_ACCESS_TOKEN: "IGAAtoken123" }, "owner@iso.test");
    expect((await testConnection("instagram")).message).toMatch(/Instagram app secret/);

    await saveIntegrationValues({ INSTAGRAM_APP_SECRET: "0123456789abcdef0123456789abcdef" }, "owner@iso.test");
    const calls = mockFetch({
      "graph.instagram.com/v23.0/me?": { user_id: "1789", username: "isolation.pvt" },
      "/1789/subscribed_apps": { data: [] },
    });
    const r = await testConnection("instagram", "owner@iso.test");
    expect(r).toMatchObject({ ok: true, message: "Connected to @isolation.pvt (Instagram Login)." });
    expect(r.notes?.[0]).toMatch(/isn't subscribed to webhooks/);
    expect((await integrationEnv({ fresh: true })).INSTAGRAM_ACCOUNT_ID).toBe("1789");
    // graph.instagram.com calls carry the token as a query parameter.
    expect(calls[0].url).toContain("access_token=IGAAtoken123");
  });

  it("accepts webhooks signed with the Instagram app secret", async () => {
    const crypto = await import("node:crypto");
    const { POST } = await import("@/app/api/webhooks/meta/route");
    await saveIntegrationValues({ INSTAGRAM_APP_SECRET: "fedcba9876543210fedcba9876543210" }, "owner@iso.test");
    const raw = JSON.stringify({ object: "instagram", entry: [] });
    const sig = "sha256=" + crypto.createHmac("sha256", "fedcba9876543210fedcba9876543210").update(raw).digest("hex");
    const res = await POST(new Request("http://localhost/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": sig, "x-forwarded-for": "8.8.8.8" }, body: raw }));
    expect(res.status).toBe(200);
  });

  it("subscribes the Instagram account and lists the one dashboard step it can't do", async () => {
    const { setupWebhooks } = await import("@/lib/integrations/connect");
    await saveIntegrationValues({ INSTAGRAM_ACCESS_TOKEN: "IGAAtoken123", INSTAGRAM_APP_SECRET: "0123456789abcdef0123456789abcdef", INSTAGRAM_ACCOUNT_ID: "1789" }, "owner@iso.test");
    const calls = mockFetch({ "/1789/subscribed_apps": { success: true } });
    const r = await setupWebhooks("instagram", "https://shop.example.com", "owner@iso.test");
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ manual: true, message: expect.stringContaining("https://shop.example.com/api/webhooks/meta") });
    expect(r.steps[1]).toMatchObject({ ok: true, label: "Subscribe your Instagram account" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/subscribed_fields=messages%2Cmessaging_postbacks/);
  });

  it("renews a week-old token and leaves a fresh one alone", async () => {
    const { refreshInstagramToken } = await import("@/lib/integrations/connect");
    await saveIntegrationValues({ INSTAGRAM_ACCESS_TOKEN: "IGAAold", INSTAGRAM_APP_SECRET: "0123456789abcdef0123456789abcdef" }, "owner@iso.test");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await refreshInstagramToken("maintenance")).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await prisma.integrationSecret.update({ where: { key: "INSTAGRAM_ACCESS_TOKEN" }, data: { updatedAt: new Date(Date.now() - 8 * 86400_000) } });
    const calls = mockFetch({ "graph.instagram.com/refresh_access_token": { access_token: "IGAAnew", expires_in: 5184000 } });
    expect(await refreshInstagramToken("maintenance")).toBe("refreshed");
    expect(calls[0].url).toContain("grant_type=ig_refresh_token");
    expect((await integrationEnv({ fresh: true })).INSTAGRAM_ACCESS_TOKEN).toBe("IGAAnew");
  });
});

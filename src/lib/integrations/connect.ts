import OpenAI from "openai";
import { prisma } from "../db";
import type { Env } from "../env";
import { graphRequest } from "../channels/http";
import { shopifyGraphQL } from "../shopify/client";
import { ShopifyNotConfiguredError, ShopifyUnavailableError } from "../shopify/types";
import { generateVerifyToken, integrationEnv, saveIntegrationValues } from "./index";

/** "Test connection" and "Set up webhooks for me" for the dashboard's Integrations page. */

export type ServiceId = "openai" | "shopify" | "meta" | "messenger" | "instagram" | "whatsapp";
export const SERVICE_IDS: ServiceId[] = ["openai", "shopify", "meta", "messenger", "instagram", "whatsapp"];

export interface CheckResult {
  ok: boolean;
  message: string;
  /** Extra hints, e.g. missing Shopify permissions or a Page not yet subscribed to webhooks. */
  notes?: string[];
}

const graph = (e: Env) => `https://graph.facebook.com/${e.META_GRAPH_VERSION}`;
const igGraph = (e: Env) => `https://graph.instagram.com/${e.META_GRAPH_VERSION}`;
const appToken = (e: Env) => `${e.META_APP_ID}|${e.META_APP_SECRET}`;
const usesInstagramLogin = (e: Env) => Boolean(e.INSTAGRAM_ACCESS_TOKEN?.startsWith("IG"));

/** Shopify scopes the assistant needs (see README §6). A write scope implies its read scope. */
export const REQUIRED_SHOPIFY_SCOPES = ["read_products", "read_inventory", "read_orders", "read_customers", "write_draft_orders"];

export function missingShopifyScopes(granted: string[]): string[] {
  const has = new Set(granted);
  return REQUIRED_SHOPIFY_SCOPES.filter((s) => !has.has(s) && !(s.startsWith("read_") && has.has(`write_${s.slice(5)}`)));
}

async function getJson<T>(url: string, token: string) {
  return graphRequest<T>(url, token, { method: "GET" }, 1);
}

/** Permissions each Meta token needs: [needed to reply, needed for automatic webhook setup]. */
const META_SCOPES = {
  messenger: ["pages_messaging", "pages_manage_metadata"],
  instagram: ["instagram_basic", "instagram_manage_messages"],
  whatsapp: ["whatsapp_business_messaging", "whatsapp_business_management"],
} as const;

interface TokenInfo {
  is_valid?: boolean;
  app_id?: string;
  expires_at?: number;
  scopes?: string[];
}

/**
 * Inspects a Meta token with Graph API /debug_token (needs the App ID + secret): catches tokens that
 * expired, will expire (short-lived tokens from the Graph Explorer), lack permissions, or belong to
 * another app. Returns `invalid` when the token can't be used at all.
 */
export async function inspectMetaToken(e: Env, token: string, kind: keyof typeof META_SCOPES): Promise<{ invalid?: string; notes: string[] }> {
  if (!e.META_APP_ID || !e.META_APP_SECRET) return { notes: [] };
  // input_token must be a query parameter here; graphRequest never logs query strings.
  const r = await getJson<{ data?: TokenInfo }>(`${graph(e)}/debug_token?input_token=${encodeURIComponent(token)}`, appToken(e));
  const info = r.ok ? r.data?.data : undefined;
  if (!info) return { notes: [] }; // can't inspect (e.g. token from another app's secret) — not a failure by itself
  if (info.is_valid === false) return { invalid: "Meta says this token is no longer valid — it expired or was revoked. Generate a new one.", notes: [] };
  const notes: string[] = [];
  if (info.app_id && info.app_id !== e.META_APP_ID) {
    notes.push(`This token was made for a different Meta app (ID ${info.app_id}), not ${e.META_APP_ID}. Generate it for your app so webhooks and replies match.`);
  }
  if (info.expires_at && info.expires_at > 0) {
    const when = new Date(info.expires_at * 1000);
    const days = Math.round((when.getTime() - Date.now()) / 86400_000);
    notes.push(
      `This token expires ${days <= 1 ? "within a day" : `in ${days} days`} (${when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}). ` +
        "Use a System User token from Business Settings — those never expire."
    );
  }
  const missing = info.scopes ? META_SCOPES[kind].filter((s) => !info.scopes!.includes(s)) : [];
  if (missing.length) notes.push(`The token is missing these permissions: ${missing.join(", ")}. Generate it again with them ticked.`);
  return { notes };
}

const MISSING_IG_APP_SECRET =
  "Add the Instagram app secret — Instagram Login messages are signed with it. It's in your Meta app → Instagram → API setup with Instagram login.";

/** graph.instagram.com call with the token as a query parameter (never logged). */
async function igCall<T>(method: "GET" | "POST", url: string, token: string, params: Record<string, string> = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  try {
    const res = await fetch(u, { method, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
    if (res.ok && !json.error) return { ok: true, data: json };
    return { ok: false, error: `${json.error?.message ?? `HTTP ${res.status}`}${json.error?.code ? ` (code ${json.error.code})` : ""}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Instagram Login tokens last 60 days and can be renewed any time after the first day. Renews a
 * dashboard-saved token once it is a week old, so it never lapses (run by the daily maintenance).
 */
export async function refreshInstagramToken(actor: string): Promise<"refreshed" | "skipped" | { failed: string }> {
  const row = await prisma.integrationSecret.findUnique({ where: { key: "INSTAGRAM_ACCESS_TOKEN" }, select: { updatedAt: true } });
  if (!row || Date.now() - row.updatedAt.getTime() < 7 * 86400_000) return "skipped";
  const e = await integrationEnv({ fresh: true });
  if (!usesInstagramLogin(e)) return "skipped";
  // The refresh endpoint is unversioned.
  const r = await igCall<{ access_token?: string }>("GET", "https://graph.instagram.com/refresh_access_token", e.INSTAGRAM_ACCESS_TOKEN!, { grant_type: "ig_refresh_token" });
  if (!r.ok || !r.data?.access_token) return { failed: r.error ?? "no token returned" };
  await saveIntegrationValues({ INSTAGRAM_ACCESS_TOKEN: r.data.access_token }, actor);
  return "refreshed";
}

const MISSING_APP_SECRET =
  "Add your Meta app's App ID and App secret on the Meta app card first — without the App secret, every incoming message is rejected as unverified.";

/**
 * The Send API needs a *Page* access token. The token Business Settings → System users → "Generate new
 * token" gives you is a System User token: it can manage Pages but can't send as one. Swap it for the
 * managed Page's own token (which inherits "never expires") and remember the Page ID.
 */
export async function ensurePageToken(e: Env, actor: string): Promise<{ e: Env; note?: string; error?: string }> {
  if (!e.META_ACCESS_TOKEN) return { e };
  const r = await getJson<{ data?: { id: string; name: string; access_token?: string }[] }>(`${graph(e)}/me/accounts?fields=id,name,access_token&limit=100`, e.META_ACCESS_TOKEN);
  if (!r.ok) return { e }; // Page tokens have no Pages of their own; any other problem shows up in the normal check
  const pages = r.data?.data ?? [];
  const list = pages.map((p) => `${p.name} (${p.id})`).join(", ");
  if (!pages.length) {
    return { e, error: "This is a System User (or personal) token, not a Page token, and it doesn't manage any Facebook Page. In Business Settings → System users → Assign assets, give it your Page with full control, then generate the token again." };
  }
  const pick = e.META_PAGE_ID ? pages.find((p) => p.id === e.META_PAGE_ID) : pages.length === 1 ? pages[0] : undefined;
  if (!pick) {
    return { e, error: e.META_PAGE_ID ? `This token doesn't manage the Page ${e.META_PAGE_ID}. It manages: ${list}. Put the right Page ID in the Page ID box.` : `This token manages several Pages — put the Page ID of the one to use in the Page ID box: ${list}.` };
  }
  if (!pick.access_token) return { e, error: `Meta didn't give out a token for "${pick.name}". Generate the token with pages_show_list, and assign the Page to the System User with full control.` };
  await saveIntegrationValues({ META_ACCESS_TOKEN: pick.access_token, META_PAGE_ID: pick.id }, actor);
  return { e: await integrationEnv({ fresh: true }), note: `You pasted a System User token, so it was swapped for the Page access token of "${pick.name}" automatically.` };
}

export async function testConnection(service: ServiceId, actor = "system"): Promise<CheckResult> {
  // Fresh read so a value saved a moment ago (possibly on another server instance) is used.
  let e = await integrationEnv({ fresh: true });
  switch (service) {
    case "openai": {
      if (!e.OPENAI_API_KEY) return { ok: false, message: "Add your OpenAI API key first." };
      try {
        const client = new OpenAI({ apiKey: e.OPENAI_API_KEY, timeout: 15_000, maxRetries: 0 });
        const m = await client.models.retrieve(e.OPENAI_MODEL);
        return { ok: true, message: `Connected — the model ${m.id} is ready to use.` };
      } catch (err) {
        if (err instanceof OpenAI.APIError) {
          if (err.status === 401) return { ok: false, message: "OpenAI rejected this API key. Copy it again from platform.openai.com → API keys." };
          if (err.status === 404) return { ok: false, message: `The key works, but the model "${e.OPENAI_MODEL}" isn't available to it. Try gpt-4.1-mini.` };
          if (err.status === 429) return { ok: false, message: "OpenAI says this account is out of credit or over its limit. Check Settings → Billing on platform.openai.com." };
          return { ok: false, message: `OpenAI error: ${err.message}` };
        }
        return { ok: false, message: `Couldn't reach OpenAI: ${(err as Error).message}` };
      }
    }

    case "shopify": {
      try {
        const data = await shopifyGraphQL<{ shop: { name: string; myshopifyDomain: string }; currentAppInstallation: { accessScopes: { handle: string }[] } | null }>(
          `{ shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`
        );
        const missing = missingShopifyScopes(data.currentAppInstallation?.accessScopes.map((s) => s.handle) ?? []);
        return {
          ok: true,
          message: `Connected to ${data.shop.name} (${data.shop.myshopifyDomain}).`,
          notes: missing.length ? [`The app is missing these permissions: ${missing.join(", ")}. Add them in the app's configuration and reinstall it, or some answers and orders will fail.`] : undefined,
        };
      } catch (err) {
        if (err instanceof ShopifyNotConfiguredError) return { ok: false, message: "Add the store address and an access token (or client ID + secret) first." };
        if (err instanceof ShopifyUnavailableError) return { ok: false, message: err.message };
        return { ok: false, message: `Couldn't reach Shopify: ${(err as Error).message}` };
      }
    }

    case "meta": {
      if (!e.META_APP_ID || !e.META_APP_SECRET) return { ok: false, message: "Add the App ID and App secret first." };
      const r = await getJson<{ id: string; name?: string }>(`${graph(e)}/${e.META_APP_ID}?fields=id,name`, appToken(e));
      if (!r.ok) return { ok: false, message: `Meta didn't accept this App ID / App secret pair: ${r.error}` };
      return {
        ok: true,
        message: `Connected to the Meta app "${r.data?.name ?? e.META_APP_ID}".`,
        notes: e.META_VERIFY_TOKEN ? undefined : ["No webhook verify token yet — click “Generate” below."],
      };
    }

    case "messenger": {
      if (!e.META_ACCESS_TOKEN) return { ok: false, message: "Add the Page access token first." };
      if (!e.META_APP_ID || !e.META_APP_SECRET) return { ok: false, message: MISSING_APP_SECRET };
      const swap = await ensurePageToken(e, actor);
      if (swap.error) return { ok: false, message: swap.error };
      e = swap.e;
      if (!e.META_ACCESS_TOKEN) return { ok: false, message: "Add the Page access token first." };
      const page = e.META_PAGE_ID ?? "me";
      const r = await getJson<{ id: string; name?: string }>(`${graph(e)}/${page}?fields=id,name`, e.META_ACCESS_TOKEN);
      if (!r.ok) return { ok: false, message: `Meta rejected the Page token: ${r.error}` };
      const token = await inspectMetaToken(e, e.META_ACCESS_TOKEN, "messenger");
      if (token.invalid) return { ok: false, message: token.invalid };
      const notes = [...(swap.note ? [swap.note] : []), ...token.notes];
      const subs = await getJson<{ data?: { id: string }[] }>(`${graph(e)}/${page}/subscribed_apps`, e.META_ACCESS_TOKEN);
      if (subs.ok && e.META_APP_ID && !subs.data?.data?.some((a) => a.id === e.META_APP_ID)) {
        notes.push("This Page isn't subscribed to your app's webhooks yet, so messages won't arrive. Use “Set up webhooks for me” below.");
      }
      return { ok: true, message: `Connected to the Facebook Page "${r.data?.name ?? r.data?.id}".`, notes: notes.length ? notes : undefined };
    }

    case "instagram": {
      if (usesInstagramLogin(e)) {
        if (!e.INSTAGRAM_APP_SECRET) return { ok: false, message: MISSING_IG_APP_SECRET };
        const token = e.INSTAGRAM_ACCESS_TOKEN!;
        const r = await igCall<{ username?: string; user_id?: string }>("GET", `${igGraph(e)}/me`, token, { fields: "user_id,username" });
        if (!r.ok) return { ok: false, message: `Instagram rejected the token: ${r.error}. Generate a new one in your Meta app → Instagram → API setup with Instagram login.` };
        const notes: string[] = [];
        const userId = r.data?.user_id;
        // Remember the account ID so replies and webhook subscriptions address the right account.
        if (userId && userId !== e.INSTAGRAM_ACCOUNT_ID) await saveIntegrationValues({ INSTAGRAM_ACCOUNT_ID: userId }, actor);
        const subs = await igCall<{ data?: unknown[] }>("GET", `${igGraph(e)}/${userId ?? "me"}/subscribed_apps`, token);
        if (subs.ok && !subs.data?.data?.length) {
          notes.push("Your Instagram account isn't subscribed to webhooks yet, so DMs won't arrive. Use “Set up webhooks for me” below.");
        }
        if (process.env.INSTAGRAM_ACCESS_TOKEN === token) {
          notes.push("This token comes from Vercel and expires after 60 days. Paste it here instead so it's renewed automatically.");
        }
        return { ok: true, message: `Connected to @${r.data?.username ?? userId} (Instagram Login).`, notes: notes.length ? notes : undefined };
      }
      if (!e.META_APP_ID || !e.META_APP_SECRET) return { ok: false, message: MISSING_APP_SECRET };
      let swapNote: string | undefined;
      if (!e.INSTAGRAM_ACCESS_TOKEN) {
        const swap = await ensurePageToken(e, actor);
        if (swap.error) return { ok: false, message: swap.error };
        e = swap.e;
        swapNote = swap.note;
      }
      const token = e.INSTAGRAM_ACCESS_TOKEN ?? e.META_ACCESS_TOKEN;
      if (!token) return { ok: false, message: "Connect Messenger first — Instagram uses the same Page token." };
      const r = await getJson<{ instagram_business_account?: { id: string; username?: string } }>(
        `${graph(e)}/${e.META_PAGE_ID ?? "me"}?fields=instagram_business_account{id,username}`,
        token
      );
      if (!r.ok) return { ok: false, message: `Meta rejected the token: ${r.error}` };
      const ig = r.data?.instagram_business_account;
      if (!ig) return { ok: false, message: "This Facebook Page has no Instagram professional account linked. Link your Instagram professional account to the Page in Meta Business Suite, then test again." };
      const inspected = await inspectMetaToken(e, token, "instagram");
      if (inspected.invalid) return { ok: false, message: inspected.invalid };
      const igNotes = [...(swapNote ? [swapNote] : []), ...inspected.notes];
      return { ok: true, message: `Connected to @${ig.username ?? ig.id} through your Facebook Page.`, notes: igNotes.length ? igNotes : undefined };
    }

    case "whatsapp": {
      if (!e.WHATSAPP_PHONE_NUMBER_ID || !e.WHATSAPP_ACCESS_TOKEN) return { ok: false, message: "Add the Phone number ID and access token first." };
      if (!(e.WHATSAPP_APP_SECRET ?? e.META_APP_SECRET)) return { ok: false, message: MISSING_APP_SECRET };
      const r = await getJson<{ display_phone_number?: string; verified_name?: string }>(
        `${graph(e)}/${e.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`,
        e.WHATSAPP_ACCESS_TOKEN
      );
      if (!r.ok) return { ok: false, message: `Meta rejected the WhatsApp details: ${r.error}` };
      // A WhatsApp app with its own secret can't be inspected with the main app's credentials.
      const sameApp = !e.WHATSAPP_APP_SECRET || e.WHATSAPP_APP_SECRET === e.META_APP_SECRET;
      const inspected = sameApp ? await inspectMetaToken(e, e.WHATSAPP_ACCESS_TOKEN, "whatsapp") : { notes: [] };
      if (inspected.invalid) return { ok: false, message: inspected.invalid };
      const waNotes = [...inspected.notes];
      if (!r.data?.display_phone_number) {
        waNotes.unshift("Meta didn't return a phone number for this ID. Check it's the Phone number ID from WhatsApp → API Setup (not the WhatsApp Business Account ID), and that the token has whatsapp_business_management.");
      }
      return {
        ok: true,
        message: `Connected to ${r.data?.display_phone_number ?? "your number"}${r.data?.verified_name ? ` (${r.data.verified_name})` : ""}.`,
        notes: waNotes.length ? waNotes : undefined,
      };
    }
  }
}

// ---------- automatic webhook setup ----------

export interface SetupStep {
  label: string;
  ok: boolean;
  /** Can't be done through the API — the message says what to do in the Meta App Dashboard. */
  manual?: boolean;
  message: string;
}

export function webhookUrls(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return { meta: `${base}/api/webhooks/meta`, whatsapp: `${base}/api/webhooks/whatsapp` };
}

export function isPublicHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

async function post(url: string, token: string, body: Record<string, unknown>, label: string, okMessage: string): Promise<SetupStep> {
  const r = await graphRequest<{ success?: boolean }>(url, token, { method: "POST", body }, 1);
  return r.ok ? { label, ok: true, message: okMessage } : { label, ok: false, message: r.error ?? "failed" };
}

/**
 * Registers the callback URL with the Meta app (Graph API /{app-id}/subscriptions — Meta immediately
 * calls our GET handshake with the verify token) and subscribes the Page / Instagram account /
 * WhatsApp Business Account to the app.
 */
export async function setupWebhooks(service: "messenger" | "instagram" | "whatsapp", baseUrl: string, actor: string): Promise<{ ok: boolean; steps: SetupStep[] }> {
  const fail = (message: string) => ({ ok: false, steps: [{ label: "Check", ok: false, message }] });
  if (!isPublicHttps(baseUrl)) return fail(`Webhooks need a public https address, but this dashboard is running at ${baseUrl}. Open it from your live site (e.g. https://isolation-ai.vercel.app) and try again.`);

  let e = await integrationEnv({ fresh: true });
  const igLogin = service === "instagram" && usesInstagramLogin(e);
  if (!igLogin && (!e.META_APP_ID || !e.META_APP_SECRET)) return fail("Connect your Meta app (App ID + App secret) first.");

  const tokenKey = service === "whatsapp" ? "WHATSAPP_VERIFY_TOKEN" : "META_VERIFY_TOKEN";
  if (!e[tokenKey]) {
    await saveIntegrationValues({ [tokenKey]: generateVerifyToken() }, actor);
    e = await integrationEnv({ fresh: true });
  }
  const urls = webhookUrls(baseUrl);
  const steps: SetupStep[] = [];

  const instagramDashboardStep = (extra = ""): SetupStep => ({
    label: "Add the webhook address in your Meta app",
    ok: false,
    manual: true,
    message:
      `In your Meta app open Instagram → ${igLogin ? "API setup with Instagram login → Configure webhooks" : "Webhooks"}, paste ${urls.meta} as the Callback URL and the Verify token shown here, ` +
      `click Verify and save, then subscribe to messages and messaging_postbacks.${extra}`,
  });

  if (igLogin) {
    // Instagram Login: the app-level webhook is set in the App Dashboard; the account subscribes per user.
    steps.push(instagramDashboardStep());
    const r = await igCall<{ success?: boolean }>("POST", `${igGraph(e)}/${e.INSTAGRAM_ACCOUNT_ID ?? "me"}/subscribed_apps`, e.INSTAGRAM_ACCESS_TOKEN!, {
      subscribed_fields: "messages,messaging_postbacks",
    });
    steps.push({ label: "Subscribe your Instagram account", ok: r.ok, message: r.ok ? "Instagram account subscribed to messages" : r.error ?? "failed" });
    return finish();
  }

  if (service === "messenger" || service === "instagram") {
    const object = service === "messenger" ? "page" : "instagram";
    const fields = service === "messenger" ? "messages,messaging_postbacks,message_echoes" : "messages,messaging_postbacks";
    const appLevel = await post(
      `${graph(e)}/${e.META_APP_ID}/subscriptions`,
      appToken(e),
      { object, callback_url: urls.meta, verify_token: e.META_VERIFY_TOKEN, fields, include_values: true },
      "Register the webhook address with your Meta app",
      `Meta verified ${urls.meta}`
    );
    // Meta doesn't always let apps register the Instagram webhook through the API — fall back to the dashboard.
    steps.push(service === "instagram" && !appLevel.ok ? instagramDashboardStep(` (Meta said: ${appLevel.message})`) : appLevel);
    if (!e.META_ACCESS_TOKEN) {
      steps.push({ label: "Subscribe your Facebook Page", ok: false, message: "Add the Page access token on the Messenger card first." });
    } else {
      const swap = await ensurePageToken(e, actor);
      if (swap.note) steps.push({ label: "Use your Page's token", ok: true, message: swap.note });
      if (swap.error) {
        steps.push({ label: "Subscribe your Facebook Page", ok: false, message: swap.error });
        return finish();
      }
      e = swap.e;
      steps.push(
        await post(
          `${graph(e)}/${e.META_PAGE_ID ?? "me"}/subscribed_apps`,
          e.META_ACCESS_TOKEN ?? "",
          { subscribed_fields: "messages,messaging_postbacks,message_echoes" },
          "Subscribe your Facebook Page",
          "Page subscribed to messages"
        )
      );
    }
  } else {
    if (e.WHATSAPP_APP_SECRET && e.WHATSAPP_APP_SECRET !== e.META_APP_SECRET) {
      return fail("WhatsApp is set up in a different Meta app, so its webhook must be set in that app: WhatsApp → Configuration → Webhook, using the address and verify token shown here.");
    }
    steps.push(
      await post(
        `${graph(e)}/${e.META_APP_ID}/subscriptions`,
        appToken(e),
        { object: "whatsapp_business_account", callback_url: urls.whatsapp, verify_token: e.WHATSAPP_VERIFY_TOKEN, fields: "messages", include_values: true },
        "Register the webhook address with your Meta app",
        `Meta verified ${urls.whatsapp}`
      )
    );
    if (!e.WHATSAPP_ACCESS_TOKEN) {
      steps.push({ label: "Subscribe your WhatsApp Business Account", ok: false, message: "Add the WhatsApp access token first." });
    } else if (!e.WHATSAPP_BUSINESS_ACCOUNT_ID) {
      steps.push({ label: "Subscribe your WhatsApp Business Account", ok: false, message: "Add your WhatsApp Business Account ID (WhatsApp → API Setup) so it can be subscribed automatically." });
    } else {
      steps.push(
        await post(`${graph(e)}/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`, e.WHATSAPP_ACCESS_TOKEN, {}, "Subscribe your WhatsApp Business Account", "WhatsApp Business Account subscribed")
      );
    }
  }

  return finish();

  // Meta's answers are kept so a failed setup can be diagnosed later (they never contain tokens).
  async function finish() {
    const ok = steps.every((s) => s.ok || s.manual);
    await prisma.auditLog.create({ data: { actor, action: "integrations.webhooks", target: service, detail: { ok, steps: steps.map((s) => ({ label: s.label, ok: s.ok, manual: s.manual ?? false, message: s.message.slice(0, 300) })) } } });
    return { ok, steps };
  }
}

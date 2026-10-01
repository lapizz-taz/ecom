"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, ExternalLink, Eye, EyeOff, History, Infinity as InfinityIcon,
  KeyRound, ListChecks, LoaderCircle, MessagesSquare, PlugZap, RefreshCw, Route, Send, ShoppingBag, Sparkles, TriangleAlert, Unplug, Webhook, Wand2,
} from "lucide-react";
import { ChannelIcon } from "@/components/ui";
import { timeAgo } from "@/lib/format";

type Key =
  | "OPENAI_API_KEY" | "OPENAI_MODEL"
  | "SHOPIFY_STORE_DOMAIN" | "SHOPIFY_ACCESS_TOKEN" | "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET"
  | "META_APP_ID" | "META_APP_SECRET" | "META_VERIFY_TOKEN" | "META_ACCESS_TOKEN" | "META_PAGE_ID"
  | "INSTAGRAM_ACCESS_TOKEN" | "INSTAGRAM_ACCOUNT_ID" | "INSTAGRAM_APP_SECRET"
  | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ACCESS_TOKEN" | "WHATSAPP_VERIFY_TOKEN" | "WHATSAPP_APP_SECRET" | "WHATSAPP_BUSINESS_ACCOUNT_ID"
  | "ORDER_WEBHOOK_URL" | "ORDER_WEBHOOK_AUTH_HEADER" | "ORDER_WEBHOOK_AUTH_VALUE" | "ORDER_WEBHOOK_SECRET" | "ORDER_DESTINATION";

interface FieldState { source: "dashboard" | "env" | "none"; value: string | null; hint: string | null; unreadable: boolean }
type ServiceId = "openai" | "shopify" | "meta" | "messenger" | "instagram" | "whatsapp" | "orders";
interface Choice { label: string; detail?: string; values: Partial<Record<Key, string>> }
interface CheckResult { ok: boolean; message: string; notes?: string[]; choices?: Choice[] }
interface StoredCheck extends CheckResult { checkedAt: string; checkedBy: string | null }
interface ServiceOverview { configured: boolean; check: StoredCheck | null; lastInbound: string | null; lastChange: { at: string; by: string | null } | null }
interface Forward {
  id: string;
  order: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  responseCode: number | null;
  error: string | null;
  externalId: string | null;
  createdAt: string;
  sentAt: string | null;
}
interface Snapshot {
  fields: Record<Key, FieldState>;
  status: Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "orders" | "notifications", boolean>;
  services: Record<ServiceId, ServiceOverview>;
  webhooks: { meta: string; whatsapp: string; baseUrl: string; public: boolean };
  orders: { destination: "shopify" | "platform" | "both"; sample: unknown; recent: Forward[] };
}
interface SetupResult { ok: boolean; steps: { label: string; ok: boolean; manual?: boolean; message: string }[] }
type Health = "off" | "untested" | "ok" | "problem";

function healthOf(o: ServiceOverview): Health {
  // A failed test is shown as a problem even when keys are still missing — it says exactly what to fix.
  if (o.check && !o.check.ok) return "problem";
  if (!o.configured) return "off";
  if (!o.check) return "untested";
  return "ok";
}

/** Soft format checks while typing — the server still validates what it must. */
const EXPECT: Partial<Record<Key, [RegExp, string]>> = {
  OPENAI_API_KEY: [/^sk-/, "OpenAI keys start with sk-"],
  SHOPIFY_STORE_DOMAIN: [/\.myshopify\.com\/?$/i, "Use the address that ends in .myshopify.com"],
  SHOPIFY_ACCESS_TOKEN: [/^shp(at|ca|pa)_/, "Admin API access tokens start with shpat_"],
  META_APP_ID: [/^\d+$/, "The App ID is only numbers"],
  META_APP_SECRET: [/^[0-9a-f]{32}$/i, "An App secret is 32 letters and numbers — copy it from App settings → Basic"],
  META_ACCESS_TOKEN: [/^EA/, "Page access tokens start with EAA"],
  META_PAGE_ID: [/^\d+$/, "The Page ID is only numbers"],
  INSTAGRAM_ACCESS_TOKEN: [/^(IG|EA)/, "Instagram Login tokens start with IG"],
  INSTAGRAM_ACCOUNT_ID: [/^\d+$/, "The account ID is only numbers"],
  INSTAGRAM_APP_SECRET: [/^[0-9a-f]{32}$/i, "An app secret is 32 letters and numbers"],
  WHATSAPP_PHONE_NUMBER_ID: [/^(?!01\d{9}$|8801\d{9}$)\d+$/, "That looks like a phone number — use the Phone number ID from WhatsApp → API Setup"],
  WHATSAPP_ACCESS_TOKEN: [/^EA/, "WhatsApp access tokens start with EAA"],
  WHATSAPP_BUSINESS_ACCOUNT_ID: [/^\d+$/, "The account ID is only numbers"],
  WHATSAPP_APP_SECRET: [/^[0-9a-f]{32}$/i, "An App secret is 32 letters and numbers"],
  ORDER_WEBHOOK_URL: [/^https:\/\/[^\s/]+\.[^\s]+$/i, "Use the full address, starting with https://"],
  ORDER_WEBHOOK_AUTH_HEADER: [/^[A-Za-z0-9-]+$/, "Only letters, numbers and dashes, like X-API-Key"],
};
interface FieldDef {
  key: Key;
  label: string;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  optional?: boolean;
  /** A choice instead of a text box; `defaultValue` is what applies when nothing is saved. */
  options?: { value: string; label: string }[];
  defaultValue?: string;
}
interface ServiceDef {
  id: ServiceId;
  name: string;
  tagline: string;
  icon: ReactNode;
  iconBg: string;
  fields: FieldDef[];
  note?: string;
  steps: ReactNode[];
  webhook?: "messenger" | "instagram" | "whatsapp";
  /** Not needed by every shop — left out of the "x of y working" count until it's set up. */
  optional?: boolean;
  testLabel?: string;
}

const SERVICES: ServiceDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    tagline: "The AI brain that writes every reply.",
    icon: <Sparkles width={20} height={20} />,
    iconBg: "#0f172a",
    fields: [
      { key: "OPENAI_API_KEY", label: "API key", placeholder: "sk-…", secret: true },
      { key: "OPENAI_MODEL", label: "Model", placeholder: "gpt-4.1-mini", optional: true, hint: "Leave empty to use the default (gpt-4.1-mini)." },
    ],
    steps: [
      <>Sign in at <a className="link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com → API keys <ExternalLink width={12} height={12} /></a>.</>,
      <>Click <b>Create new secret key</b>, name it “Isolation”, and copy it. It starts with <code>sk-</code>.</>,
      <>Make sure billing is set up under <b>Settings → Billing</b>, otherwise replies will fail.</>,
    ],
  },
  {
    id: "shopify",
    name: "Shopify",
    tagline: "Live products, prices, stock and orders.",
    icon: <ShoppingBag width={20} height={20} />,
    iconBg: "#5e8e3e",
    note: "Fill in the store address, then either an Admin API access token or a Client ID + Client secret.",
    fields: [
      { key: "SHOPIFY_STORE_DOMAIN", label: "Store address", placeholder: "your-store.myshopify.com" },
      { key: "SHOPIFY_ACCESS_TOKEN", label: "Admin API access token", placeholder: "shpat_…", secret: true, optional: true },
      { key: "SHOPIFY_CLIENT_ID", label: "Client ID", optional: true, hint: "Only for apps made in the Shopify Dev Dashboard." },
      { key: "SHOPIFY_CLIENT_SECRET", label: "Client secret", secret: true, optional: true },
    ],
    steps: [
      <>Find your store address in Shopify admin → <b>Settings → Domains</b>. Use the one ending in <code>.myshopify.com</code>.</>,
      <>Already have a custom app? Open it and copy the <b>Admin API access token</b> (starts with <code>shpat_</code>).</>,
      <>Otherwise create an app in the <a className="link" href="https://dev.shopify.com" target="_blank" rel="noreferrer">Shopify Dev Dashboard <ExternalLink width={12} height={12} /></a> with the permissions <code>read_products</code> <code>read_inventory</code> <code>read_orders</code> <code>read_customers</code> <code>write_draft_orders</code>, install it on your store, and copy its <b>Client ID</b> and <b>Client secret</b>.</>,
    ],
  },
  {
    id: "meta",
    name: "Meta app",
    tagline: "Shared by Messenger, Instagram and WhatsApp — set this up first.",
    icon: <InfinityIcon width={20} height={20} />,
    iconBg: "#0866ff",
    fields: [
      { key: "META_APP_ID", label: "App ID", placeholder: "1234567890" },
      { key: "META_APP_SECRET", label: "App secret", secret: true },
    ],
    steps: [
      <>Go to <a className="link" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com → My Apps <ExternalLink width={12} height={12} /></a> and create an app of type <b>Business</b>.</>,
      <>Add the <b>Messenger</b> and <b>Instagram</b> products (and <b>WhatsApp</b> if you use it).</>,
      <>Open <b>App settings → Basic</b> and copy the <b>App ID</b> and <b>App secret</b>.</>,
      <>Before real customers can chat, switch the app to <b>Live</b> and pass App Review for <code>pages_messaging</code> and <code>instagram_manage_messages</code>.</>,
    ],
  },
  {
    id: "messenger",
    name: "Facebook Messenger",
    tagline: "Reply to messages sent to your Facebook Page.",
    icon: <ChannelIcon channel="MESSENGER" size={20} />,
    iconBg: "#0866ff",
    fields: [
      { key: "META_ACCESS_TOKEN", label: "Page access token", placeholder: "EAA…", secret: true },
      { key: "META_PAGE_ID", label: "Page ID", optional: true, hint: "Leave empty to use the Page the token belongs to." },
    ],
    steps: [
      <>In <a className="link" href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer">Business Settings → System users <ExternalLink width={12} height={12} /></a>, add a system user with <b>Admin</b> access.</>,
      <>Click <b>Assign assets</b> and give it your Facebook Page (full control) and your app.</>,
      <>Click <b>Generate new token</b> for your app with <code>pages_messaging</code> <code>pages_manage_metadata</code> <code>pages_show_list</code> <code>pages_read_engagement</code> <code>instagram_basic</code> <code>instagram_manage_messages</code> <code>business_management</code>, then paste it here.</>,
    ],
    webhook: "messenger",
  },
  {
    id: "instagram",
    name: "Instagram DMs",
    tagline: "Reply to DMs sent to @isolation.pvt.",
    icon: <ChannelIcon channel="INSTAGRAM" size={20} />,
    iconBg: "#d62976",
    note: "Recommended: Instagram Login — no Facebook Page or “Allow access to messages” setting needed. Fill in the token and the Instagram app secret.",
    fields: [
      { key: "INSTAGRAM_ACCESS_TOKEN", label: "Instagram token", placeholder: "IGAA…", secret: true, optional: true },
      { key: "INSTAGRAM_APP_SECRET", label: "Instagram app secret", secret: true, optional: true, hint: "Instagram messages are signed with this, so it's needed to receive DMs." },
      { key: "INSTAGRAM_ACCOUNT_ID", label: "Instagram account ID", optional: true, hint: "Filled in automatically when you test the connection." },
    ],
    steps: [
      <>Make sure @isolation.pvt is a <b>Professional</b> account (Instagram → Settings → <b>Account type and tools</b> → switch to Business or Creator).</>,
      <>In your Meta app (<a className="link" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com <ExternalLink width={12} height={12} /></a>) open <b>Instagram → API setup with Instagram login</b>. If Instagram isn&apos;t listed, add it with <b>Add product</b>.</>,
      <>Under <b>Generate access tokens</b> click <b>Add account</b>, log in to @isolation.pvt and allow access. Then click <b>Generate token</b> and copy it (starts with <code>IG</code>).</>,
      <>On the same page copy the <b>Instagram app secret</b>. Paste both here and click <b>Save &amp; test</b>.</>,
      <>Finally click <b>Set up webhooks for me</b> below and follow the one step it can&apos;t do for you. The token is renewed automatically every week.</>,
      <span className="muted">Prefer to go through your Facebook Page instead? Leave the token empty — Instagram then uses the Messenger Page token, but you must turn on <b>Allow access to messages</b> in the Instagram app (Settings → Messages and story replies → Message controls → Connected tools).</span>,
    ],
    webhook: "instagram",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    tagline: "Reply on your WhatsApp Business number.",
    icon: <ChannelIcon channel="WHATSAPP" size={20} />,
    iconBg: "#1fa855",
    note: "Only the access token is needed — the Phone number ID and WhatsApp Business Account ID are found from it when you click Save & test.",
    fields: [
      { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", placeholder: "EAA…", secret: true },
      { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", placeholder: "Found automatically", optional: true, hint: "Leave empty — it's filled in from the token. Not your phone number." },
      { key: "WHATSAPP_BUSINESS_ACCOUNT_ID", label: "WhatsApp Business Account ID", placeholder: "Found automatically", optional: true, hint: "Leave empty — it's filled in from the token." },
      { key: "WHATSAPP_APP_SECRET", label: "App secret of a separate WhatsApp app", secret: true, optional: true, hint: "Only if WhatsApp lives in a different Meta app." },
    ],
    steps: [
      <>Add your business number to WhatsApp: open <a className="link" href="https://business.facebook.com/latest/whatsapp_manager/phone_numbers" target="_blank" rel="noreferrer">WhatsApp Manager → Phone numbers <ExternalLink width={12} height={12} /></a> and click <b>Add phone number</b> (skip this if it&apos;s already listed). The number can&apos;t stay logged in to the normal WhatsApp app.</>,
      <>In your Meta app (<a className="link" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com <ExternalLink width={12} height={12} /></a>) make sure WhatsApp is added — in newer apps it&apos;s under <b>Use cases → Add use case → Connect with customers through WhatsApp</b>.</>,
      <>Go to <a className="link" href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer">Business Settings → System users <ExternalLink width={12} height={12} /></a>, pick (or add) a system user, click <b>Assign assets</b> and give it your <b>WhatsApp account</b> (full control) and your <b>app</b>.</>,
      <>Click <b>Generate new token</b>, choose your app, set it to never expire, tick <code>whatsapp_business_messaging</code> <code>whatsapp_business_management</code> <code>business_management</code>, and copy it.</>,
      <>Paste <b>only the token</b> here and click <b>Save &amp; test</b>. Your number and account are found for you — if you have several numbers, you pick one. No “API Setup” page needed.</>,
    ],
    webhook: "whatsapp",
  },
  {
    id: "orders",
    name: "Order platform",
    tagline: "Optional — send every order the assistant takes to another order management system.",
    icon: <Send width={19} height={19} />,
    iconBg: "#6941c6",
    optional: true,
    testLabel: "Send a test order",
    note: "Orders are sent as JSON the moment a customer confirms. If your platform doesn't answer, they're retried automatically and you get an alert.",
    fields: [
      { key: "ORDER_WEBHOOK_URL", label: "Order platform address (API or webhook URL)", placeholder: "https://…", secret: true },
      {
        key: "ORDER_DESTINATION",
        label: "Send confirmed orders to",
        defaultValue: "both",
        options: [
          { value: "both", label: "Shopify and the order platform" },
          { value: "platform", label: "Only the order platform (not Shopify)" },
          { value: "shopify", label: "Only Shopify (pause sending)" },
        ],
        hint: "Products, prices and stock still come from Shopify either way.",
      },
      { key: "ORDER_WEBHOOK_AUTH_HEADER", label: "API key header", placeholder: "Authorization or X-API-Key", optional: true },
      { key: "ORDER_WEBHOOK_AUTH_VALUE", label: "API key", placeholder: "Bearer sk_… or the key itself", secret: true, optional: true },
    ],
    steps: [
      <>Works with any order management system that accepts orders over the internet — through <b>its own API</b>, or a <b>webhook</b> from <a className="link" href="https://zapier.com/apps/webhook/integrations" target="_blank" rel="noreferrer">Zapier <ExternalLink width={12} height={12} /></a>, <a className="link" href="https://www.make.com/en/integrations/gateway" target="_blank" rel="noreferrer">Make <ExternalLink width={12} height={12} /></a> or n8n that adds the order where you need it.</>,
      <>In your platform, copy the address that receives new orders (API endpoint or webhook URL). If it asks for an API key, note the <b>header name</b> it expects (often <code>Authorization</code> or <code>X-API-Key</code>) and the key.</>,
      <>Paste them here, choose where orders should go, and click <b>Save &amp; test</b>. A sample order marked <code>&quot;test&quot;: true</code> is sent so you can map the fields.</>,
      <>Want to be sure requests come from this dashboard? Generate a <b>signing secret</b> below and have your platform check the <code>X-Isolation-Signature</code> header.</>,
    ],
  },
];

async function api<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string; details?: string[] } }> {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function CopyField({ label, value, action }: { label: string; value: string; action?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="copy-field">
        <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} className="mono" />
        <button
          type="button"
          className="btn-sm"
          disabled={!value}
          onClick={async () => {
            await navigator.clipboard.writeText(value).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <CircleCheck width={14} height={14} /> : <Copy width={14} height={14} />} {copied ? "Copied" : "Copy"}
        </button>
        {action}
      </div>
    </div>
  );
}

function SourceTag({ f }: { f: FieldState }) {
  if (f.unreadable) return <span className="pill tone-critical">Re-enter — can&apos;t be read</span>;
  if (f.source === "dashboard") return <span className="pill tone-good">Saved</span>;
  if (f.source === "env") return <span className="pill tone-accent" title="Set in Vercel → Settings → Environment Variables">From Vercel</span>;
  return null;
}


const HEALTH_PILL: Record<Health, { tone: string; label: string; icon: ReactNode }> = {
  off: { tone: "", label: "Not connected", icon: <Unplug aria-hidden /> },
  untested: { tone: "tone-warning", label: "Not tested", icon: <CircleDashed aria-hidden /> },
  ok: { tone: "tone-good", label: "Working", icon: <CircleCheck aria-hidden /> },
  problem: { tone: "tone-critical", label: "Problem", icon: <CircleAlert aria-hidden /> },
};

function CheckPanel({ check }: { check: StoredCheck }) {
  return (
    <div className="svc-result stack-sm">
      <div className={`alert ${check.ok ? "alert-good" : "alert-critical"}`} role="status">
        {check.ok ? <CircleCheck width={18} height={18} /> : <CircleX width={18} height={18} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="alert-title">{check.message}</div>
          <div className="alert-body tiny" style={{ marginTop: 2 }}>
            Checked {timeAgo(check.checkedAt)}
            {check.checkedBy ? ` · ${check.checkedBy === "maintenance" ? "automatic daily check" : check.checkedBy === "order delivery" ? "from a real order" : `by ${check.checkedBy}`}` : ""}
          </div>
        </div>
      </div>
      {check.notes && check.notes.length > 0 && (
        <div className="alert alert-warning">
          <TriangleAlert width={18} height={18} />
          <div className="stack-sm" style={{ gap: 6 }}>
            {check.notes.map((n) => <div key={n} className="alert-body small">{n}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceCard({ def, snap, onSnapshot, refresh }: { def: ServiceDef; snap: Snapshot; onSnapshot: (s: Snapshot) => void; refresh: () => Promise<Snapshot | null> }) {
  const ov = snap.services[def.id];
  const health = healthOf(ov);
  const initial = () => Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : snap.fields[f.key].value ?? f.defaultValue ?? ""])) as Record<Key, string>;
  const [draft, setDraft] = useState<Record<Key, string>>(initial);
  const [show, setShow] = useState<Partial<Record<Key, boolean>>>({});
  const [busy, setBusy] = useState<null | "save" | "test" | "disconnect" | "webhooks" | "token">(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupResult | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const warnings = health === "ok" ? ov.check?.notes?.length ?? 0 : 0;
  const [open, setOpen] = useState(health !== "ok" || warnings > 0);

  // Links like /admin/integrations#shopify (from the "Next step" box or other pages) open the card.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === `#${def.id}`) setOpen(true);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [def.id]);

  const changes: Partial<Record<Key, string | null>> = {};
  for (const f of def.fields) {
    const v = draft[f.key].trim();
    if (f.secret) {
      if (v) changes[f.key] = v;
    } else if (v !== (snap.fields[f.key].value ?? f.defaultValue ?? "")) {
      changes[f.key] = v || null;
    }
  }
  const dirty = Object.keys(changes).length > 0;
  const savedHere = def.fields.some((f) => snap.fields[f.key].source === "dashboard");
  const tokenKey: Key = def.webhook === "whatsapp" ? "WHATSAPP_VERIFY_TOKEN" : "META_VERIFY_TOKEN";
  const resetDraft = (s: Snapshot) => setDraft(Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : s.fields[f.key].value ?? f.defaultValue ?? ""])) as Record<Key, string>);

  async function test() {
    setBusy("test");
    setError(null);
    const r = await api<CheckResult>("POST", "/api/admin/integrations/actions", { action: "test", service: def.id });
    if (!r.ok) setError(r.data.error ?? "Test failed");
    setChoices(r.ok && r.data.choices?.length ? r.data.choices : null);
    const fresh = await refresh();
    // A test can fill in IDs by itself (e.g. the WhatsApp number) — show them without discarding other typing.
    if (fresh) {
      setDraft((d) => {
        const next = { ...d };
        for (const f of def.fields) if (!f.secret && fresh.fields[f.key].value !== snap.fields[f.key].value) next[f.key] = fresh.fields[f.key].value ?? f.defaultValue ?? "";
        return next;
      });
    }
    setBusy(null);
  }

  async function choose(c: Choice) {
    setBusy("save");
    setError(null);
    const r = await api<Snapshot>("PUT", "/api/admin/integrations", { values: c.values });
    if (!r.ok) {
      setBusy(null);
      return setError(r.data.details?.join("; ") ?? r.data.error ?? "Couldn't save");
    }
    setChoices(null);
    onSnapshot(r.data);
    resetDraft(r.data);
    await test();
  }

  async function save() {
    setBusy("save");
    setError(null);
    const r = await api<Snapshot>("PUT", "/api/admin/integrations", { values: changes });
    if (!r.ok) {
      setBusy(null);
      return setError(r.data.details?.join("; ") ?? r.data.error ?? "Couldn't save");
    }
    onSnapshot(r.data);
    resetDraft(r.data);
    await test();
  }

  async function disconnect() {
    if (!confirm(`Remove the ${def.name} keys saved on this dashboard?`)) return;
    setBusy("disconnect");
    const values = Object.fromEntries(def.fields.filter((f) => snap.fields[f.key].source === "dashboard").map((f) => [f.key, null]));
    const r = await api<Snapshot>("PUT", "/api/admin/integrations", { values });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? "Couldn't remove");
    onSnapshot(r.data);
    resetDraft(r.data);
  }

  async function generateToken() {
    setBusy("token");
    await api("POST", "/api/admin/integrations/actions", { action: "generate-token", token: tokenKey });
    await refresh();
    setBusy(null);
  }

  async function autoWebhooks() {
    setBusy("webhooks");
    setSetup(null);
    const r = await api<SetupResult>("POST", "/api/admin/integrations/actions", { action: "webhooks", service: def.webhook });
    setSetup(r.ok ? r.data : { ok: false, steps: [{ label: "Setup", ok: false, message: r.data.error ?? "Failed" }] });
    await refresh();
    setBusy(null);
  }

  const verifyToken = snap.fields[tokenKey].value ?? "";
  const callbackUrl = def.webhook === "whatsapp" ? snap.webhooks.whatsapp : snap.webhooks.meta;
  const pill = HEALTH_PILL[health];
  const subline =
    health === "ok"
      ? `Working · checked ${timeAgo(ov.check!.checkedAt)}${warnings ? ` · ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""}`
      : health === "problem"
        ? ov.check!.message
        : health === "untested"
          ? "Keys saved — run a test to confirm it works."
          : def.tagline;

  return (
    <section className={`card svc-card health-${health}`} id={def.id}>
      <button type="button" className="svc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="svc-icon" style={{ background: def.iconBg }}>{def.icon}</span>
        <span className="svc-title">
          <span className="svc-name">{def.name}</span>
          <span className={`svc-tagline${health === "problem" ? " error" : warnings ? " warn" : ""}`}>{subline}</span>
        </span>
        <span className={`pill lg ${pill.tone}`}>{pill.icon} {pill.label}</span>
        <ChevronRight width={18} height={18} className="svc-chev" aria-hidden />
      </button>

      {open && (
        <>
          {ov.check && <CheckPanel check={ov.check} />}
          {choices && (
            <div className="svc-result">
              <div className="choice-list" role="group" aria-label="Choose one">
                {choices.map((c) => (
                  <div key={JSON.stringify(c.values)} className="choice">
                    <div style={{ minWidth: 0 }}>
                      <div className="strong">{c.label}</div>
                      {c.detail && <div className="small muted">{c.detail}</div>}
                    </div>
                    <button type="button" className="btn-primary btn-sm" onClick={() => choose(c)} disabled={busy !== null}>
                      <CircleCheck width={14} height={14} /> Use this one
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="svc-body">
            <div className="svc-steps">
              <div className="section-title">How to get these</div>
              <ol className="steps">
                {def.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
            <div className="svc-form">
              {def.note && <p className="small muted" style={{ marginBottom: 14 }}>{def.note}</p>}
              {def.fields.map((f) => {
                const st = snap.fields[f.key];
                const placeholder =
                  f.secret && st.hint && !st.unreadable
                    ? `${st.source === "env" ? "Set in Vercel" : "Saved"} · ${f.key === "ORDER_WEBHOOK_URL" ? st.hint : `ends in ${st.hint}`}`
                    : f.placeholder;
                const typed = draft[f.key].trim();
                const expect = EXPECT[f.key];
                const looksWrong = typed && expect && !expect[0].test(typed) ? expect[1] : null;
                return (
                  <div className="field" key={f.key}>
                    <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, gap: 6 }}>
                      <label htmlFor={`${def.id}-${f.key}`} style={{ margin: 0 }}>
                        {f.label} {f.optional && <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>}
                      </label>
                      <SourceTag f={st} />
                    </div>
                    {f.options ? (
                      <select id={`${def.id}-${f.key}`} value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                        {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <div className={f.secret ? "pw-wrap" : undefined}>
                        <input
                          id={`${def.id}-${f.key}`}
                          type={f.secret && !show[f.key] ? "password" : "text"}
                          autoComplete="off"
                          spellCheck={false}
                          value={draft[f.key]}
                          placeholder={placeholder}
                          aria-invalid={looksWrong ? true : undefined}
                          className={looksWrong ? "warn" : undefined}
                          onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                        />
                        {f.secret && (
                          <button type="button" onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))} aria-label={show[f.key] ? "Hide" : "Show"}>
                            {show[f.key] ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
                          </button>
                        )}
                      </div>
                    )}
                    {looksWrong ? (
                      <p className="hint warn-text"><TriangleAlert width={13} height={13} aria-hidden /> {looksWrong}</p>
                    ) : f.secret && st.hint && !st.unreadable ? (
                      <p className="hint">Leave empty to keep the saved key. Paste a new one to replace it.</p>
                    ) : f.hint ? (
                      <p className="hint">{f.hint}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {def.webhook && (
            <div className="svc-webhook">
              <div className="row" style={{ marginBottom: 12 }}>
                <Webhook width={16} height={16} className="muted" aria-hidden />
                <h3>Webhook — so messages reach the assistant</h3>
              </div>
              <div className={`inbound ${ov.lastInbound ? "seen" : ""}`}>
                <MessagesSquare width={16} height={16} aria-hidden />
                {ov.lastInbound ? (
                  <span>
                    Last customer message arrived <b>{timeAgo(ov.lastInbound)}</b> — messages are reaching the assistant.
                  </span>
                ) : (
                  <span>No customer messages received yet. After setting up the webhook, send a message from another account to check it arrives in the Inbox.</span>
                )}
              </div>
              {!snap.webhooks.public && (
                <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                  <TriangleAlert width={17} height={17} aria-hidden />
                  <div className="alert-body small">This dashboard isn&apos;t on a public https address ({snap.webhooks.baseUrl}). Open it from your live site to set up webhooks.</div>
                </div>
              )}
              <div className="form-grid">
                <CopyField label="Callback URL" value={callbackUrl} />
                <CopyField
                  label="Verify token"
                  value={verifyToken}
                  action={
                    !verifyToken ? (
                      <button type="button" className="btn-sm" onClick={generateToken} disabled={busy !== null}>
                        {busy === "token" ? <LoaderCircle width={14} height={14} className="spin" /> : <KeyRound width={14} height={14} />} Generate
                      </button>
                    ) : undefined
                  }
                />
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn-primary btn-sm" onClick={autoWebhooks} disabled={busy !== null || !snap.webhooks.public}>
                  {busy === "webhooks" ? <LoaderCircle width={14} height={14} className="spin" /> : <Wand2 width={14} height={14} />} Set up webhooks for me
                </button>
                <span className="small muted">Registers the address above with your Meta app and subscribes your {def.webhook === "whatsapp" ? "WhatsApp account" : def.webhook === "instagram" ? "Instagram account" : "Page"}.</span>
              </div>
              {setup && (
                <ul className="setup-steps">
                  {setup.steps.map((s, i) => (
                    <li key={i} className={s.ok ? "ok" : s.manual ? "todo" : "bad"}>
                      {s.ok ? <CircleCheck width={16} height={16} /> : s.manual ? <ListChecks width={16} height={16} /> : <CircleX width={16} height={16} />}
                      <div>
                        <div className="strong small">{s.label}</div>
                        <div className="small text-2">{s.message}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <details className="trace" style={{ marginTop: 10 }}>
                <summary><ChevronRight width={14} height={14} /> Prefer to do it by hand?</summary>
                <div className="trace-body small">
                  {def.webhook === "whatsapp" ? (
                    <>In your Meta app open <b>WhatsApp → Configuration</b> (newer apps: <b>Use cases → WhatsApp → Customize → Configuration</b>), paste the Callback URL and Verify token, click <b>Verify and save</b>, then subscribe to the <code>messages</code> field.</>
                  ) : (
                    <>In your Meta app open <b>{def.webhook === "instagram" ? "Instagram → Webhooks" : "Messenger → Settings → Webhooks"}</b>, paste the Callback URL and Verify token, click <b>Verify and save</b>, then subscribe to {def.webhook === "instagram" ? <><code>messages</code> and <code>messaging_postbacks</code></> : <><code>messages</code>, <code>messaging_postbacks</code> and <code>message_echoes</code></>}.</>
                  )}
                </div>
              </details>
              {def.webhook === "whatsapp" && <WhatsAppRegister onDone={test} />}
            </div>
          )}

          {def.id === "orders" && <OrderPlatformExtras snap={snap} refresh={refresh} />}

          <div className="card-footer">
            <button className="btn-primary" onClick={save} disabled={!dirty || busy !== null}>
              {busy === "save" ? <LoaderCircle width={15} height={15} className="spin" /> : <PlugZap width={15} height={15} />} Save & test
            </button>
            <button onClick={test} disabled={busy !== null}>
              {busy === "test" ? <LoaderCircle width={15} height={15} className="spin" /> : <RefreshCw width={15} height={15} />} {def.testLabel ?? "Test connection"}
            </button>
            {savedHere && (
              <button className="btn-ghost btn-danger" onClick={disconnect} disabled={busy !== null}>
                <Unplug width={15} height={15} /> Remove saved keys
              </button>
            )}
            {error && <span className="feedback err" role="alert">{error}</span>}
            <span className="spacer" />
            {ov.lastChange && (
              <span className="tiny muted row" style={{ gap: 4 }}>
                <History width={13} height={13} aria-hidden /> Changed {timeAgo(ov.lastChange.at)}{ov.lastChange.by ? ` by ${ov.lastChange.by}` : ""}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Numbers added in WhatsApp Manager must be registered for the Cloud API (with a 6-digit PIN) before they work. */
function WhatsAppRegister({ onDone }: { onDone: () => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function register() {
    setBusy(true);
    setResult(null);
    const r = await api<{ ok: boolean; message: string }>("POST", "/api/admin/integrations/actions", { action: "whatsapp-register", pin });
    setResult(r.ok ? r.data : { ok: false, message: r.data.details?.join("; ") ?? r.data.error ?? "Couldn't register" });
    setBusy(false);
    if (r.ok && r.data.ok) {
      setPin("");
      await onDone();
    }
  }

  return (
    <details className="trace" style={{ marginTop: 4 }}>
      <summary><ChevronRight width={14} height={14} /> Register your number (if the test says it isn&apos;t registered)</summary>
      <div className="trace-body small">
        <p style={{ margin: 0 }}>
          Numbers added in WhatsApp Manager have to be registered once before the assistant can use them. Choose a 6-digit PIN — it becomes the number&apos;s two-step verification PIN. If the
          number already has one, enter that PIN.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            inputMode="numeric"
            autoComplete="off"
            placeholder="6-digit PIN"
            aria-label="6-digit PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            style={{ width: 150 }}
          />
          <button type="button" className="btn-sm" onClick={register} disabled={busy || pin.length !== 6}>
            {busy ? <LoaderCircle width={14} height={14} className="spin" /> : <KeyRound width={14} height={14} />} Register number
          </button>
        </div>
        {result && <p className={`feedback ${result.ok ? "ok" : "err"}`} role="status" style={{ margin: 0 }}>{result.message}</p>}
      </div>
    </details>
  );
}

const DESTINATION_TEXT: Record<Snapshot["orders"]["destination"], string> = {
  both: "Confirmed orders are placed in Shopify and sent to your order platform.",
  platform: "Confirmed orders are sent only to your order platform — not to Shopify.",
  shopify: "Orders only go to Shopify right now — nothing is sent to an order platform.",
};

const FORWARD_PILL: Record<Forward["status"], { tone: string; label: string }> = {
  sent: { tone: "tone-good", label: "Delivered" },
  pending: { tone: "tone-warning", label: "Retrying" },
  failed: { tone: "tone-critical", label: "Not delivered" },
};

function OrderPlatformExtras({ snap, refresh }: { snap: Snapshot; refresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const secret = snap.fields.ORDER_WEBHOOK_SECRET.value ?? "";
  const { destination, recent, sample } = snap.orders;

  async function generate() {
    setBusy("secret");
    await api("POST", "/api/admin/integrations/actions", { action: "generate-token", token: "ORDER_WEBHOOK_SECRET" });
    await refresh();
    setBusy(null);
  }

  async function resend(id: string) {
    setBusy(id);
    setMessage(null);
    const r = await api<{ ok: boolean; error: string | null }>("POST", "/api/admin/orders/forward", { forwardId: id });
    setMessage(r.ok ? (r.data.ok ? { ok: true, text: "Delivered." } : { ok: false, text: r.data.error ?? "Still not delivered." }) : { ok: false, text: r.data.error ?? "Couldn't resend" });
    await refresh();
    setBusy(null);
  }

  return (
    <div className="svc-webhook">
      <div className="row" style={{ marginBottom: 12 }}>
        <Route width={16} height={16} className="muted" aria-hidden />
        <h3>Where orders go</h3>
      </div>
      <div className={`inbound ${destination !== "shopify" ? "seen" : ""}`}>
        <Send width={16} height={16} aria-hidden />
        <span>{DESTINATION_TEXT[destination]}</span>
      </div>
      <div className="form-grid">
        <CopyField
          label="Signing secret (optional)"
          value={secret}
          action={
            !secret ? (
              <button type="button" className="btn-sm" onClick={generate} disabled={busy !== null}>
                {busy === "secret" ? <LoaderCircle width={14} height={14} className="spin" /> : <KeyRound width={14} height={14} />} Generate
              </button>
            ) : undefined
          }
        />
        <div className="field">
          <label>Checking a request</label>
          <p className="small text-2" style={{ margin: 0 }}>
            <code>X-Isolation-Signature</code> is <code>sha256=</code> plus the HMAC-SHA256 of the raw body with this secret. <code>Idempotency-Key</code> stays the same when an order is retried, so it&apos;s never added twice.
          </p>
        </div>
      </div>
      <details className="trace" style={{ marginTop: 12 }}>
        <summary><ChevronRight width={14} height={14} /> Example of an order your platform receives</summary>
        <div className="trace-body">
          <pre style={{ margin: 0, maxHeight: 360, overflow: "auto" }}>{JSON.stringify(sample, null, 2)}</pre>
        </div>
      </details>

      <div className="section-title" style={{ marginTop: 18 }}>Latest orders sent</div>
      {recent.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>Nothing sent yet — orders appear here as customers confirm them.</p>
      ) : (
        <div className="forward-list">
          {recent.map((f) => (
            <div key={f.id} className="forward">
              <span className="strong nowrap">{f.order}</span>
              <span className={`pill ${FORWARD_PILL[f.status].tone}`}>{FORWARD_PILL[f.status].label}</span>
              <span className="small text-2 forward-detail">
                {f.status === "sent"
                  ? `${f.externalId ? `Platform order ${f.externalId} · ` : ""}${timeAgo(f.sentAt ?? f.createdAt)}`
                  : `${f.error ?? "Waiting to be sent"}${f.attempts ? ` · ${f.attempts} ${f.attempts === 1 ? "try" : "tries"}` : ""}`}
              </span>
              {f.status !== "sent" && (
                <button type="button" className="btn-sm" onClick={() => resend(f.id)} disabled={busy !== null}>
                  {busy === f.id ? <LoaderCircle width={14} height={14} className="spin" /> : <RefreshCw width={14} height={14} />} Resend
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {message && <p className={`feedback ${message.ok ? "ok" : "err"}`} role="status" style={{ marginTop: 8 }}>{message.text}</p>}
    </div>
  );
}

const NEXT_STEP: Record<Exclude<Health, "ok">, (name: string) => string> = {
  problem: (n) => `Fix ${n}`,
  off: (n) => `Connect ${n}`,
  untested: (n) => `Test ${n}`,
};

export function IntegrationsManager() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [allResult, setAllResult] = useState<string | null>(null);

  async function refresh(): Promise<Snapshot | null> {
    const r = await api<Snapshot>("GET", "/api/admin/integrations");
    if (r.ok) setSnap(r.data);
    else setError(r.data.error ?? "Couldn't load integrations");
    return r.ok ? r.data : null;
  }
  useEffect(() => {
    refresh();
  }, []);

  if (error) return <div className="alert alert-critical"><CircleX width={18} height={18} /><div className="alert-title">{error}</div></div>;
  if (!snap) return <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 88 }} />)}</div>;

  // Optional services only count once they're set up.
  const healths = SERVICES.map((s) => ({ def: s, health: healthOf(snap.services[s.id]) })).filter((h) => !h.def.optional || h.health !== "off");
  const total = healths.length;
  const working = healths.filter((h) => h.health === "ok").length;
  const problems = healths.filter((h) => h.health === "problem").length;
  const configured = healths.filter((h) => h.health !== "off").length;
  // Problems first, then the first service not yet connected, then anything untested.
  const next = healths.find((h) => h.health === "problem") ?? healths.find((h) => h.health === "off") ?? healths.find((h) => h.health === "untested");
  const warned = next ? undefined : healths.find((h) => h.health === "ok" && snap.services[h.def.id].check?.notes?.length);
  const unreadable = (Object.entries(snap.fields) as [Key, FieldState][]).filter(([, f]) => f.unreadable).map(([k]) => k);

  async function testAll() {
    setTestingAll(true);
    setAllResult(null);
    const r = await api<{ checked: string[]; failed: string[]; skipped: string[] }>("POST", "/api/admin/integrations/actions", { action: "test-all" });
    await refresh();
    setTestingAll(false);
    if (!r.ok) return setAllResult(r.data.error ?? "Couldn't run the tests");
    const { checked, failed, skipped } = r.data;
    setAllResult(
      checked.length === 0
        ? "Nothing to test yet — connect a service first."
        : `Tested ${checked.length} ${checked.length === 1 ? "connection" : "connections"}: ${failed.length ? `${failed.length} with a problem` : "all working"}${skipped.length ? ` (${skipped.length} didn't answer in time)` : ""}.`
    );
  }

  return (
    <div className="stack">
      <div className="card card-body">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="strong" style={{ fontSize: 15 }}>
              {working === total ? "Everything is connected and working" : `${working} of ${total} working`}
              {problems > 0 && <span className="error"> · {problems} {problems === 1 ? "problem" : "problems"}</span>}
            </div>
            <div className="small muted">Connections are re-checked automatically every day; you&apos;ll get an alert if one stops working.</div>
          </div>
          <div className="row">
            {allResult && <span className="small text-2">{allResult}</span>}
            <button className="btn-sm" onClick={testAll} disabled={testingAll || configured === 0}>
              {testingAll ? <LoaderCircle width={14} height={14} className="spin" /> : <ListChecks width={14} height={14} />} Test all
            </button>
          </div>
        </div>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={working} aria-label="Integrations working">
          <div className="meter-fill" style={{ width: `${(working / total) * 100}%` }} />
        </div>
        <div className="row" style={{ gap: 6, marginTop: 12 }}>
          {healths.map(({ def, health }) => (
            <a key={def.id} href={`#${def.id}`} className={`pill ${HEALTH_PILL[health].tone}`} title={HEALTH_PILL[health].label}>
              {HEALTH_PILL[health].icon} {def.name}
            </a>
          ))}
        </div>
        {warned && (
          <a href={`#${warned.def.id}`} className="next-step warning">
            <span className="next-label">Heads up</span>
            <span className="strong">Review {warned.def.name}</span>
            <span className="small truncate" style={{ minWidth: 0 }}>— {snap.services[warned.def.id].check?.notes?.[0]}</span>
            <ArrowRight width={16} height={16} style={{ marginLeft: "auto" }} aria-hidden />
          </a>
        )}
        {next && (
          <a href={`#${next.def.id}`} className={`next-step ${next.health}`}>
            <span className="next-label">Next step</span>
            <span className="strong">{NEXT_STEP[next.health as Exclude<Health, "ok">](next.def.name)}</span>
            {next.health === "problem" && <span className="small truncate" style={{ minWidth: 0 }}>— {snap.services[next.def.id].check?.message}</span>}
            <ArrowRight width={16} height={16} style={{ marginLeft: "auto" }} aria-hidden />
          </a>
        )}
      </div>

      {unreadable.length > 0 && (
        <div className="alert alert-warning">
          <TriangleAlert width={18} height={18} />
          <div>
            <div className="alert-title">Some saved keys can&apos;t be read</div>
            <div className="alert-body small">NEXTAUTH_SECRET was changed since they were saved, so these need to be pasted again: {unreadable.join(", ")}.</div>
          </div>
        </div>
      )}

      {SERVICES.map((def) => <ServiceCard key={def.id} def={def} snap={snap} onSnapshot={setSnap} refresh={refresh} />)}

      <p className="small muted row" style={{ gap: 6 }}>
        <KeyRound width={15} height={15} aria-hidden />
        Keys are encrypted before they&apos;re stored and are never shown again — only their last 4 characters. A key saved here replaces the same setting in Vercel.
      </p>
    </div>
  );
}

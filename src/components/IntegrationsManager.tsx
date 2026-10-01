"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, ExternalLink, Eye, EyeOff, History, Infinity as InfinityIcon,
  KeyRound, ListChecks, LoaderCircle, MessagesSquare, PlugZap, RefreshCw, ShoppingBag, Sparkles, TriangleAlert, Unplug, Webhook, Wand2,
} from "lucide-react";
import { ChannelIcon } from "@/components/ui";
import { timeAgo } from "@/lib/format";

type Key =
  | "OPENAI_API_KEY" | "OPENAI_MODEL"
  | "SHOPIFY_STORE_DOMAIN" | "SHOPIFY_ACCESS_TOKEN" | "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET"
  | "META_APP_ID" | "META_APP_SECRET" | "META_VERIFY_TOKEN" | "META_ACCESS_TOKEN" | "META_PAGE_ID"
  | "INSTAGRAM_ACCESS_TOKEN" | "INSTAGRAM_ACCOUNT_ID" | "INSTAGRAM_APP_SECRET"
  | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ACCESS_TOKEN" | "WHATSAPP_VERIFY_TOKEN" | "WHATSAPP_APP_SECRET" | "WHATSAPP_BUSINESS_ACCOUNT_ID";

interface FieldState { source: "dashboard" | "env" | "none"; value: string | null; hint: string | null; unreadable: boolean }
type ServiceId = "openai" | "shopify" | "meta" | "messenger" | "instagram" | "whatsapp";
interface CheckResult { ok: boolean; message: string; notes?: string[] }
interface StoredCheck extends CheckResult { checkedAt: string; checkedBy: string | null }
interface ServiceOverview { configured: boolean; check: StoredCheck | null; lastInbound: string | null; lastChange: { at: string; by: string | null } | null }
interface Snapshot {
  fields: Record<Key, FieldState>;
  status: Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "notifications", boolean>;
  services: Record<ServiceId, ServiceOverview>;
  webhooks: { meta: string; whatsapp: string; baseUrl: string; public: boolean };
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
};
interface FieldDef { key: Key; label: string; placeholder?: string; hint?: string; secret?: boolean; optional?: boolean }
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
    fields: [
      { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", placeholder: "1234567890" },
      { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", placeholder: "EAA…", secret: true },
      { key: "WHATSAPP_BUSINESS_ACCOUNT_ID", label: "WhatsApp Business Account ID", optional: true, hint: "Needed for automatic webhook setup." },
      { key: "WHATSAPP_APP_SECRET", label: "App secret of a separate WhatsApp app", secret: true, optional: true, hint: "Only if WhatsApp lives in a different Meta app." },
    ],
    steps: [
      <>In your Meta app add <b>WhatsApp</b>, connect your WhatsApp Business Account and register your business number. It can&apos;t be in use in the normal WhatsApp app.</>,
      <>Open <b>WhatsApp → API Setup</b> and copy the <b>Phone number ID</b> and <b>WhatsApp Business Account ID</b>.</>,
      <>In Business Settings → System users, assign the WhatsApp account and app, then generate a token with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.</>,
    ],
    webhook: "whatsapp",
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
            {check.checkedBy ? ` · ${check.checkedBy === "maintenance" ? "automatic daily check" : `by ${check.checkedBy}`}` : ""}
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

function ServiceCard({ def, snap, onSnapshot, refresh }: { def: ServiceDef; snap: Snapshot; onSnapshot: (s: Snapshot) => void; refresh: () => Promise<void> }) {
  const ov = snap.services[def.id];
  const health = healthOf(ov);
  const initial = () => Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : snap.fields[f.key].value ?? ""])) as Record<Key, string>;
  const [draft, setDraft] = useState<Record<Key, string>>(initial);
  const [show, setShow] = useState<Partial<Record<Key, boolean>>>({});
  const [busy, setBusy] = useState<null | "save" | "test" | "disconnect" | "webhooks" | "token">(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupResult | null>(null);
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
    } else if (v !== (snap.fields[f.key].value ?? "")) {
      changes[f.key] = v || null;
    }
  }
  const dirty = Object.keys(changes).length > 0;
  const savedHere = def.fields.some((f) => snap.fields[f.key].source === "dashboard");
  const tokenKey: Key = def.webhook === "whatsapp" ? "WHATSAPP_VERIFY_TOKEN" : "META_VERIFY_TOKEN";
  const resetDraft = (s: Snapshot) => setDraft(Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : s.fields[f.key].value ?? ""])) as Record<Key, string>);

  async function test() {
    setBusy("test");
    setError(null);
    const r = await api<CheckResult>("POST", "/api/admin/integrations/actions", { action: "test", service: def.id });
    if (!r.ok) setError(r.data.error ?? "Test failed");
    await refresh();
    setBusy(null);
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
                const placeholder = f.secret && st.hint && !st.unreadable ? `${st.source === "env" ? "Set in Vercel" : "Saved"} · ends in ${st.hint}` : f.placeholder;
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
                    <>In your Meta app open <b>WhatsApp → Configuration → Webhook</b>, paste the Callback URL and Verify token, click <b>Verify and save</b>, then subscribe to the <code>messages</code> field.</>
                  ) : (
                    <>In your Meta app open <b>{def.webhook === "instagram" ? "Instagram → Webhooks" : "Messenger → Settings → Webhooks"}</b>, paste the Callback URL and Verify token, click <b>Verify and save</b>, then subscribe to {def.webhook === "instagram" ? <><code>messages</code> and <code>messaging_postbacks</code></> : <><code>messages</code>, <code>messaging_postbacks</code> and <code>message_echoes</code></>}.</>
                  )}
                </div>
              </details>
            </div>
          )}

          <div className="card-footer">
            <button className="btn-primary" onClick={save} disabled={!dirty || busy !== null}>
              {busy === "save" ? <LoaderCircle width={15} height={15} className="spin" /> : <PlugZap width={15} height={15} />} Save & test
            </button>
            <button onClick={test} disabled={busy !== null}>
              {busy === "test" ? <LoaderCircle width={15} height={15} className="spin" /> : <RefreshCw width={15} height={15} />} Test connection
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

  async function refresh() {
    const r = await api<Snapshot>("GET", "/api/admin/integrations");
    if (r.ok) setSnap(r.data);
    else setError(r.data.error ?? "Couldn't load integrations");
  }
  useEffect(() => {
    refresh();
  }, []);

  if (error) return <div className="alert alert-critical"><CircleX width={18} height={18} /><div className="alert-title">{error}</div></div>;
  if (!snap) return <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 88 }} />)}</div>;

  const healths = SERVICES.map((s) => ({ def: s, health: healthOf(snap.services[s.id]) }));
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
              {working === SERVICES.length ? "Everything is connected and working" : `${working} of ${SERVICES.length} working`}
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
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={SERVICES.length} aria-valuenow={working} aria-label="Integrations working">
          <div className="meter-fill" style={{ width: `${(working / SERVICES.length) * 100}%` }} />
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

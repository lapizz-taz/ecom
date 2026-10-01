"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight, CircleCheck, CircleX, Copy, ExternalLink, Eye, EyeOff, Infinity as InfinityIcon, KeyRound, LoaderCircle, PlugZap,
  RefreshCw, ShoppingBag, Sparkles, TriangleAlert, Unplug, Webhook, Wand2,
} from "lucide-react";
import { ChannelIcon } from "@/components/ui";

type Key =
  | "OPENAI_API_KEY" | "OPENAI_MODEL"
  | "SHOPIFY_STORE_DOMAIN" | "SHOPIFY_ACCESS_TOKEN" | "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET"
  | "META_APP_ID" | "META_APP_SECRET" | "META_VERIFY_TOKEN" | "META_ACCESS_TOKEN" | "META_PAGE_ID"
  | "INSTAGRAM_ACCESS_TOKEN" | "INSTAGRAM_ACCOUNT_ID"
  | "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ACCESS_TOKEN" | "WHATSAPP_VERIFY_TOKEN" | "WHATSAPP_APP_SECRET" | "WHATSAPP_BUSINESS_ACCOUNT_ID";

interface FieldState { source: "dashboard" | "env" | "none"; value: string | null; hint: string | null; unreadable: boolean }
interface Snapshot {
  fields: Record<Key, FieldState>;
  status: Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "notifications", boolean>;
  webhooks: { meta: string; whatsapp: string; baseUrl: string; public: boolean };
}
interface CheckResult { ok: boolean; message: string; notes?: string[] }
interface SetupResult { ok: boolean; steps: { label: string; ok: boolean; message: string }[] }

type ServiceId = "openai" | "shopify" | "meta" | "messenger" | "instagram" | "whatsapp";
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
  ready: (s: Snapshot) => boolean;
}

const has = (s: Snapshot, k: Key) => s.fields[k].source !== "none";

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
    ready: (s) => s.status.openai,
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
    ready: (s) => s.status.shopify,
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
    ready: (s) => has(s, "META_APP_ID") && has(s, "META_APP_SECRET"),
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
    ready: (s) => s.status.meta,
  },
  {
    id: "instagram",
    name: "Instagram DMs",
    tagline: "Reply to DMs sent to @isolation.pvt.",
    icon: <ChannelIcon channel="INSTAGRAM" size={20} />,
    iconBg: "#d62976",
    note: "Instagram uses the Page token from the Messenger card — usually there's nothing to fill in here.",
    fields: [
      { key: "INSTAGRAM_ACCESS_TOKEN", label: "Instagram Login token", placeholder: "IG…", secret: true, optional: true, hint: "Only if you use “Instagram API with Instagram Login”." },
      { key: "INSTAGRAM_ACCOUNT_ID", label: "Instagram account ID", optional: true },
    ],
    steps: [
      <>Make sure @isolation.pvt is a <b>Professional</b> (Business or Creator) account linked to your Facebook Page.</>,
      <>In the Instagram app: <b>Settings → Messages and story replies → Message controls → Connected tools</b> → turn on <b>Allow access to messages</b>.</>,
      <>Connect Messenger, then click <b>Test connection</b> here — it shows which Instagram account is linked.</>,
    ],
    webhook: "instagram",
    ready: (s) => s.status.instagram,
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
    ready: (s) => s.status.whatsapp,
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

function ServiceCard({ def, snap, onSnapshot }: { def: ServiceDef; snap: Snapshot; onSnapshot: (s: Snapshot) => void }) {
  const initial = () => Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : snap.fields[f.key].value ?? ""])) as Record<Key, string>;
  const [draft, setDraft] = useState<Record<Key, string>>(initial);
  const [show, setShow] = useState<Partial<Record<Key, boolean>>>({});
  const [busy, setBusy] = useState<null | "save" | "test" | "disconnect" | "webhooks" | "token">(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [setup, setSetup] = useState<SetupResult | null>(null);
  const [open, setOpen] = useState(!def.ready(snap));

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
  const ready = def.ready(snap);
  const tokenKey: Key = def.webhook === "whatsapp" ? "WHATSAPP_VERIFY_TOKEN" : "META_VERIFY_TOKEN";

  async function test() {
    setBusy("test");
    setCheck(null);
    const r = await api<CheckResult>("POST", "/api/admin/integrations/actions", { action: "test", service: def.id });
    setBusy(null);
    setCheck(r.ok ? r.data : { ok: false, message: r.data.error ?? "Test failed" });
  }

  async function save() {
    setBusy("save");
    setError(null);
    setCheck(null);
    const r = await api<Snapshot>("PUT", "/api/admin/integrations", { values: changes });
    if (!r.ok) {
      setBusy(null);
      return setError(r.data.details?.join("; ") ?? r.data.error ?? "Couldn't save");
    }
    onSnapshot(r.data);
    setDraft(Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : r.data.fields[f.key].value ?? ""])) as Record<Key, string>);
    await test();
  }

  async function disconnect() {
    if (!confirm(`Remove the ${def.name} keys saved on this dashboard?`)) return;
    setBusy("disconnect");
    setCheck(null);
    const values = Object.fromEntries(def.fields.filter((f) => snap.fields[f.key].source === "dashboard").map((f) => [f.key, null]));
    const r = await api<Snapshot>("PUT", "/api/admin/integrations", { values });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? "Couldn't remove");
    onSnapshot(r.data);
    setDraft(Object.fromEntries(def.fields.map((f) => [f.key, f.secret ? "" : r.data.fields[f.key].value ?? ""])) as Record<Key, string>);
  }

  async function generateToken() {
    setBusy("token");
    await api("POST", "/api/admin/integrations/actions", { action: "generate-token", token: tokenKey });
    const r = await api<Snapshot>("GET", "/api/admin/integrations");
    setBusy(null);
    if (r.ok) onSnapshot(r.data);
  }

  async function autoWebhooks() {
    setBusy("webhooks");
    setSetup(null);
    const r = await api<SetupResult>("POST", "/api/admin/integrations/actions", { action: "webhooks", service: def.webhook });
    setBusy(null);
    setSetup(r.ok ? r.data : { ok: false, steps: [{ label: "Setup", ok: false, message: r.data.error ?? "Failed" }] });
    const s = await api<Snapshot>("GET", "/api/admin/integrations");
    if (s.ok) onSnapshot(s.data);
  }

  const verifyToken = snap.fields[tokenKey].value ?? "";
  const callbackUrl = def.webhook === "whatsapp" ? snap.webhooks.whatsapp : snap.webhooks.meta;

  return (
    <section className={`card svc-card${ready ? " is-ready" : ""}`} id={def.id}>
      <button type="button" className="svc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="svc-icon" style={{ background: def.iconBg }}>{def.icon}</span>
        <span className="svc-title">
          <span className="svc-name">{def.name}</span>
          <span className="svc-tagline">{def.tagline}</span>
        </span>
        {ready ? (
          <span className="pill tone-good lg"><CircleCheck aria-hidden /> Set up</span>
        ) : (
          <span className="pill lg"><Unplug aria-hidden /> Not connected</span>
        )}
        <ChevronRight width={18} height={18} className="svc-chev" aria-hidden />
      </button>

      {open && (
        <>
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
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      />
                      {f.secret && (
                        <button type="button" onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))} aria-label={show[f.key] ? "Hide" : "Show"}>
                          {show[f.key] ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
                        </button>
                      )}
                    </div>
                    {f.secret && st.hint && !st.unreadable ? (
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
                    <li key={i} className={s.ok ? "ok" : "bad"}>
                      {s.ok ? <CircleCheck width={16} height={16} /> : <CircleX width={16} height={16} />}
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
          </div>
          {check && (
            <div className={`alert ${check.ok ? "alert-good" : "alert-critical"} svc-result`} role="status">
              {check.ok ? <CircleCheck width={18} height={18} /> : <CircleX width={18} height={18} />}
              <div>
                <div className="alert-title">{check.message}</div>
                {check.notes?.map((n) => <div key={n} className="alert-body small" style={{ marginTop: 4 }}>{n}</div>)}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function IntegrationsManager() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Snapshot>("GET", "/api/admin/integrations").then((r) => (r.ok ? setSnap(r.data) : setError(r.data.error ?? "Couldn't load integrations")));
  }, []);

  if (error) return <div className="alert alert-critical"><CircleX width={18} height={18} /><div className="alert-title">{error}</div></div>;
  if (!snap) return <div className="stack">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 88 }} />)}</div>;

  const done = SERVICES.filter((s) => s.ready(snap)).length;
  const unreadable = (Object.entries(snap.fields) as [Key, FieldState][]).filter(([, f]) => f.unreadable).map(([k]) => k);

  return (
    <div className="stack">
      <div className="card card-body">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div className="strong" style={{ fontSize: 15 }}>{done === SERVICES.length ? "Everything is connected" : `${done} of ${SERVICES.length} set up`}</div>
            <div className="small muted">Work top to bottom — OpenAI and Shopify first, then the Meta app, then each chat channel.</div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {SERVICES.map((s) => (
              <a key={s.id} href={`#${s.id}`} className={`pill ${s.ready(snap) ? "tone-good" : ""}`} title={s.name}>
                {s.ready(snap) ? <CircleCheck aria-hidden /> : <Unplug aria-hidden />} {s.name}
              </a>
            ))}
          </div>
        </div>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={SERVICES.length} aria-valuenow={done} aria-label="Integrations set up">
          <div className="meter-fill" style={{ width: `${(done / SERVICES.length) * 100}%` }} />
        </div>
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

      {SERVICES.map((def) => <ServiceCard key={def.id} def={def} snap={snap} onSnapshot={setSnap} />)}

      <p className="small muted row" style={{ gap: 6 }}>
        <KeyRound width={15} height={15} aria-hidden />
        Keys are encrypted before they're stored and are never shown again — only their last 4 characters. A key saved here replaces the same setting in Vercel.
      </p>
    </div>
  );
}

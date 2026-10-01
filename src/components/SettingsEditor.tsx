"use client";
import { useEffect, useState } from "react";
import { Bot, Building2, CreditCard, Headset, LoaderCircle, Save, Truck, type LucideIcon } from "lucide-react";
import { CardHeader } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Settings = any;

function Section({ icon, title, description, children, onSave, msg }: { icon: LucideIcon; title: string; description: string; children: React.ReactNode; onSave: () => Promise<void>; msg?: string }) {
  const [busy, setBusy] = useState(false);
  const ok = msg?.startsWith("✅");
  return (
    <section className="card" id={title.toLowerCase()}>
      <CardHeader icon={icon} title={title} description={description} />
      <div className="card-body">{children}</div>
      <div className="card-footer">
        <button
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSave();
            setBusy(false);
          }}
        >
          {busy ? <LoaderCircle width={15} height={15} className="spin" aria-hidden /> : <Save width={15} height={15} aria-hidden />}
          Save {title.toLowerCase()}
        </button>
        {msg && <span className={`feedback ${ok ? "ok" : "err"}`} role="status">{msg.replace(/^(✅|❌)\s*/, "")}</span>}
      </div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span className="switch-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

const nullIfEmpty = (s: string) => (s.trim() ? s : null);

export function SettingsEditor() {
  const [s, setS] = useState<Settings | null>(null);
  const [msgs, setMsgs] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/admin/settings").then(async (r) => setS(await r.json()));
  }, []);
  if (!s)
    return (
      <div className="stack" aria-busy>
        {[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 180 }} />)}
      </div>
    );

  async function save(key: string) {
    const res = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value: s[key] }) });
    const j = await res.json().catch(() => ({}));
    setMsgs((m) => ({ ...m, [key]: res.ok ? "✅ Saved" : `❌ ${j.details?.join("; ") ?? j.error ?? "Failed"}` }));
  }
  const set = (key: string, patch: object) => setS((prev: Settings) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const setZone = (i: number, patch: object) => set("delivery", { zones: s.delivery.zones.map((z: any, j: number) => (i === j ? { ...z, ...patch } : z)) });
  const setMethod = (i: number, patch: object) => set("payment", { methods: s.payment.methods.map((m: any, j: number) => (i === j ? { ...m, ...patch } : m)) });
  const setHandoff = (patch: object) => set("ai", { handoff: { ...s.ai.handoff, ...patch } });

  return (
    <div className="stack">
      <Section icon={Truck} title="Delivery" description="Charges are used by the AI and in order totals. Leave “estimated time” empty unless confirmed — the AI will then say the team will confirm." onSave={() => save("delivery")} msg={msgs.delivery}>
        <div className="table-wrap" style={{ margin: "-4px -20px 0" }}>
          <table>
            <thead><tr><th>Zone</th><th>Label</th><th style={{ width: 120 }}>Fee (৳)</th><th>Estimated time</th><th>Areas (comma separated, optional)</th></tr></thead>
            <tbody>
              {s.delivery.zones.map((z: any, i: number) => (
                <tr key={z.id}>
                  <td><code>{z.id}</code></td>
                  <td style={{ minWidth: 160 }}><input aria-label={`${z.id} label`} value={z.label} onChange={(e) => setZone(i, { label: e.target.value })} /></td>
                  <td><input aria-label={`${z.id} fee`} type="number" min={0} value={z.fee} onChange={(e) => setZone(i, { fee: Number(e.target.value) })} /></td>
                  <td style={{ minWidth: 150 }}><input aria-label={`${z.id} estimated time`} value={z.estimatedTime ?? ""} placeholder="Not confirmed" onChange={(e) => setZone(i, { estimatedTime: nullIfEmpty(e.target.value) })} /></td>
                  <td style={{ minWidth: 220 }}><input aria-label={`${z.id} areas`} value={z.areas.join(", ")} onChange={(e) => setZone(i, { areas: e.target.value.split(",").map((a: string) => a.trim().toLowerCase()).filter(Boolean) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="field" style={{ marginTop: 18 }}>
          <label htmlFor="delivery-notes">Delivery notes</label>
          <textarea id="delivery-notes" value={s.delivery.notes ?? ""} onChange={(e) => set("delivery", { notes: nullIfEmpty(e.target.value) })} />
        </div>
      </Section>

      <Section icon={CreditCard} title="Payment" description="Only enabled methods are offered. Instructions are shown to customers word for word — never ask for an OTP, PIN or password." onSave={() => save("payment")} msg={msgs.payment}>
        <div className="stack" style={{ gap: 12 }}>
          {s.payment.methods.map((m: any, i: number) => (
            <div key={m.id} className="card" style={{ padding: 14, background: "var(--surface-2)", boxShadow: "none" }}>
              <div className="row" style={{ marginBottom: m.enabled ? 10 : 0 }}>
                <Toggle checked={m.enabled} onChange={(v) => setMethod(i, { enabled: v })} label={m.label} />
                <span className="spacer" />
                <code>{m.id}</code>
              </div>
              {m.enabled && (
                <input aria-label={`${m.label} instructions`} value={m.instructions ?? ""} placeholder="Instructions shown to customers" onChange={(e) => setMethod(i, { instructions: nullIfEmpty(e.target.value) })} />
              )}
            </div>
          ))}
          <div className="field">
            <label htmlFor="payment-notes">Payment notes</label>
            <textarea id="payment-notes" value={s.payment.notes ?? ""} onChange={(e) => set("payment", { notes: nullIfEmpty(e.target.value) })} />
          </div>
        </div>
      </Section>

      <Section icon={Bot} title="AI" description="How the assistant behaves, what it may do, and when it hands a chat to your team." onSave={() => save("ai")} msg={msgs.ai}>
        <div className="switch-list">
          <Toggle checked={s.ai.enabled} onChange={(v) => set("ai", { enabled: v })} label="AI enabled" hint="When off, the AI stops replying and every new message goes to your team." />
          <Toggle checked={s.ai.autoReply} onChange={(v) => set("ai", { autoReply: v })} label="Auto-reply to customers" hint="When off, every new message is handed to your team instead of answered." />
          <Toggle checked={s.ai.allowOrderCreation} onChange={(v) => set("ai", { allowOrderCreation: v })} label="AI may create orders" hint="When off, the AI collects the details and hands the order to your team." />
        </div>
        <div className="form-grid" style={{ marginTop: 20 }}>
          <div className="field">
            <label htmlFor="ai-mode">Order creation mode</label>
            <select id="ai-mode" value={s.ai.orderCreationMode} onChange={(e) => set("ai", { orderCreationMode: e.target.value })}>
              <option value="complete">Create real Shopify order (payment pending / COD)</option>
              <option value="draft">Create Shopify draft only — staff completes it</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ai-lang">Language</label>
            <select id="ai-lang" value={s.ai.languageMode} onChange={(e) => set("ai", { languageMode: e.target.value })}>
              <option value="auto">Auto — match the customer (English / Bangla / Banglish)</option>
              <option value="banglish">Always Banglish</option>
              <option value="bn">Always Bangla</option>
              <option value="en">Always English</option>
            </select>
          </div>
          <div className="field span-2">
            <label htmlFor="ai-tone">Tone</label>
            <textarea id="ai-tone" value={s.ai.tone} onChange={(e) => set("ai", { tone: e.target.value })} />
          </div>
          <div className="field span-2">
            <label htmlFor="ai-brand">Brand instructions</label>
            <textarea id="ai-brand" value={s.ai.brandInstructions} onChange={(e) => set("ai", { brandInstructions: e.target.value })} />
            <p className="hint">Extra rules for the AI, e.g. phrases to use or avoid.</p>
          </div>
          <div className="field"><label htmlFor="ai-max">Max reply length (characters)</label><input id="ai-max" type="number" value={s.ai.maxReplyChars} onChange={(e) => set("ai", { maxReplyChars: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="ai-qty">Max quantity per item</label><input id="ai-qty" type="number" value={s.ai.maxQuantityPerItem} onChange={(e) => set("ai", { maxQuantityPerItem: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="ai-hist">History messages sent to AI</label><input id="ai-hist" type="number" value={s.ai.historyMessages} onChange={(e) => set("ai", { historyMessages: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="ai-deb">Burst debounce (ms)</label><input id="ai-deb" type="number" value={s.ai.debounceMs} onChange={(e) => set("ai", { debounceMs: Number(e.target.value) })} /><p className="hint">Waits this long to merge quick consecutive messages into one reply.</p></div>
        </div>

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
          <h3 className="row" style={{ gap: 8, marginBottom: 4 }}><Headset width={16} height={16} className="muted" aria-hidden /> Human handoff</h3>
          <p className="small muted" style={{ marginBottom: 14 }}>Explicit “talk to a human” requests always hand off.</p>
          <div className="switch-list">
            {[
              ["pauseAiOnHandoff", "Pause AI while a human is required"],
              ["onAnger", "Hand off angry customers"],
              ["onRefundRequest", "Hand off refund requests"],
              ["onDiscountRequest", "Hand off special discount requests"],
              ["onCancelRequest", "Hand off cancellation requests"],
              ["onPaymentProblem", "Hand off payment problems"],
            ].map(([k, l]) => (
              <Toggle key={k} checked={s.ai.handoff[k]} onChange={(v) => setHandoff({ [k]: v })} label={l} />
            ))}
          </div>
          <div className="form-grid" style={{ marginTop: 20 }}>
            <div className="field"><label htmlFor="ho-threshold">Dissatisfied messages before handoff</label><input id="ho-threshold" type="number" min={1} value={s.ai.handoff.dissatisfactionThreshold} onChange={(e) => setHandoff({ dissatisfactionThreshold: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="ho-email">Notify email</label><input id="ho-email" type="email" value={s.ai.handoff.notifyEmail ?? ""} onChange={(e) => setHandoff({ notifyEmail: nullIfEmpty(e.target.value) })} placeholder="team@isolationpvt.shop" /></div>
            <div className="field span-2"><label htmlFor="ho-webhook">Notify webhook</label><input id="ho-webhook" value={s.ai.handoff.notifyWebhookUrl ?? ""} onChange={(e) => setHandoff({ notifyWebhookUrl: nullIfEmpty(e.target.value) })} placeholder="https://hooks.slack.com/…" /><p className="hint">Slack or Discord incoming webhook URL.</p></div>
          </div>
        </div>
      </Section>

      <Section icon={Building2} title="Business" description="Contact details and facts the AI shares with customers." onSave={() => save("business")} msg={msgs.business}>
        <div className="form-grid">
          {[
            ["brandName", "Brand name"],
            ["website", "Website"],
            ["instagram", "Instagram"],
            ["facebook", "Facebook"],
            ["whatsapp", "WhatsApp"],
            ["currency", "Currency (ISO)"],
            ["currencySymbol", "Currency symbol"],
            ["supportContact", "Support contact"],
            ["businessHours", "Business hours"],
          ].map(([k, l]) => (
            <div key={k} className="field">
              <label htmlFor={`biz-${k}`}>{l}</label>
              <input id={`biz-${k}`} value={s.business[k] ?? ""} onChange={(e) => set("business", { [k]: ["brandName", "website", "currency", "currencySymbol"].includes(k) ? e.target.value : nullIfEmpty(e.target.value) })} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18 }}>
          <Toggle checked={s.business.onlineOnly} onChange={(v) => set("business", { onlineOnly: v })} label="Online only" hint="No physical outlet — the AI tells customers you sell online." />
        </div>
      </Section>
    </div>
  );
}

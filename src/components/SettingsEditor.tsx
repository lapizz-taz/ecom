"use client";
import { useEffect, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Settings = any;

function Section({ title, children, onSave, msg }: { title: string; children: React.ReactNode; onSave: () => void; msg?: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={onSave}>Save {title.toLowerCase()}</button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

const nullIfEmpty = (s: string) => (s.trim() ? s : null);

export function SettingsEditor() {
  const [s, setS] = useState<Settings | null>(null);
  const [msgs, setMsgs] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/admin/settings").then(async (r) => setS(await r.json()));
  }, []);
  if (!s) return <p className="muted">Loading…</p>;

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
    <>
      <Section title="Delivery" onSave={() => save("delivery")} msg={msgs.delivery}>
        <p className="small muted">Charges are used by the AI and in order totals. Leave “estimated time” empty unless confirmed — the AI will then say the team will confirm.</p>
        <table>
          <thead><tr><th>Zone</th><th>Label</th><th>Fee (৳)</th><th>Estimated time</th><th>Areas (comma separated, optional)</th></tr></thead>
          <tbody>
            {s.delivery.zones.map((z: any, i: number) => (
              <tr key={z.id}>
                <td><code>{z.id}</code></td>
                <td><input value={z.label} onChange={(e) => setZone(i, { label: e.target.value })} /></td>
                <td style={{ width: 100 }}><input type="number" min={0} value={z.fee} onChange={(e) => setZone(i, { fee: Number(e.target.value) })} /></td>
                <td><input value={z.estimatedTime ?? ""} placeholder="not confirmed" onChange={(e) => setZone(i, { estimatedTime: nullIfEmpty(e.target.value) })} /></td>
                <td><input value={z.areas.join(", ")} onChange={(e) => setZone(i, { areas: e.target.value.split(",").map((a: string) => a.trim().toLowerCase()).filter(Boolean) })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>Delivery notes</label>
        <textarea value={s.delivery.notes ?? ""} onChange={(e) => set("delivery", { notes: nullIfEmpty(e.target.value) })} />
      </Section>

      <Section title="Payment" onSave={() => save("payment")} msg={msgs.payment}>
        <p className="small muted">Only enabled methods are offered. Instructions are shown to customers verbatim — never include requests for OTP/PIN/passwords.</p>
        {s.payment.methods.map((m: any, i: number) => (
          <div key={m.id} style={{ marginBottom: 12 }}>
            <div className="row">
              <label className="row" style={{ margin: 0 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={m.enabled} onChange={(e) => setMethod(i, { enabled: e.target.checked })} /> <strong>{m.label}</strong> <code className="small">{m.id}</code>
              </label>
            </div>
            <input value={m.instructions ?? ""} placeholder="Instructions shown to customers" onChange={(e) => setMethod(i, { instructions: nullIfEmpty(e.target.value) })} />
          </div>
        ))}
        <label>Payment notes</label>
        <textarea value={s.payment.notes ?? ""} onChange={(e) => set("payment", { notes: nullIfEmpty(e.target.value) })} />
      </Section>

      <Section title="AI" onSave={() => save("ai")} msg={msgs.ai}>
        <div className="row">
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={s.ai.enabled} onChange={(e) => set("ai", { enabled: e.target.checked })} /> AI enabled</label>
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={s.ai.autoReply} onChange={(e) => set("ai", { autoReply: e.target.checked })} /> Auto-reply to customers</label>
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={s.ai.allowOrderCreation} onChange={(e) => set("ai", { allowOrderCreation: e.target.checked })} /> AI may create orders</label>
        </div>
        <label>Order creation mode</label>
        <select value={s.ai.orderCreationMode} onChange={(e) => set("ai", { orderCreationMode: e.target.value })}>
          <option value="complete">Create real Shopify order (payment pending / COD)</option>
          <option value="draft">Create Shopify draft only — staff completes it</option>
        </select>
        <label>Language behaviour</label>
        <select value={s.ai.languageMode} onChange={(e) => set("ai", { languageMode: e.target.value })}>
          <option value="auto">Auto — match the customer (English / Bangla / Banglish)</option>
          <option value="banglish">Always Banglish</option>
          <option value="bn">Always Bangla</option>
          <option value="en">Always English</option>
        </select>
        <label>Tone</label>
        <textarea value={s.ai.tone} onChange={(e) => set("ai", { tone: e.target.value })} />
        <label>Brand instructions (extra rules for the AI)</label>
        <textarea value={s.ai.brandInstructions} onChange={(e) => set("ai", { brandInstructions: e.target.value })} />
        <div className="grid grid-2">
          <div><label>Max reply length (chars)</label><input type="number" value={s.ai.maxReplyChars} onChange={(e) => set("ai", { maxReplyChars: Number(e.target.value) })} /></div>
          <div><label>Max quantity per item</label><input type="number" value={s.ai.maxQuantityPerItem} onChange={(e) => set("ai", { maxQuantityPerItem: Number(e.target.value) })} /></div>
          <div><label>History messages sent to AI</label><input type="number" value={s.ai.historyMessages} onChange={(e) => set("ai", { historyMessages: Number(e.target.value) })} /></div>
          <div><label>Burst debounce (ms)</label><input type="number" value={s.ai.debounceMs} onChange={(e) => set("ai", { debounceMs: Number(e.target.value) })} /></div>
        </div>
        <h3 style={{ marginTop: 16 }}>Human handoff</h3>
        <p className="small muted">Explicit “talk to a human” requests always hand off.</p>
        {[
          ["pauseAiOnHandoff", "Pause AI while a human is required"],
          ["onAnger", "Hand off angry customers"],
          ["onRefundRequest", "Hand off refund requests"],
          ["onDiscountRequest", "Hand off special discount requests"],
          ["onCancelRequest", "Hand off cancellation requests"],
          ["onPaymentProblem", "Hand off payment problems"],
        ].map(([k, l]) => (
          <label key={k} className="row" style={{ margin: "4px 0" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={s.ai.handoff[k]} onChange={(e) => setHandoff({ [k]: e.target.checked })} /> {l}
          </label>
        ))}
        <div className="grid grid-2">
          <div><label>Dissatisfied messages before handoff</label><input type="number" min={1} value={s.ai.handoff.dissatisfactionThreshold} onChange={(e) => setHandoff({ dissatisfactionThreshold: Number(e.target.value) })} /></div>
          <div><label>Notify email</label><input value={s.ai.handoff.notifyEmail ?? ""} onChange={(e) => setHandoff({ notifyEmail: nullIfEmpty(e.target.value) })} /></div>
        </div>
        <label>Notify webhook (Slack / Discord incoming webhook URL)</label>
        <input value={s.ai.handoff.notifyWebhookUrl ?? ""} onChange={(e) => setHandoff({ notifyWebhookUrl: nullIfEmpty(e.target.value) })} />
      </Section>

      <Section title="Business" onSave={() => save("business")} msg={msgs.business}>
        <div className="grid grid-2">
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
            <div key={k}>
              <label>{l}</label>
              <input value={s.business[k] ?? ""} onChange={(e) => set("business", { [k]: ["brandName", "website", "currency", "currencySymbol"].includes(k) ? e.target.value : nullIfEmpty(e.target.value) })} />
            </div>
          ))}
        </div>
        <label className="row" style={{ marginTop: 10 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={s.business.onlineOnly} onChange={(e) => set("business", { onlineOnly: e.target.checked })} /> Online only (no physical outlet)
        </label>
      </Section>
    </>
  );
}

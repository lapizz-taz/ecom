"use client";
import { useEffect, useState } from "react";

interface Entry { id: string; category: string; key: string; title: string; content: string; active: boolean; updatedAt: string; updatedBy: string | null }
const CATEGORIES = ["POLICY", "FAQ", "PROMOTION", "BRAND", "INSTRUCTION"];
const HELP: Record<string, string> = {
  POLICY: "Official policies. Leave content EMPTY if not confirmed — the AI will then hand off instead of answering.",
  FAQ: "Question = title, answer = content. The AI only repeats these facts.",
  PROMOTION: "Active promotions only. Deactivate or delete when a promotion ends. Empty = no discounts offered.",
  BRAND: "Brand facts the AI may state.",
  INSTRUCTION: "Extra behaviour instructions for the AI (tone, do/don't).",
};

export function KnowledgeEditor() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cat, setCat] = useState("POLICY");
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState({ key: "", title: "", content: "" });

  async function load() {
    const res = await fetch("/api/admin/knowledge");
    const j = await res.json();
    setEntries(j.entries ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function save(e: Entry) {
    const res = await fetch("/api/admin/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.id, title: e.title, content: e.content, active: e.active }),
    });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Saved “${e.title}”` : j.error ?? "Failed");
    load();
  }

  async function remove(e: Entry) {
    if (!confirm(`Delete “${e.title}”?`)) return;
    await fetch(`/api/admin/knowledge?id=${e.id}`, { method: "DELETE" });
    load();
  }

  async function create() {
    const prefix = { POLICY: "policy.", FAQ: "faq.", PROMOTION: "promo.", BRAND: "brand.", INSTRUCTION: "instruction." }[cat] ?? "";
    const key = draft.key.startsWith(prefix) ? draft.key : prefix + draft.key;
    const res = await fetch("/api/admin/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: cat, key, title: draft.title, content: draft.content, active: true }),
    });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Created" : j.details?.join(", ") ?? j.error ?? "Failed");
    if (res.ok) setDraft({ key: "", title: "", content: "" });
    load();
  }

  const update = (id: string, patch: Partial<Entry>) => setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const shown = entries.filter((e) => e.category === cat);

  return (
    <>
      <div className="filters">
        {CATEGORIES.map((c) => (
          <a key={c} href="#" className={c === cat ? "on" : ""} onClick={(e) => { e.preventDefault(); setCat(c); }}>{c.toLowerCase()}</a>
        ))}
      </div>
      <p className="small muted">{HELP[cat]}</p>
      {cat === "POLICY" && <p className="small muted">Policy keys the AI looks up: policy.return, policy.exchange, policy.refund, policy.cancellation, policy.warranty, policy.delivery, policy.payment.</p>}
      {msg && <p className="small">{msg}</p>}
      {shown.map((e) => (
        <div className="card" key={e.id}>
          <div className="row">
            <code className="small">{e.key}</code>
            {!e.content.trim() && <span className="badge bad">not confirmed — AI will hand off</span>}
            <span className="spacer" />
            <label className="row small" style={{ margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={e.active} onChange={(ev) => update(e.id, { active: ev.target.checked })} /> active
            </label>
          </div>
          <label>Title</label>
          <input value={e.title} onChange={(ev) => update(e.id, { title: ev.target.value })} />
          <label>Content</label>
          <textarea value={e.content} onChange={(ev) => update(e.id, { content: ev.target.value })} rows={4} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => save(e)}>Save</button>
            <button className="danger" onClick={() => remove(e)}>Delete</button>
            <span className="small muted">Updated {new Date(e.updatedAt).toLocaleString()} {e.updatedBy ? `by ${e.updatedBy}` : ""}</span>
          </div>
        </div>
      ))}
      <div className="card">
        <h3>Add {cat.toLowerCase()} entry</h3>
        <label>Key (lowercase, e.g. {cat === "FAQ" ? "faq.sizing" : cat === "PROMOTION" ? "promo.eid-2026" : "policy.return"})</label>
        <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
        <label>Title</label>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <label>Content</label>
        <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        <div style={{ marginTop: 8 }}>
          <button className="primary" disabled={!draft.key || !draft.title} onClick={create}>Add</button>
        </div>
      </div>
    </>
  );
}

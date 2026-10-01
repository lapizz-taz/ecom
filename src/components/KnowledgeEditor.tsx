"use client";
import { useEffect, useState } from "react";
import { BookOpen, Info, LoaderCircle, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { CardHeader, EmptyState } from "@/components/ui";

interface Entry { id: string; category: string; key: string; title: string; content: string; active: boolean; updatedAt: string; updatedBy: string | null }
const CATEGORIES = ["POLICY", "FAQ", "PROMOTION", "BRAND", "INSTRUCTION"];
const CATEGORY_LABEL: Record<string, string> = { POLICY: "Policies", FAQ: "FAQs", PROMOTION: "Promotions", BRAND: "Brand", INSTRUCTION: "Instructions" };
const HELP: Record<string, string> = {
  POLICY: "Official policies. Leave content EMPTY if not confirmed — the AI will then hand off instead of answering.",
  FAQ: "Question = title, answer = content. The AI only repeats these facts.",
  PROMOTION: "Active promotions only. Deactivate or delete when a promotion ends. Empty = no discounts offered.",
  BRAND: "Brand facts the AI may state.",
  INSTRUCTION: "Extra behaviour instructions for the AI (tone, do/don't).",
};

export function KnowledgeEditor() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cat, setCat] = useState("POLICY");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState({ key: "", title: "", content: "" });
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/admin/knowledge");
    const j = await res.json();
    setEntries(j.entries ?? []);
    setLoaded(true);
  }
  useEffect(() => {
    load();
  }, []);

  async function save(e: Entry) {
    setSavingId(e.id);
    const res = await fetch("/api/admin/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.id, title: e.title, content: e.content, active: e.active }),
    });
    setSavingId(null);
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? { ok: true, text: `Saved “${e.title}”` } : { ok: false, text: j.error ?? "Failed" });
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
    setMsg(res.ok ? { ok: true, text: "Created" } : { ok: false, text: j.details?.join(", ") ?? j.error ?? "Failed" });
    if (res.ok) setDraft({ key: "", title: "", content: "" });
    load();
  }

  const update = (id: string, patch: Partial<Entry>) => setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const shown = entries.filter((e) => e.category === cat);
  const label = CATEGORY_LABEL[cat].toLowerCase();

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="segmented" role="tablist" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c} role="tab" aria-selected={c === cat} className={c === cat ? "on" : ""} onClick={() => { setCat(c); setMsg(null); }}>
              {CATEGORY_LABEL[c]} <span className="count">{entries.filter((e) => e.category === c).length}</span>
            </button>
          ))}
        </div>
        {msg && <span className={`feedback ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</span>}
      </div>

      <div className="alert alert-info">
        <Info width={18} height={18} aria-hidden />
        <div className="alert-body">
          {HELP[cat]}
          {cat === "POLICY" && (
            <div className="small" style={{ marginTop: 6 }}>
              Policy keys the AI looks up: <code>policy.return</code> <code>policy.exchange</code> <code>policy.refund</code> <code>policy.cancellation</code> <code>policy.warranty</code> <code>policy.delivery</code> <code>policy.payment</code>
            </div>
          )}
        </div>
      </div>

      {loaded && shown.length === 0 && (
        <div className="card"><EmptyState icon={BookOpen} title={`No ${label} yet`}>Add the first one below.</EmptyState></div>
      )}

      {shown.map((e) => (
        <div className={`card entry-card${e.active ? "" : " inactive"}`} key={e.id}>
          <div className="card-header">
            <div className="row" style={{ flex: 1, minWidth: 0 }}>
              <span className="entry-key">{e.key}</span>
              {!e.content.trim() && (
                <span className="pill tone-warning"><TriangleAlert aria-hidden /> Not confirmed — AI will hand off</span>
              )}
            </div>
            <label className="switch" style={{ alignItems: "center" }}>
              <input type="checkbox" checked={e.active} onChange={(ev) => update(e.id, { active: ev.target.checked })} />
              <span className="track" />
              <span className="small">{e.active ? "Active" : "Inactive"}</span>
            </label>
          </div>
          <div className="card-body">
            <div className="field">
              <label htmlFor={`t-${e.id}`}>Title</label>
              <input id={`t-${e.id}`} value={e.title} onChange={(ev) => update(e.id, { title: ev.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`c-${e.id}`}>Content</label>
              <textarea id={`c-${e.id}`} value={e.content} onChange={(ev) => update(e.id, { content: ev.target.value })} rows={4} placeholder="Leave empty if not confirmed — the AI will hand off." />
            </div>
          </div>
          <div className="card-footer">
            <button className="btn-primary btn-sm" onClick={() => save(e)} disabled={savingId === e.id}>
              {savingId === e.id ? <LoaderCircle width={14} height={14} className="spin" aria-hidden /> : <Save width={14} height={14} aria-hidden />} Save
            </button>
            <button className="btn-danger btn-sm" onClick={() => remove(e)}>
              <Trash2 width={14} height={14} aria-hidden /> Delete
            </button>
            <span className="spacer" />
            <span className="tiny muted">Updated {new Date(e.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}{e.updatedBy ? ` by ${e.updatedBy}` : ""}</span>
          </div>
        </div>
      ))}

      <div className="card">
        <CardHeader icon={Plus} title={`Add to ${label}`} />
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="new-key">Key</label>
              <input id="new-key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder={cat === "FAQ" ? "faq.sizing" : cat === "PROMOTION" ? "promo.eid-2026" : "policy.return"} />
              <p className="hint">Lowercase. The category prefix is added for you.</p>
            </div>
            <div className="field">
              <label htmlFor="new-title">Title</label>
              <input id="new-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="field span-2">
              <label htmlFor="new-content">Content</label>
              <textarea id="new-content" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            </div>
          </div>
        </div>
        <div className="card-footer">
          <button className="btn-primary" disabled={!draft.key || !draft.title} onClick={create}>
            <Plus width={15} height={15} aria-hidden /> Add entry
          </button>
        </div>
      </div>
    </div>
  );
}

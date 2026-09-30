"use client";
import { useEffect, useRef, useState } from "react";

interface ToolCall { name: string; input: unknown; output: unknown; ok: boolean; durationMs: number }
interface Turn {
  customer: string;
  stored?: string;
  reply: string | null;
  skipped: string | null;
  lang?: string;
  guard: string | null;
  signals?: Record<string, boolean>;
  toolCalls: ToolCall[];
  validation?: { ok: boolean; issues: string[] };
  handoff: { reason: string; detail?: string } | null;
  status?: string;
  modelReply: string | null;
  llmError: string | null;
  error?: string;
}

const SAMPLES = [
  "belt ta koto?",
  "How much is the Korean belt?",
  "black available?",
  "What size is it?",
  "Show me the belt.",
  "Do you have something similar?",
  "Dhakar delivery charge koto?",
  "Delivery outside Dhaka?",
  "How long does delivery take?",
  "I want to order.",
  "Can I order COD?",
  "Rahim Uddin, 01712345678, House 12 Road 5 Mirpur 10, Dhaka. COD",
  "confirm",
  "Where is my order?",
  "Order #1001, phone 01711111111",
  "Order #1001, phone 01799999999",
  "My order hasn't arrived",
  "I want to cancel",
  "I want a refund.",
  "I want an exchange.",
  "Give me a discount",
  "human den.",
  "vai ekta baggy jeans er sathe belt suggest koren",
  "আপনাদের দোকান কোথায়?",
  "my OTP is 482913",
  "Do you sell perfume?",
];

function newSessionId() {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "");
}

export function TestChat() {
  const [sessionId, setSessionId] = useState<string>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState("mock:normal");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("AI_ACTIVE");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSessionId(newSessionId()), []);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [turns]);

  async function send(message: string) {
    if (!message.trim() || !sessionId) return;
    setBusy(true);
    setText("");
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, shopifyMode: mode, simulatedPhone: phone || undefined }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setTurns((t) => [...t, { customer: message, reply: null, skipped: null, guard: null, toolCalls: [], handoff: null, modelReply: null, llmError: null, error: j.error ?? `HTTP ${res.status}` }]);
      return;
    }
    setConversationId(j.conversationId);
    setStatus(j.conversationStatus);
    setTurns((t) => [
      ...t,
      {
        customer: message,
        stored: j.storedCustomerMessage,
        reply: j.reply,
        skipped: j.skipped,
        lang: j.lang,
        guard: j.guard,
        signals: j.signals,
        toolCalls: j.toolCalls,
        validation: j.validation,
        handoff: j.handoff,
        status: j.conversationStatus,
        modelReply: j.modelReply,
        llmError: j.llmError,
      },
    ]);
  }

  async function reset() {
    if (sessionId) await fetch(`/api/chat?sessionId=${sessionId}`, { method: "DELETE" });
    setSessionId(newSessionId());
    setTurns([]);
    setConversationId(null);
    setStatus("AI_ACTIVE");
  }

  async function returnToAi() {
    if (!conversationId) return;
    const res = await fetch("/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, action: "return_to_ai" }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) setStatus(j.status);
  }

  return (
    <div className="grid grid-3">
      <div>
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <strong>Conversation</strong> <span className={`badge ${status}`}>{status}</span>
            <span className="spacer" />
            {status !== "AI_ACTIVE" && <button onClick={returnToAi}>Return to AI</button>}
            {conversationId && <a className="btn" href={`/admin/conversations/${conversationId}`} target="_blank" rel="noreferrer">Open in inbox</a>}
            <button onClick={reset}>New session</button>
          </div>
          <div className="thread" style={{ maxHeight: "60vh" }}>
            {turns.length === 0 && <p className="muted small">Send a message or pick a sample on the right. Nothing is sent to real customers.</p>}
            {turns.map((t, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="bubble CUSTOMER">
                  {t.customer}
                  {t.stored && t.stored !== t.customer && <div className="meta">stored as: {t.stored}</div>}
                </div>
                {t.error && <div className="bubble SYSTEM error">Error: {t.error}</div>}
                {t.skipped && <div className="bubble SYSTEM">AI did not reply — {t.skipped.replace(/_/g, " ")}</div>}
                {t.reply && (
                  <div className="bubble AI">
                    {t.reply}
                    <div className="meta">
                      {t.lang} {t.guard ? `· guard: ${t.guard}` : ""} {t.handoff ? `· handoff: ${t.handoff.reason}` : ""}
                    </div>
                  </div>
                )}
                {(t.toolCalls.length > 0 || t.validation || t.llmError || t.modelReply) && (
                  <details className="small" style={{ alignSelf: "stretch" }}>
                    <summary className="muted">
                      Trace — {t.toolCalls.length} tool call(s){t.validation && !t.validation.ok ? " · ⚠️ blocked by grounding check" : ""}
                      {t.llmError ? " · ⚠️ LLM error" : ""}
                    </summary>
                    {t.signals && <div>Signals: {Object.entries(t.signals).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</div>}
                    {t.llmError && <div className="error">LLM: {t.llmError}</div>}
                    {t.validation && <div>Validation: {t.validation.ok ? "ok" : t.validation.issues.join(", ")}</div>}
                    {t.modelReply && t.modelReply !== t.reply && (
                      <div>
                        Raw model reply:<pre>{t.modelReply}</pre>
                      </div>
                    )}
                    {t.toolCalls.map((c, j) => (
                      <div key={j} style={{ marginTop: 6 }}>
                        <strong>{c.name}</strong> <span className={`badge ${c.ok ? "ok" : "bad"}`}>{c.ok ? "ok" : "failed"}</span> <span className="muted">{c.durationMs}ms</span>
                        <pre>in: {JSON.stringify(c.input, null, 1)}</pre>
                        <pre>out: {JSON.stringify(c.output, null, 1)}</pre>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
            {busy && <div className="bubble SYSTEM">Thinking…</div>}
            <div ref={endRef} />
          </div>
          <form
            className="row"
            style={{ marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type as a customer…" style={{ flex: "1 1 auto", width: "auto" }} maxLength={2000} />
            <button className="primary" disabled={busy || !text.trim()}>Send</button>
          </form>
        </div>
      </div>
      <div>
        <div className="card">
          <h3>Shopify data source</h3>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="mock:normal">Mock catalogue (seed data)</option>
            <option value="mock:out_of_stock">Mock — everything out of stock</option>
            <option value="mock:unavailable">Mock — Shopify API down</option>
            <option value="mock:order_fails">Mock — order creation fails</option>
            <option value="live">Live Shopify (real store data; orders are REAL)</option>
          </select>
          {mode === "live" && <p className="small error">Live mode reads real products and can create real Shopify orders.</p>}
          <label>Simulate channel-verified phone (like WhatsApp)</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01711111111" />
          <p className="small muted">Mock order #1001 belongs to 01711111111.</p>
        </div>
        <div className="card">
          <h3>Sample messages</h3>
          <div className="row">
            {SAMPLES.map((s) => (
              <button key={s} className="small" disabled={busy} onClick={() => send(s)} style={{ textAlign: "left" }}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

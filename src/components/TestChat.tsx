"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Database, ExternalLink, Lightbulb, Phone, RotateCcw, Send, Sparkles, TriangleAlert } from "lucide-react";
import { CardHeader, StatusPill, humanize } from "@/components/ui";

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
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [turns, busy]);

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
    <div className="grid-main">
      <div className="card chat" style={{ height: "calc(100vh - 210px)" }}>
        <div className="chat-header">
          <span className="avatar" style={{ ["--av" as string]: "#4f46e5" }} aria-hidden>
            <Bot width={18} height={18} />
          </span>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <div className="chat-title">
              Isolation assistant <StatusPill status={status} />
            </div>
            <div className="small muted">You are chatting as a customer · {mode === "live" ? "live Shopify data" : "mock catalogue"}</div>
          </div>
          <div className="row">
            {status !== "AI_ACTIVE" && (
              <button className="btn-sm" onClick={returnToAi}>
                <Bot width={14} height={14} aria-hidden /> Return to AI
              </button>
            )}
            {conversationId && (
              <a className="btn btn-sm" href={`/admin/conversations/${conversationId}`} target="_blank" rel="noreferrer">
                <ExternalLink width={14} height={14} aria-hidden /> Open in inbox
              </a>
            )}
            <button className="btn-sm" onClick={reset}>
              <RotateCcw width={14} height={14} aria-hidden /> New session
            </button>
          </div>
        </div>

        <div className="thread">
          <div className="thread-inner">
            {turns.length === 0 && !busy && (
              <div className="empty" style={{ padding: "40px 12px" }}>
                <div className="empty-icon"><Sparkles width={20} height={20} aria-hidden /></div>
                <div className="empty-title">Start a test conversation</div>
                <div className="small">Type a message below or pick one of the samples. Nothing is sent to real customers.</div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} style={{ display: "contents" }}>
                <div className="msg me">
                  <div className="bubble">{t.customer}</div>
                  {t.stored && t.stored !== t.customer && <div className="msg-meta">Stored as: {t.stored}</div>}
                </div>
                {t.error && (
                  <div className="msg sys"><div className="bubble" style={{ color: "var(--critical)" }}><TriangleAlert width={13} height={13} aria-hidden /> Error: {t.error}</div></div>
                )}
                {t.skipped && (
                  <div className="msg sys"><div className="bubble">AI did not reply — {t.skipped.replace(/_/g, " ")}</div></div>
                )}
                {t.reply && (
                  <div className="msg bot">
                    <div className="bubble">{t.reply}</div>
                    <div className="msg-meta">
                      <Sparkles aria-hidden /> AI assistant
                      {t.lang && <span>· {t.lang}</span>}
                      {t.guard && <span>· guard: {t.guard}</span>}
                      {t.handoff && <span className="warn">· handoff: {humanize(t.handoff.reason)}</span>}
                    </div>
                  </div>
                )}
                {(t.toolCalls.length > 0 || t.validation || t.llmError || t.modelReply) && (
                  <details className="trace">
                    <summary>
                      <ChevronRight width={14} height={14} aria-hidden />
                      Trace · {t.toolCalls.length} tool call{t.toolCalls.length === 1 ? "" : "s"}
                      {t.validation && !t.validation.ok && <span className="pill tone-warning">Blocked by grounding check</span>}
                      {t.llmError && <span className="pill tone-critical">LLM error</span>}
                    </summary>
                    <div className="trace-body">
                      {t.signals && <div><span className="muted">Signals:</span> {Object.entries(t.signals).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</div>}
                      {t.llmError && <div className="error">LLM: {t.llmError}</div>}
                      {t.validation && <div><span className="muted">Validation:</span> {t.validation.ok ? "ok" : t.validation.issues.join(", ")}</div>}
                      {t.modelReply && t.modelReply !== t.reply && (
                        <div>
                          <span className="muted">Raw model reply:</span>
                          <pre>{t.modelReply}</pre>
                        </div>
                      )}
                      {t.toolCalls.map((c, j) => (
                        <div key={j}>
                          <div className="row">
                            <span className="mono strong">{c.name}</span>
                            <span className={`pill ${c.ok ? "tone-good" : "tone-critical"}`}>{c.ok ? "OK" : "Failed"}</span>
                            <span className="tiny muted">{c.durationMs}ms</span>
                          </div>
                          <pre>in: {JSON.stringify(c.input, null, 1)}</pre>
                          <pre>out: {JSON.stringify(c.output, null, 1)}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {busy && (
              <div className="msg bot">
                <div className="bubble typing" aria-label="AI is typing"><span /><span /><span /></div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <div className="composer-box">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type as a customer…" maxLength={2000} aria-label="Message" />
            <button className="btn-primary" disabled={busy || !text.trim()} style={{ height: 42 }}>
              <Send width={16} height={16} aria-hidden /> Send
            </button>
          </div>
        </form>
      </div>

      <div className="stack">
        <div className="card">
          <CardHeader icon={Database} title="Shopify data source" />
          <div className="card-body">
            <div className="field">
              <label htmlFor="tc-mode">Data</label>
              <select id="tc-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="mock:normal">Mock catalogue (seed data)</option>
                <option value="mock:out_of_stock">Mock — everything out of stock</option>
                <option value="mock:unavailable">Mock — Shopify API down</option>
                <option value="mock:order_fails">Mock — order creation fails</option>
                <option value="live">Live Shopify (real store data; orders are REAL)</option>
              </select>
              {mode === "live" && <p className="hint error">Live mode reads real products and can create real Shopify orders.</p>}
            </div>
            <div className="field">
              <label htmlFor="tc-phone">Verified phone (like WhatsApp)</label>
              <div className="search" style={{ maxWidth: "none" }}>
                <Phone width={15} height={15} aria-hidden />
                <input id="tc-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01711111111" inputMode="tel" />
              </div>
              <p className="hint">Mock order #1001 belongs to 01711111111.</p>
            </div>
          </div>
        </div>
        <div className="card">
          <CardHeader icon={Lightbulb} title="Sample messages" description="Click one to send it." />
          <div className="card-body">
            <div className="row" style={{ gap: 6 }}>
              {SAMPLES.map((s) => (
                <button key={s} className="btn-sm" disabled={busy} onClick={() => send(s)} style={{ whiteSpace: "normal", height: "auto", minHeight: 30, padding: "5px 10px", textAlign: "left", fontWeight: 500 }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

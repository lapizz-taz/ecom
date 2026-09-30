"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ConversationActions({ conversationId, status }: { conversationId: string; status: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: string) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, action }) });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? { ok: true, text: `Status: ${j.status}` } : { ok: false, text: j.error ?? "Failed" });
    router.refresh();
  }

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/admin/conversations/${conversationId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) setText("");
    setMsg(res.ok ? { ok: true, text: "Sent" } : { ok: false, text: j.error ?? "Failed to send" });
    router.refresh();
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        {status !== "HUMAN_ACTIVE" && (
          <button className="primary" disabled={busy} onClick={() => act("take_over")}>Take over</button>
        )}
        {status !== "AI_ACTIVE" && (
          <button disabled={busy} onClick={() => act("return_to_ai")}>Return to AI</button>
        )}
        {status === "AI_ACTIVE" && (
          <button disabled={busy} onClick={() => act("request")}>Flag for human</button>
        )}
        {status !== "RESOLVED" && (
          <button disabled={busy} onClick={() => act("resolve")}>Mark resolved</button>
        )}
      </div>
      <label htmlFor="reply">Reply as Isolation team (pauses the AI)</label>
      <textarea id="reply" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Type a reply…" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>Send</button>
        {msg && <span className={msg.ok ? "success small" : "error small"}>{msg.text}</span>}
      </div>
    </div>
  );
}

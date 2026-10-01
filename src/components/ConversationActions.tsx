"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, CircleCheck, Flag, Headset, LoaderCircle, Send } from "lucide-react";

type Feedback = { ok: boolean; text: string } | null;

function FeedbackText({ msg }: { msg: Feedback }) {
  if (!msg) return null;
  return <span className={`feedback ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</span>;
}

const STATUS_TEXT: Record<string, string> = {
  AI_ACTIVE: "AI handling",
  HUMAN_REQUIRED: "Needs a human",
  HUMAN_ACTIVE: "Human handling",
  RESOLVED: "Resolved",
};

/** Take over / return to AI / flag / resolve — shown in the conversation header. */
export function StatusActions({ conversationId, status }: { conversationId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);

  async function act(action: string) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, action }) });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? { ok: true, text: `Now: ${STATUS_TEXT[j.status] ?? j.status}` } : { ok: false, text: j.error ?? "Failed" });
    router.refresh();
  }

  return (
    <div className="row">
      <FeedbackText msg={msg} />
      {status === "AI_ACTIVE" && (
        <button className="btn-sm" disabled={busy} onClick={() => act("request")}>
          <Flag width={14} height={14} aria-hidden /> Flag for human
        </button>
      )}
      {status !== "AI_ACTIVE" && (
        <button className="btn-sm" disabled={busy} onClick={() => act("return_to_ai")}>
          <Bot width={14} height={14} aria-hidden /> Return to AI
        </button>
      )}
      {status !== "RESOLVED" && (
        <button className="btn-sm" disabled={busy} onClick={() => act("resolve")}>
          <CircleCheck width={14} height={14} aria-hidden /> Resolve
        </button>
      )}
      {status !== "HUMAN_ACTIVE" && (
        <button className="btn-primary btn-sm" disabled={busy} onClick={() => act("take_over")}>
          <Headset width={14} height={14} aria-hidden /> Take over
        </button>
      )}
    </div>
  );
}

/** Staff reply box at the bottom of the thread. Sending pauses the AI. */
export function ReplyComposer({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);

  async function send() {
    if (!text.trim() || busy) return;
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
    <div className="composer">
      <div className="composer-box">
        <label htmlFor="reply" className="sr-only">Reply as Isolation team</label>
        <textarea
          id="reply"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={2000}
          rows={2}
          placeholder="Write a reply as the Isolation team…"
        />
        <button className="btn-primary" disabled={busy || !text.trim()} onClick={send} style={{ height: 44 }}>
          {busy ? <LoaderCircle width={16} height={16} className="spin" aria-hidden /> : <Send width={16} height={16} aria-hidden />}
          Send
        </button>
      </div>
      <div className="composer-hint">
        <span>Sending a reply pauses the AI for this conversation.</span>
        <span className="spacer" />
        <span className="hide-mobile">Ctrl + Enter to send</span>
        <FeedbackText msg={msg} />
      </div>
    </div>
  );
}

"use client";
import { useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { CardHeader } from "@/components/ui";

/** Signed-in staff: change your own password. */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords don't match." });
    setBusy(true);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg({ ok: false, text: j.details?.join("; ") ?? j.error ?? "Couldn't change the password" });
    setCurrent("");
    setNext("");
    setConfirm("");
    setMsg({ ok: true, text: "Password changed. Use it next time you sign in." });
  }

  return (
    <form className="card" onSubmit={submit}>
      <CardHeader icon={KeyRound} title="Change password" description="You'll stay signed in on this device." />
      <div className="card-body">
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor="pw-new">New password</label>
            <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            <p className="hint">At least 12 characters, with an upper-case letter, a lower-case letter and a number.</p>
          </div>
          <div className="field">
            <label htmlFor="pw-confirm">Repeat new password</label>
            <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
        </div>
      </div>
      <div className="card-footer">
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy && <LoaderCircle width={15} height={15} className="spin" aria-hidden />}
          Change password
        </button>
        {msg && <span className={`feedback ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}

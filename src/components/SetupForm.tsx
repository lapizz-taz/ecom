"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, TriangleAlert } from "lucide-react";

export function SetupForm({ expectedEmail }: { expectedEmail: string | null }) {
  const router = useRouter();
  const [setupKey, setSetupKey] = useState("");
  const [email, setEmail] = useState(expectedEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupKey, email, password }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setError(j.details?.join("; ") ?? j.error ?? "Setup failed");
    router.replace("/login?setup=done");
  }

  return (
    <form onSubmit={submit}>
      <p className="small muted" style={{ marginBottom: 20 }}>This page stops working once an admin exists.</p>
      <div className="field">
        <label htmlFor="key">Setup key</label>
        <input id="key" type="password" autoComplete="off" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} required />
        <p className="hint">
          Paste the exact value of <code>NEXTAUTH_SECRET</code> from Vercel → your project → Settings → Environment Variables.
        </p>
      </div>
      <div className="field">
        <label htmlFor="email">Your email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={Boolean(expectedEmail)} required />
      </div>
      <div className="field">
        <label htmlFor="pw">Choose a password</label>
        <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <p className="hint">At least 12 characters, with an upper-case letter, a lower-case letter and a number.</p>
      </div>
      <div className="field">
        <label htmlFor="pw2">Repeat password</label>
        <input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {error && (
        <p className="feedback err" role="alert" style={{ marginTop: 14 }}>
          <TriangleAlert width={15} height={15} aria-hidden /> {error}
        </p>
      )}
      <button className="btn-primary btn-block" type="submit" disabled={busy} style={{ marginTop: 22, height: 42 }}>
        {busy && <LoaderCircle width={16} height={16} className="spin" aria-hidden />}
        {busy ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}

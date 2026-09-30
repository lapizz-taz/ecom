"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNeedsSetup(false);
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `Login failed (HTTP ${res.status})`);
      setNeedsSetup(Boolean(j.setup));
      return;
    }
    const next = params.get("next");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/admin");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card">
      <div className="brand">
        Isolation<small>Staff console</small>
      </div>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {params.get("setup") === "done" && !error && <p className="success">Admin account created — sign in now.</p>}
      {error && <p className="error">{error}</p>}
      {needsSetup && (
        <p>
          <a className="btn primary" href="/setup">Create the admin account</a>
        </p>
      )}
      <div style={{ marginTop: 16 }}>
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="login">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}

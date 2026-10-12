"use client";

import { Loader2, Lock } from "lucide-react";
import { useState } from "react";

export function AdminLogin({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) window.location.reload();
    else {
      setError(data.error || "Login failed.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card mt-8 space-y-4 p-6 sm:p-8">
      <div>
        <h1 className="font-heading text-[22px] font-semibold">Registrations</h1>
        <p className="mt-1 text-[15px] text-muted">Staff only. Enter the admin password.</p>
      </div>
      {!configured && (
        <p className="rounded-[var(--radius-card)] bg-amber-50 p-3 text-[14px] text-amber-900">
          Admin isn&apos;t set up yet. Add <code className="font-mono">ADMIN_PASSWORD</code> (8+ characters) to the environment variables.
        </p>
      )}
      <div>
        <label htmlFor="admin-password" className="field-label">Password</label>
        <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="field-input" required aria-invalid={error ? true : undefined} aria-describedby={error ? "admin-error" : undefined} />
        {error && <p id="admin-error" className="field-error" role="alert">{error}</p>}
      </div>
      <button type="submit" className="btn btn-primary-sm w-full" disabled={busy || !configured}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />} Log in
      </button>
    </form>
  );
}

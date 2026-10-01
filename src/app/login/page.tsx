"use client";
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CircleCheck, Eye, EyeOff, LoaderCircle, TriangleAlert, UserPlus } from "lucide-react";
import { AuthLayout } from "@/components/AuthLayout";

interface Health {
  ok: boolean;
  adminExists: boolean;
  problem: string | null;
  problems?: string[];
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);

  // Surface configuration problems up front instead of after a failed sign-in.
  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((h: Health) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNeedsSetup(false);
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!res.ok) {
      setBusy(false);
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
    <>
      <h1>Welcome back</h1>
      <p className="page-desc">Sign in to the Isolation staff console.</p>

      <div className="stack" style={{ gap: 12, marginBottom: 20 }}>
        {health?.problem && (
          <div className="alert alert-critical">
            <TriangleAlert width={18} height={18} aria-hidden />
            <div>
              <div className="alert-title">Setup needed</div>
              {(health.problems?.length ? health.problems : [health.problem]).map((p) => (
                <p key={p} className="alert-body small" style={{ marginTop: 4 }}>{p}</p>
              ))}
            </div>
          </div>
        )}
        {health && !health.problem && !health.adminExists && (
          <div className="alert alert-info">
            <UserPlus width={18} height={18} aria-hidden />
            <div style={{ flex: 1 }}>
              <div className="alert-title">No admin account yet</div>
              <p className="alert-body small" style={{ margin: "2px 0 10px" }}>Create the owner account first.</p>
              <a className="btn btn-primary btn-sm" href="/setup">Create the admin account</a>
            </div>
          </div>
        )}
        {params.get("reset") === "done" && !error && (
          <div className="alert alert-good">
            <CircleCheck width={18} height={18} aria-hidden />
            <div className="alert-title">Password changed — sign in with your new password.</div>
          </div>
        )}
        {params.get("setup") === "done" && !error && (
          <div className="alert alert-good">
            <CircleCheck width={18} height={18} aria-hidden />
            <div className="alert-title">Admin account created — sign in now.</div>
          </div>
        )}
      </div>

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@isolationpvt.shop" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <div className="pw-wrap">
            <input id="password" type={showPw ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"} title={showPw ? "Hide password" : "Show password"}>
              {showPw ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
            </button>
          </div>
        </div>
        {error && (
          <p className="feedback err" role="alert" style={{ marginTop: 14 }}>
            <TriangleAlert width={15} height={15} aria-hidden /> {error}
          </p>
        )}
        {needsSetup && (
          <p style={{ marginTop: 10 }}>
            <a className="btn btn-sm" href="/setup">Create the admin account</a>
          </p>
        )}
        <button className="btn-primary btn-block" disabled={busy} type="submit" style={{ marginTop: 22, height: 42 }}>
          {busy ? <LoaderCircle width={16} height={16} className="spin" aria-hidden /> : null}
          {busy ? "Signing in…" : "Sign in"}
          {!busy && <ArrowRight width={16} height={16} aria-hidden />}
        </button>
      </form>
      <p className="small muted" style={{ marginTop: 22, textAlign: "center" }}>
        <a className="link" href="/setup?forgot">Forgot your password?</a> Admins can reset it with the setup key; staff can ask an admin.
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <AuthLayout>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthLayout>
  );
}

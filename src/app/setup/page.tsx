import Link from "next/link";
import { describeProblem, getSetupStatus } from "@/lib/setup";
import { SetupForm } from "@/components/SetupForm";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function SetupPage() {
  const status = await getSetupStatus();
  const problem = describeProblem(status);
  return (
    <div className="login" style={{ maxWidth: 440 }}>
      <div className="card">
        <div className="brand">
          Isolation<small>First-time setup</small>
        </div>
        {problem ? (
          <>
            <p className="error">{problem}</p>
            <p className="small muted">Fix this, redeploy, then reload this page.</p>
          </>
        ) : status.adminExists ? (
          <>
            <p className="success">Setup is complete — an admin account exists.</p>
            <Link className="btn primary" href="/login">Go to sign in</Link>
            <p className="small muted" style={{ marginTop: 12 }}>Forgot the password? Another admin can reset it under Staff accounts, or run <code>npm run admin:create -- your@email ADMIN</code>.</p>
          </>
        ) : (
          <SetupForm expectedEmail={process.env.ADMIN_EMAIL?.trim().toLowerCase() || null} />
        )}
      </div>
    </div>
  );
}

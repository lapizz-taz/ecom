import Link from "next/link";
import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react";
import { describeProblem, getSetupStatus } from "@/lib/setup";
import { SetupForm } from "@/components/SetupForm";
import { AuthLayout } from "@/components/AuthLayout";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function SetupPage() {
  const status = await getSetupStatus();
  const problem = describeProblem(status);
  return (
    <AuthLayout>
      <h1>First-time setup</h1>
      <p className="page-desc">Create the owner account for this console.</p>
      {problem ? (
        <div className="alert alert-critical">
          <TriangleAlert width={18} height={18} aria-hidden />
          <div>
            <div className="alert-title">{problem}</div>
            <p className="alert-body small" style={{ marginTop: 4 }}>Fix this, redeploy, then reload this page.</p>
          </div>
        </div>
      ) : status.adminExists ? (
        <div className="stack">
          <div className="alert alert-good">
            <CircleCheck width={18} height={18} aria-hidden />
            <div className="alert-title">Setup is complete — an admin account exists.</div>
          </div>
          <Link className="btn btn-primary btn-block" href="/login" style={{ height: 42 }}>
            Go to sign in <ArrowRight width={16} height={16} aria-hidden />
          </Link>
          <p className="small muted">
            Forgot the password? Another admin can reset it under Staff accounts, or run <code>npm run admin:create -- your@email ADMIN</code>.
          </p>
        </div>
      ) : (
        <SetupForm expectedEmail={process.env.ADMIN_EMAIL?.trim().toLowerCase() || null} />
      )}
    </AuthLayout>
  );
}

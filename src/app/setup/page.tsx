import Link from "next/link";
import { ArrowRight, ChevronRight, CircleCheck, KeyRound, TriangleAlert } from "lucide-react";
import { describeProblem, getSetupStatus } from "@/lib/setup";
import { SetupForm } from "@/components/SetupForm";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { AuthLayout } from "@/components/AuthLayout";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ forgot?: string }> }) {
  const forgot = (await searchParams).forgot !== undefined;
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
          <details className="card collapse" open={forgot}>
            <summary>
              <KeyRound width={16} height={16} className="muted" aria-hidden />
              Forgot the password?
              <ChevronRight width={16} height={16} className="chev" aria-hidden />
            </summary>
            <div className="card-body">
              <ResetPasswordForm defaultEmail={process.env.ADMIN_EMAIL?.trim().toLowerCase() || null} />
            </div>
          </details>
        </div>
      ) : (
        <SetupForm expectedEmail={process.env.ADMIN_EMAIL?.trim().toLowerCase() || null} />
      )}
    </AuthLayout>
  );
}

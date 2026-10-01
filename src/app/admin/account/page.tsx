import { requirePageSession } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { Avatar, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await requirePageSession();
  return (
    <>
      <PageHeader title="My account" description="Your sign-in details for this console." />
      <div className="stack" style={{ maxWidth: 720 }}>
        <div className="card card-body">
          <div className="profile-head">
            <Avatar name={session.email} size="lg" />
            <div style={{ minWidth: 0 }}>
              <div className="strong truncate">{session.email}</div>
              <div className="small muted">{session.role === "ADMIN" ? "Admin — full access" : "Agent — conversations, customers, orders and products"}</div>
            </div>
          </div>
        </div>
        <ChangePasswordForm />
      </div>
    </>
  );
}

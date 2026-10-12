import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Logo } from "@/components/brand/Logo";
import { ADMIN_COOKIE, adminConfigured, verifySession } from "@/lib/server/admin-auth";
import { listRegistrations } from "@/lib/server/storage";
import { emailConfigured } from "@/lib/server/email";
import { AdminLogin } from "./AdminLogin";
import { AdminTable } from "./AdminTable";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Registrations", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const session = (await cookies()).get(ADMIN_COOKIE)?.value;
  const loggedIn = verifySession(session);

  if (!loggedIn) {
    return (
      <main className="grid min-h-svh place-items-center bg-surface px-4 py-12">
        <div className="w-full max-w-[400px]">
          <Logo className="mx-auto h-9 w-auto text-brand" />
          <AdminLogin configured={adminConfigured()} />
        </div>
      </main>
    );
  }

  let rows: Awaited<ReturnType<typeof listRegistrations>>["rows"] = [];
  let source = "none";
  let loadError = "";
  try {
    ({ rows, source } = await listRegistrations());
  } catch (err) {
    console.error("[admin] list failed", err);
    loadError = "Couldn't load registrations from storage. Check the storage settings and try again.";
  }

  return <AdminTable rows={rows} source={source} loadError={loadError} emailOn={emailConfigured()} />;
}

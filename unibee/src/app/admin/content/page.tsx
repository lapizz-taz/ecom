import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Logo } from "@/components/brand/Logo";
import { ADMIN_COOKIE, adminConfigured, verifySession } from "@/lib/server/admin-auth";
import { contentBackend, getContentForEditing, listVersions } from "@/lib/server/content-store";
import { defaultContent } from "@/lib/content/defaults";
import { AdminLogin } from "../AdminLogin";
import { AdminShell } from "../AdminShell";
import { ContentEditor } from "./ContentEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Website content", robots: { index: false, follow: false } };

export default async function ContentPage() {
  const loggedIn = verifySession((await cookies()).get(ADMIN_COOKIE)?.value);
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

  let stored: Awaited<ReturnType<typeof getContentForEditing>> = { data: defaultContent, updatedAt: null };
  let versions: Awaited<ReturnType<typeof listVersions>> = [];
  try {
    [stored, versions] = await Promise.all([getContentForEditing(), listVersions()]);
  } catch (err) {
    console.error("[cms] load failed", err);
  }

  return (
    <AdminShell active="content">
      <ContentEditor initial={stored.data} updatedAt={stored.updatedAt} versions={versions} backend={contentBackend()} />
    </AdminShell>
  );
}

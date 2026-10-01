import { requirePageSession } from "@/lib/auth";
import { UsersEditor } from "@/components/UsersEditor";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <PageHeader title="Staff accounts" description="Who can sign in to this console, and what they can change." />
      <UsersEditor />
    </>
  );
}

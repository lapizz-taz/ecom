import { requirePageSession } from "@/lib/auth";
import { UsersEditor } from "@/components/UsersEditor";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <h1>Staff accounts</h1>
      <UsersEditor />
    </>
  );
}

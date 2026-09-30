import { requirePageSession } from "@/lib/auth";
import { SettingsEditor } from "@/components/SettingsEditor";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <h1>Settings</h1>
      <SettingsEditor />
    </>
  );
}

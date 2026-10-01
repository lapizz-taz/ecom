import { requirePageSession } from "@/lib/auth";
import { SettingsEditor } from "@/components/SettingsEditor";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <PageHeader title="Settings" description="Delivery, payment, AI behaviour and business details. Each section saves on its own." />
      <SettingsEditor />
    </>
  );
}

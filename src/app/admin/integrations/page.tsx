import { requirePageSession } from "@/lib/auth";
import { IntegrationsManager } from "@/components/IntegrationsManager";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect OpenAI, Shopify, Messenger, Instagram and WhatsApp. Paste each key once — it's stored encrypted and works immediately, no redeploy needed."
      />
      <IntegrationsManager />
    </>
  );
}

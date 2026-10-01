import { TriangleAlert } from "lucide-react";
import { requirePageSession } from "@/lib/auth";
import { integrationStatus } from "@/lib/integrations";
import { TestChat } from "@/components/TestChat";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TestChatPage() {
  await requirePageSession();
  const integrations = await integrationStatus();
  return (
    <>
      <PageHeader
        title="Test chat"
        description="Talk to the real AI pipeline (guards → tools → grounding check → handoff) on a private test channel. Customers never see these messages."
      />
      {!integrations.openai && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <TriangleAlert width={18} height={18} aria-hidden />
          <div>
            <div className="alert-title">OpenAI isn&apos;t connected</div>
            <div className="alert-body small">
              Guard-based replies still work; everything else falls back to a human handoff. Connect it on the <a className="link" href="/admin/integrations#openai">Integrations</a> page.
            </div>
          </div>
        </div>
      )}
      <TestChat />
    </>
  );
}

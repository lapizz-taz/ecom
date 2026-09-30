import Link from "next/link";
import { requirePageSession } from "@/lib/auth";
import { integrationStatus } from "@/lib/env";
import { TestChat } from "@/components/TestChat";

export const dynamic = "force-dynamic";

export default async function TestChatPage() {
  await requirePageSession();
  const integrations = integrationStatus();
  return (
    <div className="main">
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href="/admin" className="small">← Dashboard</Link>
      </div>
      <h1>Test chat</h1>
      <p className="small muted">
        Runs the real AI pipeline (guards → tools → grounding check → handoff) on an internal TEST channel. Tool calls and data are visible here only — customers never see internals.
        {!integrations.openai && <strong className="error"> OPENAI_API_KEY is not set: guard-based replies work, everything else falls back to a human handoff.</strong>}
      </p>
      <TestChat />
    </div>
  );
}

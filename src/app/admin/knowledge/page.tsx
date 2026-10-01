import { requirePageSession } from "@/lib/auth";
import { KnowledgeEditor } from "@/components/KnowledgeEditor";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <PageHeader title="Knowledge base" description="The facts the AI is allowed to state. Anything not written here, it won't make up." />
      <KnowledgeEditor />
    </>
  );
}

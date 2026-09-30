import { requirePageSession } from "@/lib/auth";
import { KnowledgeEditor } from "@/components/KnowledgeEditor";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  await requirePageSession("ADMIN");
  return (
    <>
      <h1>Knowledge base</h1>
      <KnowledgeEditor />
    </>
  );
}

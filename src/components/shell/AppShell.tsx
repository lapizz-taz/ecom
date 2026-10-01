import type { ReactNode } from "react";
import { prisma } from "@/lib/db";
import { requirePageSession } from "@/lib/auth";
import { integrationHealth } from "@/lib/integrations/health";
import { ShellFrame } from "@/components/shell/ShellFrame";

/** Signed-in console frame (sidebar + mobile drawer) shared by /admin and /test-chat. */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await requirePageSession();
  const [needsHuman, integrations] = await Promise.all([
    prisma.conversation.count({ where: { status: "HUMAN_REQUIRED", channel: { not: "TEST" } } }),
    integrationHealth(),
  ]);
  return (
    <ShellFrame email={session.email} role={session.role} needsHuman={needsHuman} integrations={integrations}>
      {children}
    </ShellFrame>
  );
}

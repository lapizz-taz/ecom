import { AppShell } from "@/components/shell/AppShell";

export const dynamic = "force-dynamic";

export default function TestChatLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

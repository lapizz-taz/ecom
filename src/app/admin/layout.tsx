import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePageSession } from "@/lib/auth";
import { integrationStatus } from "@/lib/env";
import { LogoutButton } from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePageSession();
  const needsHuman = await prisma.conversation.count({ where: { status: "HUMAN_REQUIRED", channel: { not: "TEST" } } });
  const integrations = integrationStatus();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Isolation<small>AI sales & support</small>
        </div>
        <nav className="nav">
          <Link href="/admin">
            Conversations {needsHuman > 0 && <span className="count">{needsHuman}</span>}
          </Link>
          <Link href="/admin/customers">Customers</Link>
          <Link href="/admin/orders">Orders</Link>
          <Link href="/admin/products">Products & stock</Link>
          <Link href="/admin/analytics">Analytics</Link>
          <Link href="/test-chat">Test chat</Link>
          {session.role === "ADMIN" && (
            <>
              <Link href="/admin/knowledge">Knowledge base</Link>
              <Link href="/admin/settings">Settings</Link>
              <Link href="/admin/users">Staff accounts</Link>
            </>
          )}
        </nav>
        <div className="small muted" style={{ marginTop: 24 }}>
          <div style={{ marginBottom: 6 }}>Integrations</div>
          {Object.entries(integrations).map(([k, v]) => (
            <div key={k}>
              {v ? "🟢" : "⚪️"} {k}
            </div>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 24 }}>
          {session.email}
          <br />
          <span className="badge">{session.role}</span>
          <div style={{ marginTop: 8 }}>
            <LogoutButton />
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

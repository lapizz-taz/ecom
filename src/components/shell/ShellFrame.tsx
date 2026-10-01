"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChartColumn, FlaskConical, Menu, MessagesSquare, Package, Plug, Settings, ShoppingBag, UserCog, Users, X, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui";
import { LogoutButton } from "@/components/LogoutButton";

interface NavItem { href: string; label: string; icon: LucideIcon; badge?: number }

const INTEGRATION_LABELS: Record<string, string> = {
  openai: "OpenAI",
  shopify: "Shopify",
  meta: "Messenger",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  notifications: "Alerts",
};

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin" || pathname.startsWith("/admin/conversations");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ShellFrame(props: {
  children: ReactNode;
  email: string;
  role: string;
  needsHuman: number;
  integrations: Record<string, "ok" | "problem" | "off">;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: "Workspace",
      items: [
        { href: "/admin", label: "Inbox", icon: MessagesSquare, badge: props.needsHuman },
        { href: "/admin/customers", label: "Customers", icon: Users },
        { href: "/admin/orders", label: "Orders", icon: ShoppingBag },
        { href: "/admin/products", label: "Products & stock", icon: Package },
      ],
    },
    {
      label: "Insights",
      items: [
        { href: "/admin/analytics", label: "Analytics", icon: ChartColumn },
        { href: "/test-chat", label: "Test chat", icon: FlaskConical },
      ],
    },
  ];
  if (props.role === "ADMIN") {
    groups.push({
      label: "Admin",
      items: [
        { href: "/admin/integrations", label: "Integrations", icon: Plug },
        { href: "/admin/knowledge", label: "Knowledge base", icon: BookOpen },
        { href: "/admin/settings", label: "Settings", icon: Settings },
        { href: "/admin/users", label: "Staff accounts", icon: UserCog },
      ],
    });
  }
  const integrationEntries = Object.entries(props.integrations);
  const connected = integrationEntries.filter(([, v]) => v === "ok").length;
  const problems = integrationEntries.filter(([, v]) => v === "problem").length;

  return (
    <div className={`app${open ? " menu-open" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="row nowrap-row" style={{ alignItems: "flex-start" }}>
          <Link href="/admin" className="brand">
            <span className="logo-mark">I</span>
            <span>
              <span className="brand-name">ISOLATION</span>
              <span className="brand-sub" style={{ display: "block" }}>AI sales & support</span>
            </span>
          </Link>
          <span className="spacer" />
          {open && (
            <button className="btn-ghost btn-icon btn-sm" onClick={() => setOpen(false)} aria-label="Close menu">
              <X width={18} height={18} />
            </button>
          )}
        </div>
        <nav className="nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {g.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                    <Icon width={18} height={18} aria-hidden />
                    {item.label}
                    {item.badge ? <span className="nav-count" title={`${item.badge} waiting for a human`}>{item.badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {(() => {
            const body = (
              <>
                <div className="integrations-title">
                  <span>Integrations</span>
                  {problems > 0 ? (
                    <span className="error" style={{ fontWeight: 600 }}>{problems} {problems === 1 ? "problem" : "problems"}</span>
                  ) : (
                    <span className="muted" style={{ fontWeight: 500 }}>{connected}/{integrationEntries.length}</span>
                  )}
                </div>
                <div className="integration-list">
                  {integrationEntries.map(([k, v]) => (
                    <div key={k} className="integration" title={v === "ok" ? "Connected" : v === "problem" ? "Not working — check the Integrations page" : "Not set up"}>
                      <span className={`dot${v === "ok" ? " on" : v === "problem" ? " bad" : ""}`} />
                      {INTEGRATION_LABELS[k] ?? k}
                    </div>
                  ))}
                </div>
              </>
            );
            // Admins can jump straight to the Integrations page to connect what's missing.
            return props.role === "ADMIN" ? (
              <Link href="/admin/integrations" className="integrations" title="Manage integrations">{body}</Link>
            ) : (
              <div className="integrations">{body}</div>
            );
          })()}
          <div className="user-card">
            <Link href="/admin/account" className="row nowrap-row" style={{ flex: 1, minWidth: 0, gap: 10 }} title="My account · change password">
              <Avatar name={props.email} size="sm" />
              <div className="user-meta">
                <div className="user-email truncate">{props.email}</div>
                <div className="tiny muted">{props.role === "ADMIN" ? "Admin" : "Agent"} · My account</div>
              </div>
            </Link>
            <LogoutButton />
          </div>
        </div>
      </aside>
      <button className="drawer-backdrop" aria-label="Close menu" tabIndex={open ? 0 : -1} onClick={() => setOpen(false)} />
      <div style={{ minWidth: 0 }}>
        <header className="topbar">
          <button className="btn-ghost btn-icon" data-menu-toggle onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
            <Menu width={20} height={20} />
          </button>
          <Link href="/admin" className="brand">
            <span className="logo-mark">I</span>
            <span className="brand-name">ISOLATION</span>
          </Link>
          <span className="spacer" />
          {props.needsHuman > 0 && (
            <Link href="/admin?status=HUMAN_REQUIRED" className="pill tone-critical lg" title="Conversations waiting for a human">
              {props.needsHuman} waiting
            </Link>
          )}
        </header>
        <main className="content">
          <div className="content-inner">{props.children}</div>
        </main>
      </div>
    </div>
  );
}

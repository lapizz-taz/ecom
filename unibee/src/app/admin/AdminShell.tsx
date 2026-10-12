"use client";

import { ExternalLink, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/Logo";

/** Admin frame: logo, tabs (Registrations / Website content), view site, log out. */
export function AdminShell({ active, children }: { active: "registrations" | "content"; children: ReactNode }) {
  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin";
  };
  const tabs = [
    { id: "registrations", label: "Registrations", href: "/admin" },
    { id: "content", label: "Website content", href: "/admin/content" },
  ] as const;

  return (
    <div className="min-h-svh bg-surface">
      <header className="sticky top-0 z-40 border-b border-line bg-white">
        <div className="container-page flex h-14 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-5">
            <a href="/admin" aria-label="Admin home">
              <Logo className="h-5 w-auto text-brand" />
            </a>
            <nav aria-label="Admin" className="flex h-14 items-stretch gap-1">
              {tabs.map((t) => (
                <a
                  key={t.id}
                  href={t.href}
                  aria-current={active === t.id ? "page" : undefined}
                  className={`flex items-center border-b-2 px-2.5 text-[14px] whitespace-nowrap transition ${
                    active === t.id ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-1">
            <a href="/" target="_blank" rel="noopener noreferrer" className="hidden items-center gap-1.5 rounded-full px-3 py-2 text-[13px] text-muted hover:bg-surface hover:text-ink sm:inline-flex">
              View site <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <button type="button" onClick={logout} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] text-muted hover:bg-surface hover:text-ink">
              <LogOut className="size-3.5" aria-hidden="true" /> Log out
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

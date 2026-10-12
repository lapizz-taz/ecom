"use client";

import { ArrowRight, Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { useFocusTrap, useScrollLock } from "@/components/ui/Modal";
import { useContent } from "@/components/content/ContentProvider";
import { navItems, whatsappUrl } from "@/lib/content/helpers";
import { isActive, page } from "@/lib/links";
import { trackWhatsAppClick } from "@/lib/analytics";

export function Header() {
  const pathname = usePathname() || "/";
  const content = useContent();
  const nav = navItems(content);
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);
  useScrollLock(open);
  useFocusTrap(open, menuRef, close);

  return (
    <>
      <a href="#main" className="sr-only z-[80] rounded-full bg-ink px-4 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-50 border-b bg-white/85 backdrop-blur-md transition-colors duration-300 ${scrolled ? "border-line" : "border-transparent"}`}
      >
        <div className="container-page flex h-16 items-center justify-between gap-6">
          <a href={page("/")} className="-m-2 shrink-0 p-2" aria-label="UniBee home">
            <Logo className="h-6 w-auto text-brand" />
          </a>

          <div className="flex items-center gap-2">
            <nav aria-label="Main" className="hidden md:block">
              <ul className="flex items-center">
                {nav.map((item) => {
                  const active = isActive(item.href, pathname);
                  return (
                    <li key={item.href}>
                      <a
                        href={page(item.href)}
                        aria-current={active ? "page" : undefined}
                        className={`rounded-full px-3 py-2 text-[14px] transition-colors ${
                          active ? "font-medium text-brand-dark" : "text-muted hover:text-ink"
                        }`}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <span className="mx-2 hidden h-4 w-px bg-line md:block" aria-hidden="true" />
            <a href={page("/#register")} className="btn btn-primary-sm hidden sm:inline-flex">
              Register Now
            </a>
            <button
              type="button"
              className="grid size-10 place-items-center rounded-full text-ink transition hover:bg-surface md:hidden"
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen(true)}
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Full-screen mobile menu */}
      {open && (
        <div ref={menuRef} id="mobile-menu" role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-[70] flex flex-col bg-white md:hidden">
          <div className="container-page flex h-16 items-center justify-between border-b border-line">
            <a href={page("/")} onClick={close} aria-label="UniBee home" className="-m-2 p-2">
              <Logo className="h-6 w-auto text-brand" />
            </a>
            <button type="button" onClick={close} className="grid size-10 place-items-center rounded-full hover:bg-surface" aria-label="Close menu" data-autofocus>
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Mobile" className="container-page flex-1 overflow-y-auto py-4">
            <ul className="divide-y divide-line">
              {nav.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <li key={item.href}>
                    <a
                      href={page(item.href)}
                      onClick={close}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-16 items-center justify-between text-[22px] font-semibold tracking-[-0.02em] ${active ? "text-brand-dark" : "text-ink"}`}
                    >
                      {item.label}
                      <ArrowRight className="size-5 text-faint" aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="container-page grid gap-2 border-t border-line py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <a href={page("/#register")} onClick={close} className="btn btn-primary w-full min-h-12">
              Register Now
            </a>
            <a
              href={whatsappUrl(content)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackWhatsAppClick("mobile-menu")}
              className="btn btn-secondary w-full min-h-12"
            >
              Talk on WhatsApp
            </a>
          </div>
        </div>
      )}
    </>
  );
}

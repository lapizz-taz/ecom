"use client";

import { ArrowRight, Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { useFocusTrap, useScrollLock } from "@/components/ui/Modal";
import { nav, site, whatsappUrl } from "@/content/site";
import { isActive, page } from "@/lib/links";
import { trackWhatsAppClick } from "@/lib/analytics";

export function Header() {
  const pathname = usePathname() || "/";
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

      {site.announcement.text && (
        <div className="hidden bg-brand-tint text-[14px] text-ink/85 sm:block">
          <div className="container-page flex min-h-10 items-center justify-center gap-3 py-2 text-center">
            <span className="hidden size-2 shrink-0 rounded-full bg-brand sm:inline-block" aria-hidden="true" />
            <span>{site.announcement.text}</span>
            <span className="h-4 w-px bg-ink/20" aria-hidden="true" />
            <a href={page("/#register")} className="font-semibold whitespace-nowrap text-brand-dark underline-offset-4 hover:underline">
              {site.announcement.linkText} →
            </a>
          </div>
        </div>
      )}

      <header
        className={`sticky top-0 z-50 border-b bg-white/95 backdrop-blur transition-shadow duration-300 supports-[backdrop-filter]:bg-white/85 ${
          scrolled ? "border-transparent shadow-[0_1px_0_rgba(17,24,39,0.06),0_8px_24px_rgba(17,24,39,0.06)]" : "border-line"
        }`}
      >
        <div className="container-page flex h-16 items-center justify-between gap-6 lg:h-[72px]">
          <a href={page("/")} className="-m-2 shrink-0 p-2" aria-label="UniBee home">
            <Logo className="h-7 w-auto text-brand lg:h-8" />
          </a>

          <nav aria-label="Main" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {nav.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <li key={item.href}>
                    <a
                      href={page(item.href)}
                      aria-current={active ? "page" : undefined}
                      className={`relative rounded-full px-3.5 py-2 text-[15px] font-medium transition-colors lg:px-4 ${
                        active ? "text-brand-dark" : "text-ink-soft hover:bg-surface hover:text-ink"
                      }`}
                    >
                      {item.label}
                      {active && <span className="absolute inset-x-4 -bottom-[13px] h-0.5 rounded-full bg-brand lg:-bottom-[17px]" aria-hidden="true" />}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex items-center gap-2">
            <a href={page("/#register")} className="btn btn-primary-sm hidden sm:inline-flex">
              Register Now
            </a>
            <button
              type="button"
              className="grid size-11 place-items-center rounded-full text-ink ring-1 ring-line transition hover:bg-surface md:hidden"
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen(true)}
            >
              <Menu className="size-6" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Full-screen mobile menu */}
      {open && (
        <div ref={menuRef} id="mobile-menu" role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-[70] flex flex-col bg-white md:hidden">
          <div className="container-page flex h-16 items-center justify-between border-b border-line">
            <a href={page("/")} onClick={close} aria-label="UniBee home" className="-m-2 p-2">
              <Logo className="h-7 w-auto text-brand" />
            </a>
            <button type="button" onClick={close} className="grid size-11 place-items-center rounded-full ring-1 ring-line" aria-label="Close menu" data-autofocus>
              <X className="size-6" aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Mobile" className="container-page flex-1 overflow-y-auto py-6">
            <ul className="space-y-1">
              {nav.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <li key={item.href}>
                    <a
                      href={page(item.href)}
                      onClick={close}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-14 items-center justify-between rounded-[var(--radius-card)] px-4 font-heading text-[22px] font-semibold ${
                        active ? "bg-brand-tint text-brand-dark" : "text-ink hover:bg-surface"
                      }`}
                    >
                      {item.label}
                      <ArrowRight className="size-5 opacity-50" aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="container-page space-y-3 border-t border-line py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <a href={page("/#register")} onClick={close} className="btn btn-primary w-full">
              Register Now
            </a>
            <a
              href={whatsappUrl()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackWhatsAppClick("mobile-menu")}
              className="btn btn-secondary w-full"
            >
              Talk on WhatsApp
            </a>
          </div>
        </div>
      )}
    </>
  );
}

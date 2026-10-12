import { LogoMark } from "@/components/brand/Logo";
import { page } from "@/lib/links";
import { mapsUrl, PAGE3_HREF, socialLinks, whatsappUrl } from "@/lib/content/helpers";
import type { SiteContent } from "@/lib/content/types";

/** Quiet white footer: mark on the left, link columns, small legal row. */
export function Footer({ content }: { content: SiteContent }) {
  const year = new Date().getFullYear();
  const c = content.contact;
  const columns: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
    {
      title: "UniBee",
      links: [
        { label: "Home", href: page("/") },
        { label: "Our Services", href: page("/services") },
        { label: content.general.page3Name, href: page(PAGE3_HREF) },
        { label: "Register", href: page("/#register") },
      ],
    },
    {
      title: "Contact",
      links: [
        { label: c.phoneDisplay, href: `tel:${c.phone}` },
        { label: "WhatsApp", href: whatsappUrl(content), external: true },
        { label: c.email, href: `mailto:${c.email}` },
        { label: "Office location", href: mapsUrl(content), external: true },
      ],
    },
    {
      title: "Follow",
      links: socialLinks(content).map((s) => ({ label: s.label, href: s.url, external: true })),
    },
  ];

  return (
    <footer className="border-t border-line bg-white">
      <div className="container-page grid gap-10 py-14 md:grid-cols-[1fr_auto] md:py-16">
        <div className="flex flex-col gap-4">
          <a href={page("/")} aria-label="UniBee home" className="inline-flex w-fit items-center gap-3">
            <LogoMark className="h-7 w-auto text-brand" />
            <span className="sr-only">UniBee</span>
          </a>
          <p className="max-w-[260px] text-[14px] leading-relaxed text-muted">{content.general.footerBlurb}</p>
          <p className="text-[13px] text-faint">{c.hours}</p>
        </div>

        <div className="grid grid-cols-2 gap-x-10 gap-y-10 sm:grid-cols-3 md:gap-x-20">
          {columns.map((col) => (
            <nav key={col.title} aria-label={`Footer: ${col.title}`}>
              <h2 className="text-[13px] font-medium text-ink">{col.title}</h2>
              <ul className="mt-4 space-y-2.5 text-[14px]">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="break-words text-muted transition-colors hover:text-ink"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="container-page flex flex-col gap-4 border-t border-line py-6 text-[13px] text-faint sm:flex-row sm:items-center sm:justify-between">
        <p>© {year} UniBee. All rights reserved.</p>
        <div className="flex items-center gap-5">
          <a href={page("/privacy")} className="hover:text-ink">
            Privacy Policy
          </a>
        </div>
      </div>
    </footer>
  );
}

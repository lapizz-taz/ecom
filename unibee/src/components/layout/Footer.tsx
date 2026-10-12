import { LogoMark, Logo } from "@/components/brand/Logo";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { mapsUrl, site, whatsappUrl } from "@/content/site";
import { page } from "@/lib/links";
import { socialLinks } from "@/components/layout/social-links";

/** Quiet white footer: mark on the left, link columns, small legal row. */
export function Footer() {
  const year = new Date().getFullYear();
  const c = site.contact;
  const columns: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
    {
      title: "UniBee",
      links: [
        { label: "Home", href: page("/") },
        { label: "Our Services", href: page("/services") },
        { label: site.page3.name, href: page(site.page3.href) },
        { label: "Register", href: page("/#register") },
      ],
    },
    {
      title: "Contact",
      links: [
        { label: c.phoneDisplay, href: `tel:${c.phone}` },
        { label: "WhatsApp", href: whatsappUrl(), external: true },
        { label: c.email, href: `mailto:${c.email}` },
        { label: "Office location", href: mapsUrl, external: true },
      ],
    },
    {
      title: "Follow",
      links: socialLinks().map((s) => ({ label: s.label, href: s.url, external: true })),
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
          <p className="max-w-[260px] text-[14px] leading-relaxed text-muted">{site.footerBlurb}</p>
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
        <div className="flex items-center gap-4">
          <Logo className="h-4 w-auto text-faint" title="UniBee" />
          <p>© {year} UniBee. All rights reserved.</p>
        </div>
        <div className="flex items-center gap-5">
          <a href={page("/privacy")} className="hover:text-ink">
            Privacy Policy
          </a>
          <ul className="flex items-center gap-1">
            {socialLinks()
              .filter((s) => s.network !== "whatsapp")
              .map((s) => (
                <li key={s.network}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`UniBee on ${s.label} (opens in a new tab)`}
                    className="grid size-9 place-items-center rounded-full text-faint transition hover:bg-surface hover:text-ink"
                  >
                    <SocialIcon network={s.network} className="size-4" />
                  </a>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}

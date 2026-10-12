import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { mapsUrl, site, whatsappUrl } from "@/content/site";
import { page } from "@/lib/links";
import { socialLinks } from "@/components/layout/social-links";

export function Footer() {
  const year = new Date().getFullYear();
  const c = site.contact;
  const quick = [
    { label: "Home", href: "/" },
    { label: "Our Services", href: "/services" },
    { label: site.page3.name, href: site.page3.href },
    { label: "Register", href: "/#register" },
  ];

  return (
    // Footer uses the darker brand red so small white text meets WCAG AA contrast.
    <footer className="bg-brand-dark text-white">
      <div className="container-page grid gap-10 py-14 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1.4fr_1fr] lg:gap-12 lg:py-16">
        <div>
          <a href={page("/")} aria-label="UniBee home" className="inline-block">
            <Logo className="h-9 w-auto text-white" />
          </a>
          <p className="mt-4 max-w-xs text-[15px] leading-relaxed text-white">{site.footerBlurb}</p>
        </div>

        <nav aria-label="Footer">
          <h2 className="font-heading text-[15px] font-semibold tracking-wide text-white">Quick links</h2>
          <ul className="mt-4 space-y-2.5 text-[15px]">
            {quick.map((l) => (
              <li key={l.href}>
                <a href={page(l.href)} className="text-white underline-offset-4 hover:text-white hover:underline">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className="font-heading text-[15px] font-semibold tracking-wide text-white">Contact</h2>
          <ul className="mt-4 space-y-3 text-[15px] text-white">
            <li>
              <a href={`tel:${c.phone}`} className="flex gap-3 hover:text-white">
                <Phone className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {c.phoneDisplay}
              </a>
            </li>
            <li>
              <a href={whatsappUrl()} target="_blank" rel="noopener noreferrer" className="flex gap-3 hover:text-white">
                <SocialIcon network="whatsapp" className="mt-0.5 size-4 shrink-0" /> {c.whatsappDisplay} (WhatsApp)
              </a>
            </li>
            <li>
              <a href={`mailto:${c.email}`} className="flex gap-3 break-all hover:text-white">
                <Mail className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {c.email}
              </a>
            </li>
            <li>
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex gap-3 hover:text-white">
                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {c.address}
              </a>
            </li>
            <li className="flex gap-3">
              <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {c.hours}
            </li>
          </ul>
        </div>

        <div>
          <h2 className="font-heading text-[15px] font-semibold tracking-wide text-white">Follow us</h2>
          <ul className="mt-4 flex flex-wrap gap-2.5">
            {socialLinks().map((s) => (
              <li key={s.network}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`UniBee on ${s.label} (opens in a new tab)`}
                  className="grid size-11 place-items-center rounded-full bg-white/12 ring-1 ring-white/25 transition hover:-translate-y-0.5 hover:bg-white hover:text-brand-dark"
                >
                  <SocialIcon network={s.network} className="size-[18px]" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t border-white/20">
        <div className="container-page flex flex-col gap-2 py-5 text-[14px] text-white sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} UniBee. All rights reserved.</p>
          <a href={page("/privacy")} className="underline-offset-4 hover:text-white hover:underline">
            Privacy Policy
          </a>
        </div>
      </div>
    </footer>
  );
}

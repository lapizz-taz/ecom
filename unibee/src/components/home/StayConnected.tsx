import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { Placeholder } from "@/components/ui/Placeholder";
import { Reveal } from "@/components/ui/Reveal";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { MapEmbed } from "@/components/home/MapEmbed";
import { socialLinks } from "@/components/layout/social-links";
import { isPlaceholder, mapsUrl, site } from "@/content/site";

function Row({ label, value, action }: { label: string; value: ReactNode; action?: boolean }) {
  return (
    <span className="group grid min-h-14 grid-cols-[96px_1fr_auto] items-center gap-4 py-4 sm:grid-cols-[140px_1fr_auto]">
      <span className="text-[14px] text-muted">{label}</span>
      <span className="min-w-0 text-[15px] break-words text-ink">{value}</span>
      {action ? <ArrowUpRight className="size-4 text-faint transition group-hover:text-ink" aria-hidden="true" /> : <span />}
    </span>
  );
}

export function StayConnected() {
  const c = site.contact;
  const contactPlaceholder = [c.phone, c.whatsapp, c.email, c.address].some(isPlaceholder);

  return (
    <section id="contact" aria-labelledby="contact-title" className="section scroll-mt-16 border-t border-line bg-white">
      <div className="container-page">
        <SectionIntro
          id="contact-title"
          title="Stay Connected"
          text="Follow us for intake news, student stories and visa updates, or reach our team directly."
          badge={contactPlaceholder ? <Placeholder label="Contact details" /> : null}
        />

        <div className="mt-12 grid gap-10 md:mt-16 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <ul className="divide-y divide-line border-y border-line">
              <li>
                <a href={`tel:${c.phone}`}>
                  <Row label="Phone" value={c.phoneDisplay} action />
                </a>
              </li>
              <li>
                <WhatsAppLink location="contact-card">
                  <Row label="WhatsApp" value={c.whatsappDisplay} action />
                </WhatsAppLink>
              </li>
              <li>
                <a href={`mailto:${c.email}`}>
                  <Row label="Email" value={c.email} action />
                </a>
              </li>
              <li>
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                  <Row label="Office" value={c.address} action />
                </a>
              </li>
              <li>
                <Row label="Hours" value={c.hours} />
              </li>
            </ul>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-1" aria-label="Social media">
              {socialLinks().map((s) => (
                <li key={s.network}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-[15px] text-muted underline-offset-4 transition hover:text-ink hover:underline"
                  >
                    {s.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal className="min-h-[320px] overflow-hidden rounded-[var(--radius-frame)] bg-surface">
            <MapEmbed />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

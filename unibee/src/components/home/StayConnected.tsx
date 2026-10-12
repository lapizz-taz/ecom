import { ArrowUpRight, Clock, Mail, MapPin, Phone } from "lucide-react";
import type { ReactNode } from "react";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { Placeholder } from "@/components/ui/Placeholder";
import { Reveal } from "@/components/ui/Reveal";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { MapEmbed } from "@/components/home/MapEmbed";
import { socialLinks } from "@/components/layout/social-links";
import { isPlaceholder, mapsUrl, site } from "@/content/site";

function Row({ icon, label, value, action }: { icon: ReactNode; label: string; value: string; action?: boolean }) {
  return (
    <span className="group flex min-h-[72px] items-center gap-4 py-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-ink-soft transition group-hover:bg-brand-tint group-hover:text-brand-dark">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-muted">{label}</span>
        <span className="block text-[16px] font-medium break-words text-ink">{value}</span>
      </span>
      {action && <ArrowUpRight className="size-4 shrink-0 text-faint transition group-hover:text-ink" aria-hidden="true" />}
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
          label="2.0  Contact"
          badge={contactPlaceholder ? <Placeholder label="Contact details" /> : null}
        />

        <Reveal as="ul" className="mt-10 flex flex-wrap gap-2" aria-label="Social media">
          {socialLinks().map((s) => (
            <li key={s.network}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center gap-2.5 rounded-full bg-surface px-4 text-[14px] font-medium text-ink-soft transition hover:bg-surface-2 hover:text-ink"
              >
                <SocialIcon network={s.network} className="size-[18px]" />
                {s.label}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </Reveal>

        <div className="mt-12 grid gap-8 lg:grid-cols-2 lg:gap-12">
          <Reveal as="ul" className="divide-y divide-line border-y border-line">
            <li>
              <a href={`tel:${c.phone}`}>
                <Row icon={<Phone className="size-4" aria-hidden="true" />} label="Call us" value={c.phoneDisplay} action />
              </a>
            </li>
            <li>
              <WhatsAppLink location="contact-card">
                <Row icon={<SocialIcon network="whatsapp" className="size-4" />} label="WhatsApp" value={c.whatsappDisplay} action />
              </WhatsAppLink>
            </li>
            <li>
              <a href={`mailto:${c.email}`}>
                <Row icon={<Mail className="size-4" aria-hidden="true" />} label="Email" value={c.email} action />
              </a>
            </li>
            <li>
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                <Row icon={<MapPin className="size-4" aria-hidden="true" />} label="Office address" value={c.address} action />
              </a>
            </li>
            <li>
              <Row icon={<Clock className="size-4" aria-hidden="true" />} label="Office hours" value={c.hours} />
            </li>
          </Reveal>

          <Reveal className="frame min-h-[320px] bg-surface">
            <MapEmbed />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

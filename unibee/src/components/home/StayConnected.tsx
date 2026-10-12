import { ArrowUpRight, Clock, Mail, MapPin, Phone } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { Placeholder } from "@/components/ui/Placeholder";
import { Reveal } from "@/components/ui/Reveal";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { MapEmbed } from "@/components/home/MapEmbed";
import { socialLinks } from "@/components/layout/social-links";
import { isPlaceholder, mapsUrl, site } from "@/content/site";

export function StayConnected() {
  const c = site.contact;
  const contactPlaceholder = [c.phone, c.whatsapp, c.email, c.address].some(isPlaceholder);

  const cardCls = "card card-hover group flex h-full min-h-[84px] items-center gap-4 p-4 sm:p-5";
  const iconCls = "grid size-12 shrink-0 place-items-center rounded-full bg-brand-tint text-brand-dark";
  const Text = ({ label, value }: { label: string; value: string }) => (
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] font-medium text-muted">{label}</span>
      <span className="block text-[16px] font-semibold break-words text-ink">{value}</span>
    </span>
  );
  const Arrow = () => <ArrowUpRight className="size-5 shrink-0 text-muted transition group-hover:text-brand-dark" aria-hidden="true" />;

  return (
    <section id="contact" aria-labelledby="contact-title" className="section scroll-mt-16 bg-white">
      <div className="container-page">
        <SectionHeading
          id="contact-title"
          eyebrow="Contact"
          title="Stay Connected"
          subtitle="Follow us for intake news, student stories and visa updates, or reach our team directly."
          badge={contactPlaceholder ? <Placeholder label="Contact details" className="ml-1" /> : null}
        />

        <Reveal as="ul" className="mx-auto mt-10 flex max-w-[720px] flex-wrap justify-center gap-3" aria-label="Social media">
          {socialLinks().map((s) => (
            <li key={s.network}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-h-14 items-center gap-2.5 rounded-full border border-line bg-white py-2 pr-5 pl-2 text-[15px] font-semibold text-ink-soft transition hover:-translate-y-0.5 hover:border-transparent hover:text-ink hover:shadow-[var(--shadow-card-hover)]"
              >
                <span className="grid size-10 place-items-center rounded-full bg-surface text-ink transition group-hover:bg-brand group-hover:text-white">
                  <SocialIcon network={s.network} className="size-5" />
                </span>
                {s.label}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </Reveal>

        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-8">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <Reveal as="li">
              <a href={`tel:${c.phone}`} className={cardCls}>
                <span className={iconCls}><Phone className="size-5" aria-hidden="true" /></span>
                <Text label="Call us" value={c.phoneDisplay} />
                <Arrow />
              </a>
            </Reveal>
            <Reveal as="li" delay={60}>
              <WhatsAppLink location="contact-card" className={cardCls}>
                <span className="grid size-12 shrink-0 place-items-center rounded-full bg-whatsapp/12 text-whatsapp-dark"><SocialIcon network="whatsapp" className="size-5" /></span>
                <Text label="WhatsApp" value={c.whatsappDisplay} />
                <Arrow />
              </WhatsAppLink>
            </Reveal>
            <Reveal as="li" delay={120}>
              <a href={`mailto:${c.email}`} className={cardCls}>
                <span className={iconCls}><Mail className="size-5" aria-hidden="true" /></span>
                <Text label="Email" value={c.email} />
                <Arrow />
              </a>
            </Reveal>
            <Reveal as="li" delay={180}>
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={cardCls}>
                <span className={iconCls}><MapPin className="size-5" aria-hidden="true" /></span>
                <Text label="Office address" value={c.address} />
                <Arrow />
              </a>
            </Reveal>
            <Reveal as="li" delay={240} className="sm:col-span-2 lg:col-span-1">
              <div className="flex min-h-[84px] items-center gap-4 rounded-[var(--radius-card)] border border-dashed border-line-strong p-4 sm:p-5">
                <span className="grid size-12 shrink-0 place-items-center rounded-full bg-surface text-ink-soft"><Clock className="size-5" aria-hidden="true" /></span>
                <Text label="Office hours" value={c.hours} />
              </div>
            </Reveal>
          </ul>

          <Reveal className="min-h-[320px] overflow-hidden rounded-[var(--radius-frame)] bg-surface lg:min-h-full" style={{ boxShadow: "var(--shadow-card)" }}>
            <MapEmbed />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

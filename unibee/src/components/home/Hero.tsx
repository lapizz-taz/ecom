import { getImageProps } from "next/image";
import { ArrowRight, Check } from "lucide-react";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { Placeholder } from "@/components/ui/Placeholder";
import { Flag } from "@/components/ui/Flag";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { site } from "@/content/site";
import { asset, page } from "@/lib/links";

/**
 * Cover photo with art direction: a portrait crop on phones, the wide shot on desktop.
 * REPLACE: put your photos in /public/images (hero-mobile.webp ≈ 800×1000, hero-desktop.webp ≈ 2000×900),
 * then set `placeholder: false`.
 */
const HERO = {
  mobile: { src: "/images/hero-mobile.webp", width: 640, height: 750 },
  desktop: { src: "/images/hero-desktop.webp", width: 2000, height: 750 },
  alt: "Sunrise over Vilnius old town, Lithuania, with a hot-air balloon above the rooftops",
  placeholder: true,
};

const trust = ["Free profile assessment", "Fast response", "Trusted by students across Bangladesh"];

/** Illustrative progress card shown on the photo (an example, not a real student). */
const exampleSteps = [
  { label: "Profile assessed", meta: "Day 1", state: "done" },
  { label: "Documents checked", meta: "Week 2", state: "done" },
  { label: "Application submitted", meta: "Week 3", state: "done" },
  { label: "Offer letter", meta: "In progress", state: "active" },
  { label: "Visa / TRP file", meta: "Next", state: "todo" },
] as const;

export function Hero() {
  const common = { alt: HERO.alt, sizes: "(min-width: 1200px) 1136px, 100vw", priority: true, quality: 75 } as const;
  const {
    props: { srcSet: desktopSet },
  } = getImageProps({ ...common, ...HERO.desktop, src: asset(HERO.desktop.src) });
  const {
    props: { srcSet: mobileSet, ...img },
  } = getImageProps({ ...common, ...HERO.mobile, src: asset(HERO.mobile.src) });

  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden bg-white">
      <div className="container-page pt-12 pb-10 md:pt-24 md:pb-16 lg:pt-28">
        <h1 id="hero-title" className="h1 max-w-[820px]">
          Study in Lithuania <br className="hidden sm:block" />
          with UniBee
        </h1>

        <div className="mt-5 flex flex-col gap-6 md:mt-7 md:flex-row md:items-end md:justify-between">
          <p className="max-w-[560px] text-[17px] leading-[1.55] text-muted md:text-[19px]">
            From choosing the right university to getting your visa, we handle your full journey to Europe.
          </p>
          {site.announcement.text && (
            <a href={page("/#register")} className="group hidden shrink-0 items-center gap-2 text-[14px] md:inline-flex">
              <span className="font-medium text-ink">New</span>
              <span className="text-muted transition-colors group-hover:text-ink">{site.announcement.text}</span>
              <ArrowRight className="size-3.5 text-muted" aria-hidden="true" />
            </a>
          )}
        </div>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <a href={page("/#register")} className="btn btn-primary min-h-12 w-full px-6 sm:w-auto">
            Register Now <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <WhatsAppLink location="hero" className="btn btn-secondary min-h-12 w-full px-6 sm:w-auto">
            <SocialIcon network="whatsapp" className="size-4" /> Talk on WhatsApp
          </WhatsAppLink>
        </div>

        <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-muted">
          {trust.map((t, i) => (
            <li key={t} className="flex items-center gap-2">
              {i > 0 && <span className="hidden size-1 rounded-full bg-line-strong sm:block" aria-hidden="true" />}
              {t}
            </li>
          ))}
        </ul>
      </div>

      {/* Framed photo panel with an example progress card, fading into the page */}
      <div className="container-page pb-4">
        <div className="relative">
          <div className="frame relative aspect-[4/3] sm:aspect-[16/8] lg:aspect-[16/7]">
            <picture>
              <source media="(min-width: 640px)" srcSet={desktopSet} />
              <source media="(max-width: 639px)" srcSet={mobileSet} />
              {/* eslint-disable-next-line jsx-a11y/alt-text */}
              <img {...img} className="absolute inset-0 size-full object-cover object-[50%_30%]" fetchPriority="high" />
            </picture>
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 text-[12px] font-medium text-ink backdrop-blur">
              <Flag country="bd" /> Dhaka <ArrowRight className="size-3 text-muted" aria-hidden="true" /> <Flag country="lt" /> Vilnius
            </div>
            {HERO.placeholder && (
              <div className="absolute top-12 left-3 sm:top-3 sm:right-3 sm:left-auto">
                <Placeholder label="Placeholder photo" />
              </div>
            )}
          </div>

          <div
            className="relative mx-3 -mt-24 rounded-[var(--radius-card)] bg-white/95 p-4 backdrop-blur sm:absolute sm:bottom-6 sm:left-6 sm:mx-0 sm:mt-0 sm:w-[340px]"
            style={{ boxShadow: "var(--shadow-float)" }}
            aria-label="Example of how an application progresses"
            role="figure"
          >
            <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">Application · Vilnius University</p>
                <p className="font-mono text-[11px] text-faint">Example timeline</p>
              </div>
              <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">On track</span>
            </div>
            <ol className="mt-3 space-y-2.5">
              {exampleSteps.map((s) => (
                <li key={s.label} className="flex items-center gap-3 text-[13px]">
                  {s.state === "done" ? (
                    <span className="grid size-4 shrink-0 place-items-center rounded-full bg-ink text-white">
                      <Check className="size-2.5" strokeWidth={3.5} aria-hidden="true" />
                    </span>
                  ) : s.state === "active" ? (
                    <span className="grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-brand">
                      <span className="size-1.5 rounded-full bg-brand" />
                    </span>
                  ) : (
                    <span className="size-4 shrink-0 rounded-full ring-1 ring-line-strong" />
                  )}
                  <span className={s.state === "todo" ? "text-faint" : "text-ink"}>{s.label}</span>
                  <span className={`ml-auto font-mono text-[11px] ${s.state === "active" ? "text-brand-dark" : "text-faint"}`}>{s.meta}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

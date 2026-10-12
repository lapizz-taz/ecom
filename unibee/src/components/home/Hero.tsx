import { getImageProps } from "next/image";
import { ArrowRight } from "lucide-react";
import { Placeholder } from "@/components/ui/Placeholder";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { asset, page } from "@/lib/links";
import type { SiteContent } from "@/lib/content/types";

/**
 * Full-width cover photo with the headline on top. Text and photos come from the CMS (Home hero).
 * Art direction: a portrait crop on phones, the wide shot on larger screens.
 * Built-in photos (paths in /public) are resized by Next.js; uploaded photos are used as-is.
 */
/** Uploaded images (Supabase URL, or /media/ locally) are served as-is. */
const isUploaded = (src: string) => /^https?:\/\//.test(src) || src.startsWith("/media/");

function heroSources(src: string, width: number, height: number, alt: string) {
  const { props } = getImageProps({
    src: isUploaded(src) ? src : asset(src),
    width,
    height,
    alt,
    sizes: "100vw",
    priority: true,
    quality: 75,
    unoptimized: isUploaded(src),
  });
  return props;
}

export function Hero({ hero, announcement }: { hero: SiteContent["hero"]; announcement?: SiteContent["general"]["announcement"] }) {
  const { srcSet: desktopSet, src: desktopSrc } = heroSources(hero.imageDesktop, 2000, 750, hero.imageAlt);
  const { srcSet: mobileSet, src: mobileSrc, ...img } = heroSources(hero.imageMobile, 640, 750, hero.imageAlt);

  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-night text-white">
      <picture>
        <source media="(min-width: 768px)" srcSet={desktopSet || desktopSrc} />
        <source media="(max-width: 767px)" srcSet={mobileSet || mobileSrc} />
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img {...img} src={mobileSrc} className="absolute inset-0 -z-20 size-full object-cover object-[50%_35%]" fetchPriority="high" />
      </picture>
      {/* Dark fade (black → transparent) keeps the white text readable */}
      <div
        className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/40 to-black/10 md:bg-gradient-to-r md:from-black/65 md:via-black/30 md:to-transparent"
        aria-hidden="true"
      />

      {hero.placeholder && (
        <div className="absolute top-4 right-4 rounded-full bg-white/90 px-2.5 py-1">
          <Placeholder label="Placeholder photo" />
        </div>
      )}

      <div className="container-page flex min-h-[calc(100svh-64px)] flex-col justify-end pt-24 pb-24 md:min-h-[620px] md:justify-center md:py-28 lg:min-h-[680px]">
        <div className="max-w-[620px]">
          {announcement?.text && (
            <a
              href={page("/#register")}
              className="mb-5 inline-flex max-w-full items-center gap-2 rounded-full bg-white/15 py-1 pr-3 pl-1 text-[13px] text-white ring-1 ring-white/25 backdrop-blur-sm transition hover:bg-white/25"
            >
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-ink">New</span>
              <span className="truncate">{announcement.text}</span>
              {announcement.linkText && <span className="hidden shrink-0 font-medium sm:inline">{announcement.linkText} →</span>}
            </a>
          )}
          <h1 id="hero-title" className="h1 text-white">
            {hero.title}
          </h1>
          <p className="mt-5 max-w-[500px] text-[17px] leading-[1.55] text-white/85 md:text-[18px]">
            {hero.subtitle}
          </p>

          <div className="mt-8 flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <a href={page("/#register")} className="btn btn-primary min-h-12 w-full px-6 sm:w-auto">
              Register Now <ArrowRight className="size-4" aria-hidden="true" />
            </a>
            <WhatsAppLink
              location="hero"
              className="btn min-h-12 w-full bg-white/15 px-6 text-white ring-1 ring-white/30 backdrop-blur-sm hover:bg-white/25 sm:w-auto"
            >
              Talk on WhatsApp
            </WhatsAppLink>
          </div>

          {hero.trustLine && <p className="mt-6 text-[13px] text-white/80">{hero.trustLine}</p>}
        </div>
      </div>
    </section>
  );
}

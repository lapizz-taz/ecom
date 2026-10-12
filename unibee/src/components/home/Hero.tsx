import { getImageProps } from "next/image";
import { ArrowRight } from "lucide-react";
import { Placeholder } from "@/components/ui/Placeholder";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
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

export function Hero() {
  const common = { alt: HERO.alt, sizes: "(min-width: 1200px) 1136px, 100vw", priority: true, quality: 75 } as const;
  const {
    props: { srcSet: desktopSet },
  } = getImageProps({ ...common, ...HERO.desktop, src: asset(HERO.desktop.src) });
  const {
    props: { srcSet: mobileSet, ...img },
  } = getImageProps({ ...common, ...HERO.mobile, src: asset(HERO.mobile.src) });

  return (
    <section aria-labelledby="hero-title" className="bg-white">
      <div className="container-page pt-14 pb-12 md:pt-28 md:pb-20">
        <h1 id="hero-title" className="h1 max-w-[760px]">
          Study in Lithuania <br className="hidden sm:block" />
          with UniBee
        </h1>
        <p className="mt-5 max-w-[520px] text-[17px] leading-[1.55] text-muted md:text-[18px]">
          From choosing the right university to getting your visa, we handle your full journey to Europe.
        </p>

        <div className="mt-8 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <a href={page("/#register")} className="btn btn-primary min-h-12 w-full px-6 sm:w-auto">
            Register Now <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <WhatsAppLink location="hero" className="btn btn-secondary min-h-12 w-full px-6 sm:w-auto">
            Talk on WhatsApp
          </WhatsAppLink>
        </div>

        <p className="mt-6 text-[13px] text-faint">Free profile assessment · Fast response · Trusted by students across Bangladesh</p>
      </div>

      <div className="container-page">
        <div className="relative aspect-[4/3] overflow-hidden rounded-[var(--radius-frame)] bg-surface sm:aspect-[16/8] lg:aspect-[16/7]">
          <picture>
            <source media="(min-width: 640px)" srcSet={desktopSet} />
            <source media="(max-width: 639px)" srcSet={mobileSet} />
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <img {...img} className="absolute inset-0 size-full object-cover object-[50%_30%]" fetchPriority="high" />
          </picture>
          {HERO.placeholder && (
            <div className="absolute top-3 right-3 rounded-full bg-white/90 px-2.5 py-1">
              <Placeholder label="Placeholder photo" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

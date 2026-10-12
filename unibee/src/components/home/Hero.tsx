import { getImageProps } from "next/image";
import { ArrowRight } from "lucide-react";
import { Placeholder } from "@/components/ui/Placeholder";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { asset, page } from "@/lib/links";

/**
 * Full-width cover photo with the headline on top.
 * Art direction: a portrait crop on phones, the wide shot on larger screens.
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
  const common = { alt: HERO.alt, sizes: "100vw", priority: true, quality: 75 } as const;
  const {
    props: { srcSet: desktopSet },
  } = getImageProps({ ...common, ...HERO.desktop, src: asset(HERO.desktop.src) });
  const {
    props: { srcSet: mobileSet, ...img },
  } = getImageProps({ ...common, ...HERO.mobile, src: asset(HERO.mobile.src) });

  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-night text-white">
      <picture>
        <source media="(min-width: 768px)" srcSet={desktopSet} />
        <source media="(max-width: 767px)" srcSet={mobileSet} />
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img {...img} className="absolute inset-0 -z-20 size-full object-cover object-[50%_35%]" fetchPriority="high" />
      </picture>
      {/* Dark fade (black → transparent) keeps the white text readable */}
      <div
        className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/40 to-black/10 md:bg-gradient-to-r md:from-black/65 md:via-black/30 md:to-transparent"
        aria-hidden="true"
      />

      {HERO.placeholder && (
        <div className="absolute top-4 right-4 rounded-full bg-white/90 px-2.5 py-1">
          <Placeholder label="Placeholder photo" />
        </div>
      )}

      <div className="container-page flex min-h-[calc(100svh-64px)] flex-col justify-end pt-24 pb-24 md:min-h-[620px] md:justify-center md:py-28 lg:min-h-[680px]">
        <div className="max-w-[620px]">
          <h1 id="hero-title" className="h1 text-white">
            Study in Lithuania <br className="hidden sm:block" />
            with UniBee
          </h1>
          <p className="mt-5 max-w-[500px] text-[17px] leading-[1.55] text-white/85 md:text-[18px]">
            From choosing the right university to getting your visa, we handle your full journey to Europe.
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

          <p className="mt-6 text-[13px] text-white/80">Free profile assessment · Fast response · Trusted by students across Bangladesh</p>
        </div>
      </div>
    </section>
  );
}

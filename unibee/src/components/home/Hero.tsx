import { getImageProps } from "next/image";
import { ArrowRight, BadgeCheck, Users, Zap } from "lucide-react";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { Placeholder } from "@/components/ui/Placeholder";
import { Flag } from "@/components/ui/Flag";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { asset, page } from "@/lib/links";

/**
 * Cover photo with art direction: a portrait crop on phones, the wide shot on desktop.
 * REPLACE: put your photos in /public/images (hero-mobile.webp ≈ 800×1000, hero-desktop.webp ≈ 2000×900).
 */
const HERO = {
  mobile: { src: "/images/hero-mobile.webp", width: 640, height: 750 },
  desktop: { src: "/images/hero-desktop.webp", width: 2000, height: 750 },
  alt: "Sunrise over Vilnius old town, Lithuania, with a hot-air balloon above the rooftops",
  placeholder: true,
};

const trust = [
  { icon: BadgeCheck, text: "Free profile assessment" },
  { icon: Zap, text: "Fast response" },
  { icon: Users, text: "Trusted by students across Bangladesh" },
];

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
      {/* Dark gradient (black 50% → transparent) keeps white text readable */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/50 to-black/15 md:bg-gradient-to-r md:from-black/70 md:via-black/45 md:to-black/0" aria-hidden="true" />

      {HERO.placeholder && (
        <div className="absolute top-3 right-3 z-10">
          <Placeholder label="Placeholder photo" />
        </div>
      )}

      <div className="container-page flex min-h-[calc(100svh-64px)] flex-col justify-end pt-24 pb-24 md:min-h-[600px] md:justify-center md:py-24 lg:min-h-[680px]">
        <div className="max-w-[640px]">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[13px] font-medium backdrop-blur-sm">
            <Flag country="bd" /> Bangladesh <ArrowRight className="size-3.5" aria-hidden="true" /> <Flag country="lt" /> Lithuania
          </p>
          <h1 id="hero-title" className="h1 text-white">
            Study in Lithuania <span className="whitespace-nowrap">with UniBee</span>
          </h1>
          <p className="mt-4 max-w-[540px] text-[17px] leading-relaxed text-white/90 md:mt-5 md:text-xl">
            From choosing the right university to getting your visa, we handle your full journey to Europe.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a href={page("/#register")} className="btn btn-primary w-full sm:w-auto sm:px-8">
              Register Now <ArrowRight className="size-5" aria-hidden="true" />
            </a>
            <WhatsAppLink location="hero" className="btn btn-ghost-light w-full sm:w-auto">
              <SocialIcon network="whatsapp" className="size-5" /> Talk on WhatsApp
            </WhatsAppLink>
          </div>

          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[14px] text-white/90">
            {trust.map(({ icon: I, text }) => (
              <li key={text} className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-md bg-white/15">
                  <I className="size-3.5" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

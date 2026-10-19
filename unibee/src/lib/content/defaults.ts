/**
 * Starting content for the site, built from the files in src/content/.
 * Used until something is saved in the CMS, and as the fallback for any
 * field the CMS hasn't filled in.
 */
import { site } from "@/content/site";
import { universities } from "@/content/universities";
import { services, servicesPlaceholder } from "@/content/services";
import { documentsNeeded, processPlaceholder, processSteps } from "@/content/process";
import { englishPrep } from "@/content/english-prep";
import { about } from "@/content/about";
import type { SiteContent } from "./types";

export const defaultContent: SiteContent = {
  general: {
    name: site.name,
    tagline: site.tagline,
    description: site.description,
    footerBlurb: site.footerBlurb,
    page3Name: site.page3.name,
    announcement: { ...site.announcement },
    showPlaceholderBadges: site.showPlaceholderBadges,
  },
  contact: { ...site.contact },
  socials: site.socials.map((s) => ({ network: s.network, label: s.label, url: s.url })),
  hero: {
    title: "Study in Lithuania with UniBee",
    subtitle: "From choosing the right university to getting your visa, we handle your full journey to Europe.",
    trustLine: "Free profile assessment · Fast response · Trusted by students across Bangladesh",
    imageDesktop: "/images/hero-desktop.webp",
    imageMobile: "/images/hero-mobile.webp",
    imageAlt: "Sunrise over Vilnius old town, Lithuania, with a hot-air balloon above the rooftops",
    placeholder: true,
  },
  about: JSON.parse(JSON.stringify(about)),
  universities: universities.map((u) => ({ ...u, placeholder: Boolean(u.placeholder) })),
  services: { items: services.map((s) => ({ ...s })), placeholder: servicesPlaceholder },
  process: { steps: processSteps.map((s) => ({ ...s })), documents: [...documentsNeeded], placeholder: processPlaceholder },
  englishPrep: JSON.parse(JSON.stringify(englishPrep)),
};

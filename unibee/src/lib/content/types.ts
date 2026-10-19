/**
 * The full set of editable website content. The CMS (/admin/content) edits
 * exactly this shape; the site reads it on every page.
 */
export type SocialNetwork = "facebook" | "instagram" | "youtube" | "tiktok" | "whatsapp" | "linkedin";

export type University = {
  slug: string;
  name: string;
  shortName: string;
  city: string;
  /** Uploaded logo URL or a path in /public. "" = text only. */
  logo: string;
  color: string;
  about: string;
  programs: { bachelor: string[]; master: string[] };
  tuition: string;
  intakes: string[];
  requirements: { academic: string; english: string };
  deadline: string;
  website: string;
  placeholder: boolean;
};

export type SiteContent = {
  general: {
    name: string;
    tagline: string;
    /** Used for search results and link previews. */
    description: string;
    footerBlurb: string;
    page3Name: string;
    announcement: { text: string; linkText: string };
    showPlaceholderBadges: boolean;
  };
  contact: {
    phone: string;
    phoneDisplay: string;
    whatsapp: string;
    whatsappDisplay: string;
    whatsappMessage: string;
    email: string;
    address: string;
    mapsQuery: string;
    hours: string;
  };
  socials: { network: SocialNetwork; label: string; url: string }[];
  hero: {
    title: string;
    subtitle: string;
    trustLine: string;
    imageDesktop: string;
    imageMobile: string;
    imageAlt: string;
    placeholder: boolean;
  };
  about: {
    placeholder: boolean;
    title: string;
    intro: string;
    story: string;
    mission: string;
    whatWeDo: { title: string; text: string }[];
    values: { title: string; text: string }[];
  };
  universities: University[];
  services: { items: { icon: string; title: string; description: string }[]; placeholder: boolean };
  process: { steps: { icon: string; title: string; text: string; time: string }[]; documents: string[]; placeholder: boolean };
  englishPrep: {
    placeholder: boolean;
    title: string;
    subtitle: string;
    learn: { icon: string; title: string; text: string }[];
    format: { icon: string; label: string; value: string }[];
    instructor: {
      name: string;
      role: string;
      photo: string;
      bio: string;
      qualifications: string[];
      stats: { value: string; label: string }[];
    };
    video: { youtube: string; title: string; caption: string };
  };
};

export const SOCIAL_NETWORKS: { network: SocialNetwork; label: string }[] = [
  { network: "facebook", label: "Facebook" },
  { network: "instagram", label: "Instagram" },
  { network: "youtube", label: "YouTube" },
  { network: "tiktok", label: "TikTok" },
  { network: "whatsapp", label: "WhatsApp" },
  { network: "linkedin", label: "LinkedIn" },
];

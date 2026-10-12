/**
 * ─────────────────────────────────────────────────────────────
 *  SITE SETTINGS: edit contact details, social links and names here.
 *  Anything marked REPLACE is a placeholder you still need to send.
 * ─────────────────────────────────────────────────────────────
 */

export const site = {
  name: "UniBee",
  tagline: "Buzz Beyond Borders",
  description:
    "UniBee helps Bangladeshi students get admission to universities in Lithuania, from choosing the right university to application, file processing and visa.",
  footerBlurb: "Your trusted partner for studying in Lithuania.",

  /**
   * While true, small "Placeholder" tags show next to content you haven't sent yet.
   * Set to false before launch (or remove `placeholder: true` from each item).
   */
  showPlaceholderBadges: true,

  contact: {
    // Phone for calls. Use international format without spaces, e.g. "+8801712345678".
    phone: "REPLACE_PHONE", // REPLACE
    phoneDisplay: "+880 1XXX-XXXXXX", // REPLACE: how the number is shown on the site
    // WhatsApp number, digits only with country code, e.g. "8801712345678".
    whatsapp: "REPLACE_NUMBER", // REPLACE
    whatsappDisplay: "+880 1XXX-XXXXXX", // REPLACE
    whatsappMessage: "Hi UniBee, I want to study in Lithuania.",
    email: "REPLACE@example.com", // REPLACE
    address: "REPLACE: Office address, Dhaka, Bangladesh", // REPLACE
    // What Google Maps should search for (address or business name).
    mapsQuery: "Dhaka, Bangladesh", // REPLACE with your office address
    hours: "Sat–Thu, 10 AM – 7 PM", // REPLACE / confirm
  },

  /** Social profiles. Remove a line to hide that icon. */
  socials: [
    { network: "facebook", label: "Facebook", url: "https://facebook.com/REPLACE" },
    { network: "instagram", label: "Instagram", url: "https://instagram.com/REPLACE" },
    { network: "youtube", label: "YouTube", url: "https://youtube.com/@REPLACE" },
    { network: "tiktok", label: "TikTok", url: "https://tiktok.com/@REPLACE" },
    { network: "whatsapp", label: "WhatsApp", url: "" }, // auto-filled from contact.whatsapp
    { network: "linkedin", label: "LinkedIn", url: "https://linkedin.com/company/REPLACE" }, // optional
  ] as const,

  /** Page 3: rename here and the menu, footer and page title all follow. */
  page3: { name: "English Prep", href: "/english-prep" },

  /** Intake announcement shown in the slim bar above the header. Set text to "" to hide. */
  announcement: {
    text: "Applications for the next September intake are open", // REPLACE / confirm
    linkText: "Register now",
  },
};

export type SocialNetwork = (typeof site.socials)[number]["network"];

export const nav = [
  { label: "Home", href: "/" },
  { label: "Our Services", href: "/services" },
  { label: site.page3.name, href: site.page3.href },
  { label: "Contact", href: "/#contact" },
];

/** Site URL used for SEO tags, sitemap and share images. */
export const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
  "http://localhost:3000"
).replace(/\/$/, "");

export const whatsappUrl = (message: string = site.contact.whatsappMessage) =>
  `https://wa.me/${site.contact.whatsapp}?text=${encodeURIComponent(message)}`;

export const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(site.contact.mapsQuery)}`;
export const mapsEmbedUrl = `https://www.google.com/maps?q=${encodeURIComponent(site.contact.mapsQuery)}&output=embed`;

export const isPlaceholder = (value: string) => /REPLACE/i.test(value);

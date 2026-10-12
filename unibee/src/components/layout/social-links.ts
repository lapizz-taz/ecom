import { site, whatsappUrl } from "@/content/site";

/** Social links from site.ts, with the WhatsApp link built from the contact number. */
export const socialLinks = () =>
  site.socials
    .map((s) => ({ ...s, url: s.network === "whatsapp" ? whatsappUrl() : s.url }))
    .filter((s) => s.url);

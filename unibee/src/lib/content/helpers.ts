/** Small helpers that derive links from the content (safe to use on server and client). */
import type { SiteContent } from "./types";

export const whatsappUrl = (c: SiteContent, message: string = c.contact.whatsappMessage) =>
  `https://wa.me/${c.contact.whatsapp}?text=${encodeURIComponent(message)}`;

export const mapsUrl = (c: SiteContent) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.contact.mapsQuery)}`;
export const mapsEmbedUrl = (c: SiteContent) => `https://www.google.com/maps?q=${encodeURIComponent(c.contact.mapsQuery)}&output=embed`;

/** Social links with a URL, WhatsApp filled in from the contact number. */
export const socialLinks = (c: SiteContent) =>
  c.socials.map((s) => ({ ...s, url: s.network === "whatsapp" ? whatsappUrl(c) : s.url })).filter((s) => s.url);

export const PAGE3_HREF = "/english-prep";

export const navItems = (c: SiteContent) => [
  { label: "Home", href: "/" },
  { label: "Our Services", href: "/services" },
  { label: c.general.page3Name, href: PAGE3_HREF },
  { label: "Contact", href: "/#contact" },
];

export const isPlaceholder = (value: string) => /REPLACE/i.test(value);

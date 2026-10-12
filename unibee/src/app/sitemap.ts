import type { MetadataRoute } from "next";
import { siteUrl } from "@/content/site";
import { PAGE3_HREF } from "@/lib/content/helpers";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${siteUrl}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/services`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${siteUrl}${PAGE3_HREF}`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${siteUrl}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}

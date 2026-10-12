import { site, siteUrl } from "@/content/site";
import { socialLinks } from "./social-links";

/** Organization + LocalBusiness structured data (helps Google show your business details). */
export function JsonLd() {
  const c = site.contact;
  const sameAs = socialLinks()
    .filter((s) => s.network !== "whatsapp")
    .map((s) => s.url);
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: site.name,
        url: siteUrl,
        logo: `${siteUrl}/brand/unibee-icon-512.png`,
        slogan: site.tagline,
        description: site.description,
        email: c.email,
        sameAs,
      },
      {
        "@type": ["LocalBusiness", "ProfessionalService"],
        "@id": `${siteUrl}/#business`,
        name: `${site.name} | Study in Lithuania`,
        parentOrganization: { "@id": `${siteUrl}/#organization` },
        url: siteUrl,
        image: `${siteUrl}/images/og-image.png`,
        telephone: c.phone,
        email: c.email,
        address: { "@type": "PostalAddress", streetAddress: c.address, addressLocality: "Dhaka", addressCountry: "BD" },
        areaServed: { "@type": "Country", name: "Bangladesh" },
        openingHours: "Sa-Th 10:00-19:00",
        priceRange: "Free consultation",
        description: site.description,
      },
    ],
  };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}

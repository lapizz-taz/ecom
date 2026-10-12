import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Analytics } from "@/components/layout/Analytics";
import { JsonLd } from "@/components/layout/JsonLd";
import { site, siteUrl } from "@/content/site";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "UniBee | Study in Lithuania from Bangladesh", template: "%s | UniBee" },
  description: site.description,
  applicationName: site.name,
  keywords: [
    "study in Lithuania from Bangladesh",
    "Lithuania student visa",
    "Lithuania university admission",
    "study abroad consultancy Bangladesh",
    "study in Europe from Bangladesh",
    "Lithuania TRP",
  ],
  openGraph: {
    type: "website",
    siteName: site.name,
    locale: "en_US",
    images: [{ url: "/images/og-image.png", width: 1200, height: 630, alt: "UniBee: Study in Lithuania from Bangladesh" }],
  },
  twitter: { card: "summary_large_image", images: ["/images/og-image.png"] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Lets CSS hide scroll-reveal content only when JS is available */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        <JsonLd />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}

import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { WhatsAppFloat } from "@/components/layout/WhatsAppFloat";
import { ContentProvider } from "@/components/content/ContentProvider";
import { getContent } from "@/lib/server/content-store";

/** Public pages: header, footer and the floating WhatsApp button, all fed by the CMS content. */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const content = await getContent();
  return (
    <ContentProvider content={content}>
      <Header />
      <main id="main">{children}</main>
      <Footer content={content} />
      <WhatsAppFloat />
    </ContentProvider>
  );
}

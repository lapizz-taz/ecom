import type { Metadata } from "next";
import { Hero } from "@/components/home/Hero";
import { UniversityMarquee } from "@/components/home/UniversityMarquee";
import { RegisterSection } from "@/components/home/RegisterSection";
import { StayConnected } from "@/components/home/StayConnected";
import { Placeholder } from "@/components/ui/Placeholder";
import { universities } from "@/content/universities";

export const metadata: Metadata = {
  title: { absolute: "UniBee | Study in Lithuania from Bangladesh" },
  description:
    "Study in Lithuania from Bangladesh with UniBee. Free profile assessment, university selection, application, file processing and Lithuania student visa support.",
  alternates: { canonical: "/" },
  openGraph: { title: "UniBee | Study in Lithuania from Bangladesh", url: "/" },
};

export default function HomePage() {
  return (
    <>
      <Hero />

      <section aria-labelledby="unis-title" className="bg-white pt-16 pb-16 md:pt-24 md:pb-24">
        <div className="container-page mb-8 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <h2 id="unis-title" className="text-[15px] font-medium text-ink">
            Universities We Work With{" "}
            {universities.some((u) => u.placeholder) && <Placeholder label="Sample list" className="ml-1" />}
          </h2>
          <p className="text-[14px] text-muted">Tap a university for programs, fees and requirements.</p>
        </div>
        <UniversityMarquee />
      </section>

      <RegisterSection />
      <StayConnected />
    </>
  );
}

import type { Metadata } from "next";
import { Hero } from "@/components/home/Hero";
import { UniversityMarquee } from "@/components/home/UniversityMarquee";
import { WhyUniBee } from "@/components/home/WhyUniBee";
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

      <section aria-labelledby="unis-title" className="bg-white pt-14 pb-16 md:pt-20 md:pb-24">
        <div className="container-page mb-8 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <h2 id="unis-title" className="text-[20px] font-semibold tracking-[-0.02em] text-ink md:text-[24px]">
            Universities We Work With{" "}
            {universities.some((u) => u.placeholder) && <Placeholder label="Sample list" className="ml-1" />}
          </h2>
          <p className="text-[14px] text-muted">Partner universities in Vilnius, Kaunas and Klaipėda.</p>
        </div>
        <UniversityMarquee />
      </section>

      <WhyUniBee />
      <RegisterSection />
      <StayConnected />
    </>
  );
}

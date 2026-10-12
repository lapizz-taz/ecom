import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";
import { page } from "@/lib/links";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { Placeholder } from "@/components/ui/Placeholder";
import { ProcessTimeline } from "@/components/services/ProcessTimeline";
import { CtaBanner } from "@/components/services/CtaBanner";
import { services, servicesPlaceholder } from "@/content/services";
import { documentsNeeded, processPlaceholder } from "@/content/process";

export const metadata: Metadata = {
  title: "Our Services: Lithuania Admission, File Processing & Visa",
  description:
    "Free profile assessment, university selection, application processing, SOP help, file processing and Lithuania student visa / TRP support for Bangladeshi students.",
  alternates: { canonical: "/services" },
  openGraph: { title: "Our Services | UniBee", url: "/services" },
};

export default function ServicesPage() {
  return (
    <>
      <PageHeader eyebrow="Our services" title="Our Services" subtitle="Everything you need to study in Lithuania, under one roof.">
        {servicesPlaceholder && <Placeholder label="Confirm service list" className="mt-6" />}
      </PageHeader>

      {/* Service grid: 1 col mobile, 2 tablet, 3 desktop, divided by hairlines */}
      <section aria-labelledby="services-title" className="bg-white pb-20 md:pb-28">
        <div className="container-page">
          <h2 id="services-title" className="sr-only">
            What we do
          </h2>
          <ul className="grid gap-px border-y border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s, i) => (
              <Reveal
                as="li"
                key={s.title}
                delay={(i % 3) * 60}
                className="group bg-white py-8 sm:px-6 lg:px-8"
              >
                <span className="grid size-10 place-items-center rounded-[10px] bg-surface text-ink-soft transition group-hover:bg-brand-tint group-hover:text-brand-dark">
                  <Icon name={s.icon} className="size-5" />
                </span>
                <h3 className="mt-5 text-[16px] font-medium text-ink">{s.title}</h3>
                <p className="mt-1.5 max-w-[340px] text-[15px] leading-relaxed text-muted">{s.description}</p>
              </Reveal>
            ))}
            {/* Ninth cell keeps the 3-column grid even and points to the form */}
            <li className="bg-white py-8 sm:hidden lg:block lg:px-8">
              <a href={page("/#register")} className="group flex h-full flex-col justify-between gap-6">
                <span className="grid size-10 place-items-center rounded-[10px] bg-brand-tint text-brand-dark">
                  <ArrowRight className="size-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-[16px] font-medium text-ink">Not sure where to start?</span>
                  <span className="mt-1.5 block text-[15px] text-muted">
                    Register for a free profile assessment and we&apos;ll suggest the right next step.{" "}
                    <span className="font-medium text-brand-dark group-hover:underline">Register now →</span>
                  </span>
                </span>
              </a>
            </li>
          </ul>
        </div>
      </section>

      {/* Process */}
      <section aria-labelledby="process-title" className="section border-t border-line bg-white">
        <div className="container-page">
          <SectionIntro
            id="process-title"
            title="How It Works: Our Full Process"
            text="From your first message to landing in Lithuania, here's exactly what happens and roughly how long each step takes."
            label="1.0  Process"
            badge={processPlaceholder ? <Placeholder label="Confirm steps & times" /> : null}
          />
          <ProcessTimeline />
        </div>
      </section>

      {/* Documents checklist */}
      <section aria-labelledby="docs-title" className="section border-t border-line bg-white">
        <div className="container-page grid gap-10 md:grid-cols-2 md:gap-12 lg:gap-24">
          <Reveal>
            <h2 id="docs-title" className="h2">
              Documents You&apos;ll Need
            </h2>
            <p className="mt-5 max-w-[420px] text-[17px] leading-[1.55] text-muted">
              Start collecting these early. We&apos;ll check every document and tell you if anything is missing.
            </p>
            <p className="tag-link mt-5">2.0  Checklist</p>
            {processPlaceholder && (
              <div className="mt-5">
                <Placeholder label="Confirm list" />
              </div>
            )}
          </Reveal>
          <Reveal as="ul" className="border-t border-line">
            {documentsNeeded.map((d) => (
              <li key={d} className="flex items-center gap-3 border-b border-line py-4 text-[15px] text-ink">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink">
                  <Check className="size-3 text-white" strokeWidth={3.5} aria-hidden="true" />
                </span>
                {d}
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}

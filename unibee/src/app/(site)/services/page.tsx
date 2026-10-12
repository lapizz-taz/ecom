import type { Metadata } from "next";
import { Check, FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeading } from "@/components/ui/SectionHeading";
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
      <PageHeader eyebrow="Our services" title="Our Services" subtitle="Everything you need to study in Lithuania, under one roof." />

      {/* Service cards: 1 col mobile, 2 tablet, 3 desktop */}
      <section aria-labelledby="services-title" className="section bg-white">
        <div className="container-page">
          <h2 id="services-title" className="sr-only">
            What we do
          </h2>
          {servicesPlaceholder && (
            <p className="mb-6 text-center">
              <Placeholder label="Confirm service list" />
            </p>
          )}
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s, i) => (
              <Reveal as="li" key={s.title} delay={(i % 3) * 60}>
                <div className="card card-hover group h-full p-6 sm:p-7">
                  <span className="grid size-12 place-items-center rounded-[12px] bg-brand-tint text-brand-dark transition group-hover:bg-brand group-hover:text-white">
                    <Icon name={s.icon} className="size-6" />
                  </span>
                  <h3 className="mt-5 font-heading text-[19px] leading-snug font-semibold tracking-[-0.01em]">{s.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{s.description}</p>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      {/* Process timeline */}
      <section aria-labelledby="process-title" className="section border-y border-line bg-surface">
        <div className="container-page">
          <SectionHeading
            id="process-title"
            eyebrow="Step by step"
            title="How It Works: Our Full Process"
            subtitle="From your first message to landing in Lithuania, here's exactly what happens and roughly how long each step takes."
            badge={processPlaceholder ? <Placeholder label="Confirm steps & times" className="ml-1" /> : null}
          />
          <ProcessTimeline />
        </div>
      </section>

      {/* Documents checklist (dark panel) */}
      <section aria-labelledby="docs-title" className="section bg-white">
        <div className="container-page">
          <Reveal className="grid overflow-hidden rounded-[var(--radius-frame)] bg-night text-white lg:grid-cols-[0.9fr_1.1fr]">
            <div className="p-7 sm:p-10 lg:p-12">
              <span className="grid size-12 place-items-center rounded-[12px] bg-white/10 ring-1 ring-white/15">
                <FileCheck2 className="size-6" aria-hidden="true" />
              </span>
              <h2 id="docs-title" className="h2 mt-6 text-white">
                Documents You&apos;ll Need
              </h2>
              <p className="mt-4 max-w-[420px] text-[16px] leading-relaxed text-white/85">
                Start collecting these early. We&apos;ll check every document and tell you if anything is missing.
              </p>
              {processPlaceholder && <Placeholder label="Confirm list" className="mt-5" />}
            </div>
            <ul className="grid gap-2.5 bg-graphite p-7 sm:grid-cols-2 sm:p-10 lg:p-12">
              {documentsNeeded.map((d) => (
                <li key={d} className="flex items-start gap-3 rounded-[var(--radius-card)] bg-white/[0.04] p-3.5 text-[15px] text-white/90 ring-1 ring-white/10">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand">
                    <Check className="size-3 text-white" strokeWidth={3.5} aria-hidden="true" />
                  </span>
                  {d}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}

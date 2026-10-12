import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { Reveal } from "@/components/ui/Reveal";
import { Placeholder } from "@/components/ui/Placeholder";
import { VideoFacade } from "@/components/english/VideoFacade";
import { CtaBanner } from "@/components/services/CtaBanner";
import { englishPrep as ep } from "@/content/english-prep";
import { isPlaceholder, site } from "@/content/site";
import { asset, page } from "@/lib/links";

export const metadata: Metadata = {
  title: `${site.page3.name}: PTE & IELTS Classes`,
  description: "PTE and IELTS preparation classes in Dhaka and online. Small batches, exam strategies and mock tests to reach the score you need for Lithuania.",
  alternates: { canonical: site.page3.href },
  openGraph: { title: `${site.page3.name} | UniBee`, url: site.page3.href },
};

export default function EnglishPrepPage() {
  const ins = ep.instructor;
  const initials = isPlaceholder(ins.name) ? "UB" : ins.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);

  return (
    <>
      <PageHeader title={ep.title} subtitle={ep.subtitle}>
        <div className="mt-8 flex flex-col gap-2.5 sm:flex-row">
          <a href={page("/#register")} className="btn btn-primary min-h-12 px-6">
            Join a Class <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <a href="#sample-class" className="btn btn-secondary min-h-12 px-6">
            Watch a sample class
          </a>
        </div>
        {ep.placeholder && <Placeholder label="Page content to be confirmed" className="mt-6" />}
      </PageHeader>

      {/* Sample class video, framed like a product panel */}
      <section id="sample-class" aria-labelledby="video-title" className="scroll-mt-20 bg-white pb-20 md:pb-28">
        <div className="container-page">
          <Reveal className="frame relative aspect-video">
            <VideoFacade youtube={ep.video.youtube} title={ep.video.title} />
          </Reveal>
          <div className="mt-4 flex flex-col justify-between gap-1 sm:flex-row">
            <h2 id="video-title" className="text-[15px] font-medium text-ink">
              {ep.video.title}
            </h2>
            <p className="text-[14px] text-muted">{ep.video.caption}</p>
          </div>
        </div>
      </section>

      {/* What you'll learn */}
      <section aria-labelledby="learn-title" className="section border-t border-line bg-white">
        <div className="container-page">
          <SectionIntro id="learn-title" title="What you'll learn" text="All four skills, with exam strategies that actually move your score." />
          <ul className="mt-14 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
            {ep.learn.map((l, i) => (
              <Reveal as="li" key={l.title} delay={i * 60} className="border-t border-line py-7">
                <h3 className="text-[16px] font-medium text-ink">{l.title}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{l.text}</p>
              </Reveal>
            ))}
          </ul>

          <Reveal as="dl" className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {ep.format.map((f) => (
              <div key={f.label} className="flex flex-col gap-1">
                <dt className="text-[13px] text-muted">{f.label}</dt>
                <dd className="text-[15px] font-medium text-ink">{f.value}</dd>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* Instructor / academic profile */}
      <section aria-labelledby="instructor-title" className="section border-t border-line bg-white">
        <div className="container-page grid gap-10 md:grid-cols-[auto_1fr] md:gap-16">
          <Reveal className="flex flex-col items-start gap-4">
            {ins.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={asset(ins.photo)} alt={ins.name} className="size-36 rounded-[var(--radius-frame)] object-cover" loading="lazy" />
            ) : (
              <span className="grid size-36 place-items-center rounded-[var(--radius-frame)] bg-surface text-[40px] font-semibold tracking-[-0.03em] text-ink-soft" aria-hidden="true">
                {initials}
              </span>
            )}
            {ep.placeholder && <Placeholder label="Instructor profile" />}
          </Reveal>
          <Reveal>
            <p className="text-[14px] text-muted">Meet your instructor</p>
            <h2 id="instructor-title" className="h2 mt-3">
              {ins.name}
            </h2>
            <p className="mt-2 text-[15px] font-medium text-brand-dark">{ins.role}</p>
            <p className="mt-4 max-w-[620px] text-[17px] leading-[1.6] text-muted">{ins.bio}</p>
            <ul className="mt-6 max-w-[620px] border-t border-line">
              {ins.qualifications.map((q) => (
                <li key={q} className="flex items-center gap-3 border-b border-line py-3 text-[15px] text-ink">
                  <Check className="size-4 shrink-0 text-faint" aria-hidden="true" />
                  {q}
                </li>
              ))}
            </ul>
            <dl className="mt-8 grid max-w-[620px] grid-cols-3 gap-6">
              {ins.stats.map((s) => (
                <div key={s.label} className="flex flex-col-reverse gap-1">
                  <dt className="text-[13px] text-muted">{s.label}</dt>
                  <dd className="min-w-0 text-[20px] font-semibold tracking-[-0.03em] break-words text-ink sm:text-[26px] md:text-[32px]">{s.value}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      <CtaBanner title="Ready to get your score?" text="Join the next batch. Register and our team will share the schedule on WhatsApp." button="Join a Class" />
    </>
  );
}

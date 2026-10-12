import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";
import { Poppins } from "next/font/google";
import { PageHeader } from "@/components/classic/PageHeader";
import { SectionHeading } from "@/components/classic/SectionHeading";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { Placeholder } from "@/components/ui/Placeholder";
import { VideoFacade } from "@/components/classic/VideoFacade";
import { CtaBanner } from "@/components/classic/CtaBanner";
import { getContent } from "@/lib/server/content-store";
import { isPlaceholder, PAGE3_HREF } from "@/lib/content/helpers";
import { asset, page } from "@/lib/links";

// This page keeps the first-version ("classic") design: Poppins headings, soft cards with red icons,
// and a red call-to-action banner. The `classic` class in globals.css scopes those styles here.
const poppins = Poppins({ subsets: ["latin"], weight: ["600", "700"], display: "swap", variable: "--font-poppins" });

export async function generateMetadata(): Promise<Metadata> {
  const { general } = await getContent();
  return {
    title: `${general.page3Name}: PTE & IELTS Classes`,
    description: "PTE and IELTS preparation classes in Dhaka and online. Small batches, exam strategies and mock tests to reach the score you need for Lithuania.",
    alternates: { canonical: PAGE3_HREF },
    openGraph: { title: `${general.page3Name} | UniBee`, url: PAGE3_HREF },
  };
}

export default async function EnglishPrepPage() {
  const content = await getContent();
  const ep = content.englishPrep;
  const ins = ep.instructor;
  const initials = isPlaceholder(ins.name) ? "UB" : ins.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);

  return (
    <div className={`classic ${poppins.variable}`}>
      <PageHeader eyebrow={content.general.page3Name} title={ep.title} subtitle={ep.subtitle}>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href={page("/#register")} className="btn btn-primary w-full sm:w-auto">
            Join a Class <ArrowRight className="size-5" aria-hidden="true" />
          </a>
          <a href="#sample-class" className="btn btn-secondary w-full sm:w-auto">
            Watch a sample class
          </a>
        </div>
        {ep.placeholder && <Placeholder label="Page content to be confirmed" className="mt-6" />}
      </PageHeader>

      {/* What you'll learn */}
      <section aria-labelledby="learn-title" className="section bg-white">
        <div className="container-page">
          <SectionHeading id="learn-title" eyebrow="The course" title="What you'll learn" subtitle="All four skills, with exam strategies that actually move your score." />
          <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ep.learn.map((l, i) => (
              <Reveal as="li" key={l.title} delay={i * 60}>
                <div className="card card-hover h-full p-6">
                  <span className="grid size-12 place-items-center rounded-[12px] bg-brand-tint text-brand-dark">
                    <Icon name={l.icon} className="size-6" />
                  </span>
                  <h3 className="mt-5 font-heading text-[19px] font-semibold">{l.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{l.text}</p>
                </div>
              </Reveal>
            ))}
          </ul>

          <Reveal className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-card)] bg-line ring-1 ring-line sm:grid-cols-2 lg:grid-cols-4">
            {ep.format.map((f) => (
              <div key={f.label} className="flex items-start gap-3 bg-white p-5">
                <Icon name={f.icon} className="mt-0.5 size-5 shrink-0 text-brand-dark" />
                <div>
                  <p className="font-mono text-[12px] font-medium tracking-[0.08em] text-muted uppercase">{f.label}</p>
                  <p className="mt-1 text-[15px] font-semibold text-ink">{f.value}</p>
                </div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* Instructor / academic profile */}
      <section aria-labelledby="instructor-title" className="section border-y border-line bg-surface">
        <div className="container-page">
          <Reveal className="card grid gap-8 p-6 sm:p-10 lg:grid-cols-[auto_1fr] lg:gap-12">
            <div className="flex flex-col items-center text-center lg:w-56">
              {ins.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ins.photo.startsWith("/") ? asset(ins.photo) : ins.photo} alt={ins.name} className="size-40 rounded-full object-cover ring-4 ring-brand-tint" loading="lazy" />
              ) : (
                <span className="grid size-40 place-items-center rounded-full bg-brand-tint font-heading text-[44px] font-bold text-brand-dark ring-4 ring-white" aria-hidden="true">
                  {initials}
                </span>
              )}
              {ep.placeholder && <Placeholder label="Instructor profile" className="mt-4" />}
            </div>
            <div>
              <p className="eyebrow">Meet your instructor</p>
              <h2 id="instructor-title" className="h2 mt-2">
                {ins.name}
              </h2>
              <p className="mt-1 text-[16px] font-medium text-brand-dark">{ins.role}</p>
              <p className="mt-4 max-w-[640px] text-[16px] leading-relaxed text-ink-soft">{ins.bio}</p>
              <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {ins.qualifications.map((q) => (
                  <li key={q} className="flex gap-3 text-[15px] text-ink-soft">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line">
                      <Check className="size-3 text-brand-dark" strokeWidth={3} aria-hidden="true" />
                    </span>
                    {q}
                  </li>
                ))}
              </ul>
              <dl className="mt-8 grid grid-cols-3 gap-3">
                {ins.stats.map((s) => (
                  <div key={s.label} className="flex flex-col-reverse rounded-[var(--radius-card)] border border-line bg-white p-4 text-center">
                    <dt className="mt-1 text-[13px] text-muted">{s.label}</dt>
                    <dd className="font-heading text-[22px] font-bold tracking-[-0.01em] text-ink sm:text-[28px]">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Sample class video */}
      <section id="sample-class" aria-labelledby="video-title" className="section scroll-mt-16 bg-white">
        <div className="container-page">
          <SectionHeading id="video-title" eyebrow="See it first" title={ep.video.title} subtitle={ep.video.caption} />
          <Reveal className="relative mx-auto mt-10 aspect-video max-w-[960px] overflow-hidden rounded-[var(--radius-frame)]" style={{ boxShadow: "var(--shadow-float)" }}>
            <VideoFacade youtube={ep.video.youtube} title={ep.video.title} />
          </Reveal>
        </div>
      </section>

      <CtaBanner title="Ready to get your score?" text="Join the next batch. Register and our team will share the schedule on WhatsApp." button="Join a Class" />
    </div>
  );
}

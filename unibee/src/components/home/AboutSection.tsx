import { Reveal } from "@/components/ui/Reveal";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { Placeholder } from "@/components/ui/Placeholder";
import type { SiteContent } from "@/lib/content/types";

/** "About UniBee": who we are, what we do (in order), and how we work. Edited in the CMS → About us. */
export function AboutSection({ about }: { about: SiteContent["about"] }) {
  return (
    <section id="about" aria-labelledby="about-title" className="section scroll-mt-16 border-t border-line bg-white">
      <div className="container-page">
        <SectionIntro
          id="about-title"
          title={about.title}
          text={about.intro}
          badge={about.placeholder ? <Placeholder label="Review text" /> : null}
        />

        <div className="mt-12 grid gap-12 md:mt-16 lg:grid-cols-2 lg:gap-24">
          <Reveal className="space-y-6">
            {about.story && <p className="text-[17px] leading-[1.7] text-ink-soft">{about.story}</p>}
            {about.mission && (
              <blockquote className="border-l-2 border-brand pl-5 text-[18px] leading-[1.6] font-medium tracking-[-0.01em] text-ink">
                {about.mission}
              </blockquote>
            )}
          </Reveal>

          {about.whatWeDo.length > 0 && (
            <Reveal>
              <h3 className="text-[14px] font-medium text-ink">What we do</h3>
              <ol className="mt-4 border-t border-line">
                {about.whatWeDo.map((item, i) => (
                  <li key={item.title} className="grid grid-cols-[32px_1fr] gap-x-3 border-b border-line py-5">
                    <span className="pt-0.5 font-mono text-[12px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                    <div>
                      <p className="text-[16px] font-medium text-ink">{item.title}</p>
                      <p className="mt-1 text-[15px] leading-relaxed text-muted">{item.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Reveal>
          )}
        </div>

        {about.values.length > 0 && (
          <Reveal as="ul" className="mt-16 grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3" aria-label="How we work">
            {about.values.map((v) => (
              <li key={v.title} className="border-t border-line py-6">
                <p className="text-[16px] font-medium text-ink">{v.title}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{v.text}</p>
              </li>
            ))}
          </Reveal>
        )}
      </div>
    </section>
  );
}

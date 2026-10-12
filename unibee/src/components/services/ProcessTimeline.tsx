import { Reveal } from "@/components/ui/Reveal";
import type { SiteContent } from "@/lib/content/types";

/**
 * Changelog-style timeline: a thin line with dots.
 * Vertical on phones and tablets; two horizontal rows of five on desktop.
 */
export function ProcessTimeline({ steps: processSteps }: { steps: SiteContent["process"]["steps"] }) {
  return (
    <ol className="mt-14 grid gap-y-0 md:mt-20 lg:grid-cols-5 lg:gap-x-8 lg:gap-y-16">
      {processSteps.map((s, i) => {
        const endOfRow = i % 5 === 4;
        const last = i === processSteps.length - 1;
        return (
          <Reveal as="li" key={s.title} delay={(i % 5) * 50} className="relative pb-10 pl-9 lg:pb-0 lg:pl-0 lg:pt-10">
            {/* the line */}
            <span
              className={`absolute top-1.5 left-[5px] w-px bg-line-strong lg:top-[5px] lg:left-0 lg:h-px lg:w-auto ${last ? "bottom-auto h-0 lg:h-px" : "bottom-0"} ${
                endOfRow ? "lg:right-0" : "lg:-right-8"
              }`}
              aria-hidden="true"
            />
            {/* the dot */}
            <span
              className={`absolute top-0 left-0 size-[11px] rounded-full ring-4 ring-white ${i === 0 ? "bg-brand" : "bg-line-strong"}`}
              aria-hidden="true"
            />
            <p className="font-mono text-[12px] text-faint">Step {String(i + 1).padStart(2, "0")}</p>
            <h3 className="mt-2 text-[15px] font-medium text-ink">{s.title}</h3>
            <p className="mt-1 text-[14px] leading-relaxed text-muted">{s.text}</p>
            <p className="mt-3 font-mono text-[12px] text-faint">{s.time}</p>
          </Reveal>
        );
      })}
    </ol>
  );
}

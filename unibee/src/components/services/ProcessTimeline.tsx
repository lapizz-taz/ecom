import { Clock } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { processSteps } from "@/content/process";

/**
 * Vertical timeline on mobile; zig-zag (alternating sides of a centre line) on desktop.
 */
export function ProcessTimeline() {
  return (
    <ol className="relative mx-auto mt-12 max-w-[1000px]">
      {/* the line */}
      <span className="absolute top-2 bottom-2 left-[23px] w-px bg-gradient-to-b from-brand/50 via-line-strong to-line-strong lg:left-1/2" aria-hidden="true" />
      {processSteps.map((s, i) => {
        const right = i % 2 === 1;
        const num = String(i + 1).padStart(2, "0");
        return (
          <li key={s.title} className="relative pb-6 pl-16 last:pb-0 lg:grid lg:grid-cols-2 lg:gap-16 lg:pl-0 lg:pb-4">
            {/* number bubble on the line */}
            <span
              className="absolute top-3 left-0 z-10 grid size-12 place-items-center rounded-full border-4 border-white bg-brand-dark font-heading text-[15px] font-bold text-white shadow-[0_0_0_1px_var(--color-line)] lg:left-1/2 lg:-translate-x-1/2"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <Reveal delay={40} className={right ? "lg:col-start-2" : "lg:col-start-1 lg:text-right"}>
              <div className={`card card-hover p-5 sm:p-6 ${right ? "" : "lg:ml-auto"} lg:max-w-[420px]`}>
                <div className={`flex items-center gap-3 ${right ? "" : "lg:flex-row-reverse"}`}>
                  <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-brand-tint text-brand-dark">
                    <Icon name={s.icon} className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-mono text-[12px] font-medium tracking-[0.08em] text-muted uppercase">
                      <span className="sr-only">Step </span>Step {num}
                    </p>
                    <h3 className="font-heading text-[18px] leading-snug font-semibold tracking-[-0.01em]">{s.title}</h3>
                  </div>
                </div>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{s.text}</p>
                <p className={`mt-3 inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[13px] font-medium text-ink-soft ring-1 ring-line`}>
                  <Clock className="size-3.5 text-brand-dark" aria-hidden="true" /> {s.time}
                </p>
              </div>
            </Reveal>
          </li>
        );
      })}
    </ol>
  );
}

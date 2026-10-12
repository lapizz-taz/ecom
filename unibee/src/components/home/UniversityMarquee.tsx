"use client";

import { ArrowRight, Calendar, ExternalLink, GraduationCap, Info, MapPin, Wallet, Clock, Languages } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Placeholder } from "@/components/ui/Placeholder";
import { universities, type University } from "@/content/universities";
import { asset, page } from "@/lib/links";
import { trackEvent } from "@/lib/analytics";

/** Real logo if provided, otherwise a monogram tile in the university's colour. */
export function UniversityLogo({ u, size = "md" }: { u: University; size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-16 w-16 text-lg" : "h-12 w-12 text-[13px]";
  if (u.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset(u.logo)} alt="" className={`${size === "lg" ? "h-16" : "h-12"} w-auto max-w-[140px] object-contain`} loading="lazy" />;
  }
  const initials = u.shortName.length <= 5 ? u.shortName : u.shortName.split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
  return (
    <span className={`grid ${box} shrink-0 place-items-center rounded-xl font-heading font-bold tracking-tight text-white`} style={{ backgroundColor: u.color }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Asks the registration form to pre-select this university, then scrolls to it. */
function applyWith(u: University) {
  trackEvent("apply_with_unibee", { university: u.name });
  window.dispatchEvent(new CustomEvent("unibee:apply", { detail: { university: u.name } }));
  document.getElementById("register")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function UniversityMarquee() {
  const [selected, setSelected] = useState<University | null>(null);
  const [paused, setPaused] = useState(false);
  const resumeTimer = useRef<number | undefined>(undefined);
  const close = useCallback(() => setSelected(null), []);

  // Touch: pause while touching, resume shortly after letting go.
  const onTouchStart = () => {
    window.clearTimeout(resumeTimer.current);
    setPaused(true);
  };
  const onTouchEnd = () => {
    resumeTimer.current = window.setTimeout(() => setPaused(false), 2500);
  };
  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

  const open = (u: University) => {
    setSelected(u);
    trackEvent("view_university", { university: u.name });
  };

  const list = (copy: number) => (
    <ul className={`flex shrink-0 items-stretch gap-4 pr-4 ${copy ? "marquee-dup" : ""}`} aria-hidden={copy ? true : undefined}>
      {universities.map((u) => (
        <li key={u.slug}>
          <button
            type="button"
            onClick={() => open(u)}
            tabIndex={copy ? -1 : undefined}
            className="group flex h-[88px] w-[232px] items-center gap-3 rounded-[var(--radius-card)] border border-line bg-white px-4 text-left transition duration-300 hover:-translate-y-0.5 hover:border-transparent hover:shadow-[var(--shadow-card-hover)] focus-visible:border-transparent"
            aria-label={copy ? undefined : `${u.name}, ${u.city}. View details`}
          >
            <span className="grayscale transition duration-300 group-hover:grayscale-0 group-focus-visible:grayscale-0">
              <UniversityLogo u={u} />
            </span>
            <span className="min-w-0">
              <span className="line-clamp-2 text-[14px] leading-snug font-semibold text-ink-soft transition group-hover:text-ink">{u.name}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[13px] text-muted">
                <MapPin className="size-3.5" aria-hidden="true" /> {u.city}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <div
        className="marquee group/marquee relative overflow-hidden py-2 motion-reduce:overflow-x-auto"
        data-paused={paused}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{ "--marquee-duration": `${universities.length * 5}s` } as React.CSSProperties}
      >
        {/* soft fade at the edges */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-white to-transparent md:w-24 motion-reduce:hidden" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-white to-transparent md:w-24 motion-reduce:hidden" aria-hidden="true" />
        <div className="marquee-track flex w-max">
          {list(0)}
          {list(1)}
        </div>
      </div>
      <p className="mt-4 text-center text-[14px] text-muted">Tap a university to see programs, fees and requirements.</p>

      <Modal open={!!selected} onClose={close} labelledBy="uni-title">
        {selected && <UniversityDetails u={selected} onApply={() => { const u = selected; close(); requestAnimationFrame(() => applyWith(u)); }} />}
      </Modal>
    </>
  );
}

function UniversityDetails({ u, onApply }: { u: University; onApply: () => void }) {
  const facts = [
    { icon: Wallet, label: "Tuition fee", value: u.tuition },
    { icon: Calendar, label: "Intakes", value: u.intakes.join(" · ") },
    { icon: Clock, label: "Application deadline", value: u.deadline },
  ];
  return (
    <div>
      <div className="flex items-start gap-4 border-b border-line bg-surface px-5 pt-6 pb-5 pr-16 sm:px-8 sm:pt-8">
        <UniversityLogo u={u} size="lg" />
        <div className="min-w-0">
          <h2 id="uni-title" className="font-heading text-[20px] leading-tight font-bold tracking-[-0.01em] sm:text-[24px]">
            {u.name}
          </h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-[15px] text-muted">
            <MapPin className="size-4" aria-hidden="true" /> {u.city}, Lithuania
          </p>
        </div>
      </div>

      <div className="space-y-6 px-5 py-6 sm:px-8">
        {u.placeholder && (
          <p className="flex gap-2 rounded-[var(--radius-card)] border border-dashed border-amber-400 bg-amber-50 p-3 text-[14px] text-amber-900">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <Placeholder label="To be confirmed" className="mr-1" /> Sample details for the preview. UniBee will confirm fees, intakes and deadlines.
            </span>
          </p>
        )}

        <p className="text-[16px] leading-relaxed text-ink-soft">{u.about}</p>

        <dl className="grid gap-3 sm:grid-cols-3">
          {facts.map(({ icon: I, label, value }) => (
            <div key={label} className="rounded-[var(--radius-card)] border border-line p-3.5">
              <dt className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
                <I className="size-4 text-brand-dark" aria-hidden="true" /> {label}
              </dt>
              <dd className="mt-1 text-[15px] leading-snug font-semibold text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div>
          <h3 className="flex items-center gap-2 font-heading text-[17px] font-semibold">
            <GraduationCap className="size-5 text-brand-dark" aria-hidden="true" /> Popular programs
          </h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {(["bachelor", "master"] as const).map((level) => (
              <div key={level}>
                <p className="text-[13px] font-semibold tracking-wide text-muted uppercase">{level === "bachelor" ? "Bachelor's" : "Master's"}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {u.programs[level].map((p) => (
                    <li key={p} className="rounded-full bg-surface px-3 py-1 text-[14px] text-ink-soft ring-1 ring-line">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="flex items-center gap-2 font-heading text-[17px] font-semibold">
            <Languages className="size-5 text-brand-dark" aria-hidden="true" /> Entry requirements
          </h3>
          <dl className="mt-3 space-y-2 text-[15px]">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-24 shrink-0 font-semibold text-ink">Academic</dt>
              <dd className="text-ink-soft">{u.requirements.academic}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-24 shrink-0 font-semibold text-ink">English</dt>
              <dd className="text-ink-soft">{u.requirements.english}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-line bg-white/95 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <a href={u.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center gap-1.5 text-[15px] font-semibold text-brand-dark underline-offset-4 hover:underline">
          Official website <ExternalLink className="size-4" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <a
          href={page("/#register")}
          onClick={(e) => {
            e.preventDefault();
            onApply();
          }}
          className="btn btn-primary"
        >
          Apply with UniBee <ArrowRight className="size-5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

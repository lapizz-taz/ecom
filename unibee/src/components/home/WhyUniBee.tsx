import { Reveal } from "@/components/ui/Reveal";

/* Isometric line-art helpers (drawn in code so they stay crisp and tiny). */
const rhombus = (cx: number, cy: number, w: number, h: number) => `M${cx},${cy - h} L${cx + w},${cy} L${cx},${cy + h} L${cx - w},${cy} Z`;

function box(x: number, y: number, s: number, H: number) {
  const top = `M${x},${y - H - s / 2} L${x + s},${y - H} L${x},${y - H + s / 2} L${x - s},${y - H} Z`;
  const sides = `M${x - s},${y - H} L${x - s},${y} L${x},${y + s / 2} L${x + s},${y} L${x + s},${y - H} M${x},${y - H + s / 2} L${x},${y + s / 2}`;
  return top + " " + sides;
}

/** Stacked layers: a profile built up step by step. */
function ArtLayers() {
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <path key={i} d={rhombus(120, 112 - i * 9, 74, 40)} className="lineart" opacity={0.35 + i * 0.1} />
      ))}
      <path d="M46,112 L46,58 M194,112 L194,58 M120,152 L120,98" className="lineart" />
      <ellipse cx="120" cy="58" rx="30" ry="16" className="lineart lineart-accent" />
      {Array.from({ length: 4 }, (_, i) => (
        <ellipse key={i} cx="120" cy="58" rx={30 - i * 7} ry={16 - i * 3.8} className="lineart" opacity={0.5} />
      ))}
    </svg>
  );
}

/** Rising blocks: every step handled, one after another. */
function ArtSteps() {
  const blocks = [
    { x: 66, y: 140, H: 14 },
    { x: 100, y: 122, H: 30 },
    { x: 134, y: 104, H: 46 },
    { x: 168, y: 86, H: 62 },
  ];
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" aria-hidden="true">
      {blocks.map((b, i) => (
        <path key={i} d={box(b.x, b.y, 22, b.H)} className={`lineart ${i === blocks.length - 1 ? "lineart-accent" : ""}`} />
      ))}
      <path d="M40,153 L200,73" className="lineart" strokeDasharray="2 4" />
    </svg>
  );
}

/** Ripples: a fast reply on WhatsApp. */
function ArtRipples() {
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <ellipse key={i} cx="120" cy="118" rx={22 + i * 16} ry={(22 + i * 16) * 0.48} className="lineart" opacity={1 - i * 0.13} />
      ))}
      <path d="M120,118 L120,40" className="lineart" />
      <circle cx="120" cy="40" r="7" className="lineart lineart-accent" />
      <circle cx="120" cy="40" r="2.5" fill="var(--color-brand)" />
    </svg>
  );
}

const items = [
  { art: ArtLayers, title: "Built for Bangladeshi students", text: "We know SSC, HSC and MOI inside out, and match your results to the right Lithuanian programs." },
  { art: ArtSteps, title: "Every step, handled", text: "University selection, application, file processing and visa. One team from start to finish." },
  { art: ArtRipples, title: "Fast, friendly answers", text: "Talk to a real counsellor on WhatsApp. We reply quickly and keep you updated at every stage." },
];

export function WhyUniBee() {
  return (
    <section aria-label="Why UniBee" className="bg-white">
      <div className="container-page">
        <ul className="grid border-y border-line md:grid-cols-3 md:divide-x md:divide-line">
          {items.map(({ art: Art, title, text }, i) => (
            <Reveal as="li" key={title} delay={i * 80} className={`py-10 md:px-8 md:py-14 ${i > 0 ? "border-t border-line md:border-t-0" : ""} md:first:pl-0 md:last:pr-0`}>
              <div className="mx-auto h-40 max-w-[260px] md:h-44">
                <Art />
              </div>
              <h3 className="mt-6 text-[15px] font-medium text-ink">{title}</h3>
              <p className="mt-1.5 max-w-[320px] text-[15px] leading-relaxed text-muted">{text}</p>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

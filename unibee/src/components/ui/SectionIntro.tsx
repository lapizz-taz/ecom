import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

/**
 * Linear-style section opener: big heading on the left, description on the right,
 * optionally with a small link underneath.
 */
export function SectionIntro({
  id,
  title,
  text,
  label,
  href,
  badge,
}: {
  id?: string;
  title: ReactNode;
  text: ReactNode;
  label?: string;
  href?: string;
  badge?: ReactNode;
}) {
  return (
    <Reveal className="grid gap-5 md:grid-cols-2 md:gap-12 lg:gap-24">
      <h2 id={id} className="h2 max-w-[520px]">
        {title}
        {badge && <span className="ml-2 inline-block align-middle">{badge}</span>}
      </h2>
      <div className="md:pt-2">
        <p className="max-w-[440px] text-[17px] leading-[1.55] text-muted md:text-[18px]">{text}</p>
        {label && href && (
          <a href={href} className="tag-link mt-5">
            {label} <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
    </Reveal>
  );
}

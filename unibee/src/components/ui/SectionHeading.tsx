import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

/** Centred title + subtitle block used above each section. */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  id,
  align = "center",
  badge,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  id?: string;
  align?: "center" | "left";
  badge?: ReactNode;
}) {
  const center = align === "center";
  return (
    <Reveal className={`${center ? "mx-auto text-center" : ""} max-w-[720px]`}>
      {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
      <h2 id={id} className="h2">
        {title} {badge}
      </h2>
      {subtitle && <p className={`lead mt-4 ${center ? "mx-auto" : ""} max-w-[620px]`}>{subtitle}</p>}
    </Reveal>
  );
}

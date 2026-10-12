import type { ReactNode } from "react";

/** Top of inner pages: large left-aligned title with a split subtitle, Linear style. */
export function PageHeader({ eyebrow, title, subtitle, children }: { eyebrow?: string; title: ReactNode; subtitle: ReactNode; children?: ReactNode }) {
  return (
    <section className="bg-white">
      <div className="container-page pt-14 pb-14 md:pt-24 md:pb-20">
        {eyebrow && <p className="eyebrow mb-5">{eyebrow}</p>}
        <h1 className="h1 max-w-[860px]">{title}</h1>
        <p className="mt-5 max-w-[560px] text-[17px] leading-[1.55] text-muted md:text-[19px]">{subtitle}</p>
        {children}
      </div>
    </section>
  );
}

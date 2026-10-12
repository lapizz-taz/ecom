import type { ReactNode } from "react";

/** Top band for inner pages: eyebrow, title, subtitle on a soft red-tint field. */
export function PageHeader({ eyebrow, title, subtitle, children }: { eyebrow?: string; title: ReactNode; subtitle: ReactNode; children?: ReactNode }) {
  return (
    <section className="relative isolate overflow-hidden border-b border-line bg-white">
      {/* faint construction grid + red glow */}
      <div
        className="absolute inset-0 -z-10 opacity-60 [background-image:linear-gradient(to_right,#ececec_1px,transparent_1px),linear-gradient(to_bottom,#ececec_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]"
        aria-hidden="true"
      />
      <div className="absolute -top-40 left-1/2 -z-10 size-[520px] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" aria-hidden="true" />
      <div className="container-page py-14 text-center md:py-20 lg:py-24">
        {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
        <h1 className="h1 mx-auto max-w-[820px]">{title}</h1>
        <p className="lead mx-auto mt-5 max-w-[620px]">{subtitle}</p>
        {children}
      </div>
    </section>
  );
}

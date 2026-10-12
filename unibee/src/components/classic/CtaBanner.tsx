import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { page } from "@/lib/links";

/** Red call-to-action band. */
export function CtaBanner({ title = "Ready to start your journey?", text = "Register in 5 minutes. Our team will call you on WhatsApp within 24 hours.", button = "Register Now" }) {
  return (
    <section className="bg-white pb-16 md:pb-24">
      <div className="container-page">
        <Reveal className="relative isolate overflow-hidden rounded-[var(--radius-frame)] bg-brand-dark px-6 py-12 text-center text-white sm:px-10 md:py-16">
          <div className="absolute -top-24 -right-16 -z-10 size-72 rounded-full bg-brand blur-2xl" aria-hidden="true" />
          <div className="absolute -bottom-28 -left-10 -z-10 size-72 rounded-full bg-[#b91c1c] blur-2xl" aria-hidden="true" />
          <h2 className="h2 text-white">{title}</h2>
          <p className="mx-auto mt-3 max-w-[520px] text-[17px] text-white/90">{text}</p>
          <a href={page("/#register")} className="btn mt-8 bg-white px-8 text-[17px] font-bold text-brand-dark shadow-[var(--shadow-btn)] hover:bg-brand-tint">
            {button} <ArrowRight className="size-5" aria-hidden="true" />
          </a>
        </Reveal>
      </div>
    </section>
  );
}

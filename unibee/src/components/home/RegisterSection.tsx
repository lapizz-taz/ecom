import { Check, ShieldCheck } from "lucide-react";
import { RegistrationForm } from "@/components/home/RegistrationForm";
import { Reveal } from "@/components/ui/Reveal";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { SocialIcon } from "@/components/ui/SocialIcon";

const nextSteps = [
  "We review your profile for free",
  "A counsellor calls you on WhatsApp within 24 hours",
  "You get a shortlist of universities that fit your results and budget",
  "We guide you through application, file processing and visa",
];

/**
 * Phones: heading → form → "what happens next" (the form comes first because it's the main goal).
 * Desktop: heading + "what happens next" on the left, form on the right.
 */
export function RegisterSection() {
  return (
    <section id="register" aria-labelledby="register-title" className="section scroll-mt-16 border-y border-line bg-surface">
      <div className="container-page grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-0">
        <Reveal className="lg:col-start-1 lg:row-start-1">
          <p className="eyebrow mb-3">Free registration</p>
          <h2 id="register-title" className="h2">
            Register Your Profile
          </h2>
          <p className="lead mt-4">Fill in your details and our team will contact you within 24 hours.</p>
        </Reveal>

        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <RegistrationForm />
        </div>

        <Reveal className="lg:col-start-1 lg:row-start-2">
          <h3 className="mt-2 font-heading text-[16px] font-semibold lg:mt-8">What happens next</h3>
          <ul className="mt-3 space-y-3">
            {nextSteps.map((s) => (
              <li key={s} className="flex gap-3 text-[16px] text-ink-soft">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line">
                  <Check className="size-3.5 text-brand-dark" strokeWidth={3} aria-hidden="true" />
                </span>
                {s}
              </li>
            ))}
          </ul>

          <p className="mt-8 flex gap-2 text-[14px] text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Your details are only used by the UniBee team to help with your application. We never sell your data.
          </p>
          <p className="mt-4 text-[15px] text-ink-soft">
            Prefer to chat first?{" "}
            <WhatsAppLink location="register-aside" className="inline-flex items-center gap-1 font-semibold text-whatsapp-dark underline-offset-4 hover:underline">
              <SocialIcon network="whatsapp" className="size-4" /> Message us on WhatsApp
            </WhatsAppLink>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

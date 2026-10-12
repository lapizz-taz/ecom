import { RegistrationForm } from "@/components/home/RegistrationForm";
import { Reveal } from "@/components/ui/Reveal";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";

const nextSteps = [
  "We review your profile for free.",
  "A counsellor calls you on WhatsApp within 24 hours.",
  "You get a shortlist of universities that fit your results and budget.",
  "We guide you through application, file processing and visa.",
];

/**
 * Phones: heading → form → "what happens next" (the form comes first because it's the main goal).
 * Desktop: heading row, then a short note on the left and the form on the right.
 */
export function RegisterSection() {
  return (
    <section id="register" aria-labelledby="register-title" className="section scroll-mt-16 border-t border-line bg-white">
      <div className="container-page">
        <SectionIntro id="register-title" title="Register Your Profile" text="Fill in your details and our team will contact you within 24 hours." />

        <div className="mt-12 grid gap-10 md:mt-16 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
          <div className="lg:order-2">
            <RegistrationForm />
          </div>

          <Reveal className="space-y-6 text-[14px] leading-relaxed text-muted lg:order-1 lg:pt-1">
            <div>
              <h3 className="text-[14px] font-medium text-ink">What happens next</h3>
              <ul className="mt-2 space-y-1.5">
                {nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <p>Your details are only used by the UniBee team to help with your application. We never sell your data.</p>
            <p>
              Prefer to chat first?{" "}
              <WhatsAppLink location="register-aside" className="font-medium text-ink underline underline-offset-4 hover:text-brand-dark">
                Message us on WhatsApp
              </WhatsAppLink>
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

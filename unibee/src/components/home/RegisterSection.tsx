import { ShieldCheck } from "lucide-react";
import { RegistrationForm } from "@/components/home/RegistrationForm";
import { Reveal } from "@/components/ui/Reveal";
import { SectionIntro } from "@/components/ui/SectionIntro";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { SocialIcon } from "@/components/ui/SocialIcon";

const nextSteps = [
  { title: "Free profile review", text: "We look at your SSC, HSC and English results." },
  { title: "WhatsApp call within 24 hours", text: "A counsellor talks through your goals and budget." },
  { title: "Your university shortlist", text: "Programs that fit your results, budget and timeline." },
  { title: "Application to visa", text: "We guide you through every document and deadline." },
];

/**
 * Phones: heading → form → "what happens next" (the form comes first because it's the main goal).
 * Desktop: heading row, then "what happens next" on the left and the form on the right.
 */
export function RegisterSection() {
  return (
    <section id="register" aria-labelledby="register-title" className="section scroll-mt-16 bg-white">
      <div className="container-page">
        <SectionIntro
          id="register-title"
          title="Register Your Profile"
          text="Fill in your details and our team will contact you within 24 hours."
          label="1.0  Free registration"
        />

        <div className="mt-12 grid gap-10 md:mt-16 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div className="lg:order-2">
            <RegistrationForm />
          </div>

          <Reveal className="lg:order-1 lg:pt-2">
            <h3 className="text-[13px] font-medium text-ink">What happens next</h3>
            <ol className="mt-4 border-t border-line">
              {nextSteps.map((s, i) => (
                <li key={s.title} className="flex gap-4 border-b border-line py-4">
                  <span className="pt-0.5 font-mono text-[12px] text-faint">{`0${i + 1}`}</span>
                  <div>
                    <p className="text-[15px] font-medium text-ink">{s.title}</p>
                    <p className="mt-0.5 text-[14px] text-muted">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="mt-6 flex gap-2 text-[13px] leading-relaxed text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Your details are only used by the UniBee team to help with your application. We never sell your data.
            </p>
            <p className="mt-4 text-[14px] text-muted">
              Prefer to chat first?{" "}
              <WhatsAppLink location="register-aside" className="inline-flex items-center gap-1 font-medium text-whatsapp-dark underline-offset-4 hover:underline">
                <SocialIcon network="whatsapp" className="size-4" /> Message us on WhatsApp
              </WhatsAppLink>
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

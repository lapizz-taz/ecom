import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { WhatsAppLink } from "@/components/home/WhatsAppLink";
import { page } from "@/lib/links";

/** Closing call to action: big centred statement and two buttons. */
export function CtaBanner({
  title = "Ready to start your journey?",
  text = "Register in 5 minutes. Our team will call you on WhatsApp within 24 hours.",
  button = "Register Now",
}) {
  return (
    <section className="border-t border-line bg-white">
      <Reveal className="container-page py-24 text-center md:py-32">
        <span className="mx-auto mb-6 block size-2 rounded-full bg-brand" aria-hidden="true" />
        <h2 className="h2 mx-auto max-w-[640px] md:text-[52px] lg:text-[56px]">{title}</h2>
        <p className="mx-auto mt-4 max-w-[480px] text-[17px] text-muted">{text}</p>
        <div className="mt-8 flex flex-col justify-center gap-2.5 sm:flex-row">
          <a href={page("/#register")} className="btn btn-primary min-h-12 px-6">
            {button} <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <WhatsAppLink location="cta" className="btn btn-secondary min-h-12 px-6">
            Talk on WhatsApp
          </WhatsAppLink>
        </div>
      </Reveal>
    </section>
  );
}

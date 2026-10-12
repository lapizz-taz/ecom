"use client";

import { useEffect, useState } from "react";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { useContent } from "@/components/content/ContentProvider";
import { whatsappUrl } from "@/lib/content/helpers";
import { trackWhatsAppClick } from "@/lib/analytics";

/**
 * Floating green WhatsApp button, bottom-right on every page. Pulses gently after load.
 * On phones it steps aside while the registration form is on screen so it never covers the form's buttons.
 */
export function WhatsAppFloat() {
  const [hidden, setHidden] = useState(false);
  const content = useContent();

  useEffect(() => {
    const form = document.getElementById("register");
    if (!form || !("IntersectionObserver" in window)) return;
    const mq = window.matchMedia("(max-width: 767px)");
    let inView = false;
    const update = () => setHidden(inView && mq.matches);
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      update();
    });
    io.observe(form);
    mq.addEventListener("change", update);
    return () => {
      io.disconnect();
      mq.removeEventListener("change", update);
    };
  }, []);

  return (
    <a
      href={whatsappUrl(content)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackWhatsAppClick("floating-button")}
      aria-label="Chat with UniBee on WhatsApp (opens in a new tab)"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      className={`group fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 grid size-14 animate-pulse-once place-items-center rounded-full bg-whatsapp text-white shadow-[0_8px_24px_rgba(18,140,75,0.35)] transition duration-300 hover:-translate-y-0.5 hover:scale-105 md:right-6 md:bottom-6 md:size-[60px] ${
        hidden ? "pointer-events-none translate-y-24 opacity-0" : ""
      }`}
    >
      <SocialIcon network="whatsapp" className="size-7" />
      <span className="pointer-events-none absolute right-full mr-3 hidden rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-white opacity-0 transition group-hover:opacity-100 md:block">
        Chat with us
      </span>
    </a>
  );
}

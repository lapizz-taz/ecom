"use client";

import type { ReactNode } from "react";
import { whatsappUrl } from "@/content/site";
import { trackWhatsAppClick } from "@/lib/analytics";

/** WhatsApp chat link that also records a "Contact" event for analytics. */
export function WhatsAppLink({
  location,
  message,
  className,
  children,
  ariaLabel,
}: {
  location: string;
  message?: string;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <a
      href={whatsappUrl(message)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackWhatsAppClick(location)}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  );
}

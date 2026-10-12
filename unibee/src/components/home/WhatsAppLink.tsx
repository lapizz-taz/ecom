"use client";

import type { ReactNode } from "react";
import { useContent } from "@/components/content/ContentProvider";
import { whatsappUrl } from "@/lib/content/helpers";
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
  const content = useContent();
  return (
    <a
      href={whatsappUrl(content, message)}
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

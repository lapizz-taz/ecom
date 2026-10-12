/**
 * Tracking helpers for Google Analytics 4 and the Meta Pixel.
 * Both are only loaded when their IDs are set (see .env.example), so these
 * calls are safe no-ops in development and in the preview.
 */
type Gtag = (...args: unknown[]) => void;
type Fbq = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: Gtag;
    fbq?: Fbq;
  }
}

export function trackLead(details: { studyLevel?: string; englishTest?: string } = {}) {
  if (typeof window === "undefined") return;
  window.fbq?.("track", "Lead", { content_name: "Student registration", ...details });
  window.gtag?.("event", "generate_lead", { form: "registration", study_level: details.studyLevel, english_test: details.englishTest });
}

export function trackWhatsAppClick(location: string) {
  if (typeof window === "undefined") return;
  window.fbq?.("track", "Contact", { method: "whatsapp", location });
  window.gtag?.("event", "whatsapp_click", { location });
}

export function trackEvent(name: string, params: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  window.gtag?.("event", name, params);
}

import { MARK, WORDMARK } from "./logo-paths";

/**
 * The UniBee wordmark, traced from the original artwork (never redrawn).
 * Colour follows `currentColor`, so only use it as:
 *   red  (#FF3333) on white:  <Logo className="text-brand" />
 *   white on red / dark:      <Logo className="text-white" />
 */
export function Logo({ className = "", title = "UniBee" }: { className?: string; title?: string }) {
  return (
    <svg viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`} className={className} role="img" aria-label={title} fill="currentColor">
      <path fillRule="evenodd" d={WORDMARK.d} />
    </svg>
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${MARK.w} ${MARK.h}`} className={className} aria-hidden="true" fill="currentColor">
      <path fillRule="evenodd" d={MARK.d} />
    </svg>
  );
}

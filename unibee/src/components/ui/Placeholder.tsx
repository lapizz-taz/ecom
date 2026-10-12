import { site } from "@/content/site";

/** Small amber tag marking content that still needs real information. */
export function Placeholder({ label = "Placeholder", className = "", show = true }: { label?: string; className?: string; show?: boolean }) {
  if (!site.showPlaceholderBadges || !show) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500 bg-amber-50 px-2 py-0.5 align-middle font-mono text-[11px] font-medium tracking-wide text-amber-800 uppercase ${className}`}
      title="Replace this with real content before launch"
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {label}
    </span>
  );
}

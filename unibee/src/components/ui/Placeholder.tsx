import { site } from "@/content/site";

/** Small amber tag marking content that still needs real information. */
export function Placeholder({ label = "Placeholder", className = "", show = true }: { label?: string; className?: string; show?: boolean }) {
  if (!site.showPlaceholderBadges || !show) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 align-middle text-[11px] font-medium tracking-normal text-amber-700 ${className}`}
      data-placeholder=""
      title="Replace this with real content before launch"
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {label}
    </span>
  );
}
